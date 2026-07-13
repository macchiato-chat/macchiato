/**
 * Drive:Macchiato → Codex 的雙向橋(spawn `codex exec --json` 每回合;JSONL stdout → tui 事件)。
 *
 * 下行(server → 連接器, t:"tui" 幀):
 *   prompt.submit     → spawn codex exec(首回合)/ codex exec resume <thread>(續聊);
 *                       回合進行中 → 排隊,回合結束續投(SDK 無 mid-turn steer;v1 同 CC 早期)
 *   session.interrupt → kill 子進程(exec 無 turn/interrupt RPC;app-server 才有 → v2)
 *   session.create    → 登記 cwd(會話本體由首回合建)
 * 上行(codex exec JSONL → server tui EVENT):
 *   thread.started {thread_id}          → 存映射(Macchiato ULID sid ↔ codex thread uuid)
 *   item.completed agent_message        → message.delta(整條)+ 末尾 message.complete
 *   item.started/completed 工具類        → tool.start / tool.complete
 *   turn.completed {usage}              → message.complete{status, usage}(#102 花費)
 *
 * 會話映射:鏡像來的 sid = codex thread uuid → 直接 resume;Macchiato 新建(ULID sid)首回合
 * 拿 thread_id 後持久映射(~/.macchiato/codex-sessions.json)。無映射則重啟後續聊丟上下文。
 *
 * 沙箱:非交互驅動需不卡審批。默認 workspace-write(可 env 調);danger-full-access 需顯式開。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveCodexBin } from "./codex-bin";
import { generateTitle } from "./titles";
import { materializeAttachment } from "./attachments";
import type { LinkBClient } from "../linkb/client";
import type { E2EKeyStore } from "../e2e/keys";
import type { Mirror } from "./mirror";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function mapPath(): string {
  return process.env.MACCHIATO_CODEX_SESSIONS || join(homedir(), ".macchiato/codex-sessions.json");
}
export function workDir(): string {
  return process.env.MACCHIATO_CODEX_WORKDIR || homedir();
}
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
/** 沙箱模式:read-only / workspace-write / danger-full-access。默認 workspace-write。 */
function sandboxMode(): string {
  const m = process.env.MACCHIATO_CODEX_SANDBOX;
  const ok = ["read-only", "workspace-write", "danger-full-access"];
  if (m && ok.includes(m)) return m;
  if (m) console.error(`[drive] 忽略非法 MACCHIATO_CODEX_SANDBOX=${m}(${ok.join("/")})`);
  return "workspace-write";
}

/**
 * #153 工具卡取實料(活測 2026-07-14 形狀:command_execution 帶 command/aggregated_output/exit_code/status)。
 * 按 item 子類型填 args/result/error;未知類型回退整個 item(去大字段)——別再恆 {}。
 */
export function toolCardFor(it: any): { name: string; args: Record<string, unknown>; resultText: string; error?: string } {
  const type = String(it?.type ?? "tool");
  if (type === "command_execution") {
    const exit = typeof it.exit_code === "number" ? it.exit_code : undefined;
    return {
      name: "command",
      args: { command: String(it.command ?? "") },
      resultText: String(it.aggregated_output ?? ""),
      ...(exit !== undefined && exit !== 0 ? { error: `exit ${exit}` } : {}),
    };
  }
  if (type === "file_change") {
    return {
      name: "file_change",
      args: { changes: it.changes ?? it.files ?? [] },
      resultText: String(it.status ?? ""),
      ...(String(it.status ?? "") === "failed" ? { error: "failed" } : {}),
    };
  }
  if (type === "mcp_tool_call") {
    const server = String(it.server ?? "");
    const tool = String(it.tool ?? "");
    return {
      name: server || tool ? `mcp:${[server, tool].filter(Boolean).join(".")}` : "mcp_tool_call",
      args: it.arguments && typeof it.arguments === "object" ? it.arguments : {},
      resultText: String(it.result ?? it.status ?? ""),
      ...(String(it.status ?? "") === "failed" ? { error: "failed" } : {}),
    };
  }
  if (type === "web_search") {
    return { name: "web_search", args: { query: String(it.query ?? "") }, resultText: String(it.status ?? "") };
  }
  // 未知類型:整個 item 去掉 id/type 與超長字段當 args——保住信息量。
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(it ?? {})) {
    if (k === "id" || k === "type") continue;
    args[k] = typeof v === "string" && v.length > 500 ? v.slice(0, 500) + "…" : v;
  }
  return { name: type, args, resultText: String(it.command ?? it.text ?? it.status ?? "") };
}

interface Turn {
  proc: ChildProcess;
  stdoutBuf: string;
  agentText: string; // 累積 agent 文本(complete 定稿)
  started: boolean;
  completed: boolean;
  usage: Record<string, unknown>;
  isE2E: boolean;
  isFirstMacchiatoTurn: boolean;
  toolItems: Map<string, { name: string }>;
}

export class Drive {
  /** #10:累計計數(進程生命週期),健康上報帶出。 */
  readonly counters: Record<string, number> = { driveErrors: 0 };
  /** serverSid → codex thread uuid(跨重啟持久)。 */
  private map: Record<string, string>;
  /** serverSid → 會話工作目錄。 */
  private cwds: Record<string, string>;
  /** #143 serverSid → 會話 model(session.create.model 下發;持久,同文件存)。 */
  private models: Record<string, string>;
  /** #200 在途回合 sid 集(持久):回合起加、止刪;進程死於回合中途 → 下次啟動提示重發。 */
  private pending: Set<string>;
  /** #200 上個進程死時遺留的在途回合(構造載入即清盤;flushAbandonedTurns 在 ready 後告知)。 */
  private abandonedTurns: string[] = [];
  /** sid → 進行中回合。 */
  private readonly active = new Map<string, Turn>();
  /** sid → 排隊的後續 prompt。 */
  private readonly queued = new Map<string, string[]>();
  /** sid → E2E 回合暫存的(已解密)用戶消息。 */
  private readonly pendingUser = new Map<string, string[]>();
  /** #145 sid → 本回合被 session.interrupt 中斷(result 定性 interrupted 而非 complete)。 */
  private readonly interruptedSids = new Set<string>();
  /** #113 已生成標題的 sid(持久)。 */
  private titled: Set<string>;
  private genTitle: string | undefined;

  constructor(
    private readonly linkb: LinkBClient,
    private readonly mirror?: Mirror,
    private readonly e2e?: E2EKeyStore,
  ) {
    const st = this.loadState();
    this.map = st.map;
    this.cwds = st.cwds;
    this.models = st.models;
    this.titled = st.titled;
    this.abandonedTurns = st.pending;
    this.pending = new Set();
    if (st.pending.length) this.saveMap();
  }

  /** #200:對上個進程死時被殺的在途回合回 system 提示(Link B ready 後由 index.ts 調;冪等)。 */
  flushAbandonedTurns(): void {
    const sids = this.abandonedTurns;
    this.abandonedTurns = [];
    for (const sid of sids) {
      if (this.e2e?.isE2E(sid)) continue;
      this.emit(sid, "review.summary", { summary: "⚠️ 連接器剛重啟,上一條消息可能沒跑完——請重發一次。" });
    }
  }

  /**
   * #143 該會話當前 model:per-session 選擇優先,回退 env `MACCHIATO_CODEX_MODEL`,都無 →
   * undefined(不傳 -m,用 codex 自身配置默認)。絕不 hardcode(鐵律)——只透傳用戶所選。
   */
  private modelFor(sid: string): string | undefined {
    return this.models[sid] || process.env.MACCHIATO_CODEX_MODEL || undefined;
  }

  wire(): void {
    this.linkb.onFrame((m) => void this.onServerFrame(m));
  }

  dispose(): void {
    for (const t of this.active.values()) t.proc.kill("SIGTERM");
  }

  private emit(sid: string, type: string, payload: Record<string, unknown>): void {
    this.linkb.send({
      t: "tui",
      agentLinkId: this.linkb.agentLinkId,
      sessionId: sid,
      frame: { jsonrpc: "2.0", method: "event", params: { type, session_id: sid, payload } },
    });
  }

  private threadFor(sid: string): string | undefined {
    if (UUID_RE.test(sid)) return sid; // 鏡像會話:sid 即 codex thread id
    return this.map[sid];
  }

  private cwdFor(sid: string): string {
    const c = this.cwds[sid];
    if (!c) return workDir();
    if (c === "~") return homedir();
    return c.startsWith("~/") ? join(homedir(), c.slice(2)) : c;
  }

  async onServerFrame(msg: Record<string, unknown>): Promise<void> {
    if (msg.t !== "tui" || !msg.frame) return;
    const frame = msg.frame as { method?: string; params?: Record<string, unknown> };
    const params = frame.params ?? {};
    const sid = (msg.sessionId ?? params.session_id) as string | undefined;
    if (!sid || !frame.method) return;
    try {
      switch (frame.method) {
        case "prompt.submit": {
          let text = String(params.text ?? "").trim();
          // #146 附件:codex exec 無原生媒體通道 → 「落盤 + 路徑注入 prompt」讓 codex 用讀檔工具訪問
          // (SSRF 防護/100MB 上限見 attachments.ts,移植自 CC);audio 走雲端 STT 回退鏈。
          const atts = Array.isArray(params.attachments)
            ? (params.attachments as Array<{ id?: string; kind?: string; name?: string; mime?: string; url?: string }>)
            : [];
          const attachNotes: string[] = [];
          for (const a of atts) {
            if (a?.kind === "audio" && a.id) {
              this.linkb.send({ t: "voice_transcript", agentLinkId: this.linkb.agentLinkId, sessionId: sid, attachmentId: a.id, text: "", error: "stt_unavailable" });
              continue;
            }
            if (!a?.url) continue;
            try {
              const p = await materializeAttachment(a);
              attachNotes.push(`[Macchiato 附件 ${a.name ?? "file"}(${a.mime ?? "?"})已保存到:${p}]`);
            } catch (e) {
              console.error(`[attachment failed for ${sid}] ${(e as Error).message}`);
              if (!this.e2e?.isE2E(sid)) {
                this.emit(sid, "review.summary", { summary: `⚠️ 附件 ${a.name ?? ""} 下載失敗:${(e as Error).message.slice(0, 120)}` });
              }
            }
          }
          if (!text && !attachNotes.length) return;
          if (this.e2e?.isE2E(sid)) {
            try {
              text = this.e2e.decryptText(sid, text).trim();
            } catch (e) {
              console.error(`[E2E prompt decrypt failed for ${sid}] ${(e as Error).message}`);
              return;
            }
            if (!text) return;
            const arr = this.pendingUser.get(sid) ?? [];
            arr.push(text);
            this.pendingUser.set(sid, arr);
          }
          if (attachNotes.length) text = [text, ...attachNotes].filter(Boolean).join("\n\n"); // #146 路徑注入
          if (this.active.has(sid)) {
            const q = this.queued.get(sid) ?? [];
            q.push(text);
            this.queued.set(sid, q);
            console.log(`· Turn in progress → queued follow-up for ${sid}`);
            return;
          }
          this.runTurn(sid, text);
          return;
        }
        case "session.interrupt": {
          const t = this.active.get(sid);
          if (t) {
            this.interruptedSids.add(sid); // #145 隨後的 close 定性 interrupted,不再冒充「正常完成」
            t.proc.kill("SIGTERM");
            console.log(`· Interrupted turn for ${sid}`);
          }
          // #145 停止 = 全停:排隊的後續 prompt 一併作廢(否則停完馬上又起一回合,違反預期)。
          this.queued.delete(sid);
          return;
        }
        case "session.delete": {
          // #161 墓碑:app 刪會話 → 鏡像永不再撈;不刪 rollout(app 是遙控器)。
          const tid = this.threadFor(sid);
          if (tid) this.mirror?.tombstone(tid);
          return;
        }
        case "session.create": {
          const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
          if (cwd ? this.cwds[sid] !== cwd : this.cwds[sid] !== undefined) {
            if (cwd) this.cwds[sid] = cwd;
            else delete this.cwds[sid];
            this.saveMap();
          }
          // #143 model(upsert;隨時可改)。空 = 清回連接器默認(env / codex 配置)。自由字符串,只透傳。
          const md = typeof params.model === "string" ? params.model.trim() : "";
          if (md ? this.models[sid] !== md : this.models[sid] !== undefined) {
            if (md) this.models[sid] = md;
            else delete this.models[sid];
            this.saveMap();
          }
          if (cwd && !this.e2e?.isE2E(sid) && !isDir(this.cwdFor(sid))) {
            this.emit(sid, "review.summary", { summary: `⚠️ 工作目錄不存在或不是目錄:${this.cwdFor(sid)}(連接器主機上)` });
          }
          return;
        }
        default:
          return;
      }
    } catch (e) {
      this.counters.driveErrors += 1; // #10
      console.error(`[drive ${frame.method} failed for ${sid}] ${(e as Error).message}`);
    }
  }

  private runTurn(sid: string, text: string): void {
    const isE2E = this.e2e?.isE2E(sid) ?? false;
    const cwd = this.cwdFor(sid);
    if (!isDir(cwd)) {
      const err = `⚠️ 工作目錄不存在或不是目錄:${cwd}(連接器主機上)。請修正會話目錄後重發。`;
      if (isE2E) this.sendE2ETurn(sid, err);
      else this.emit(sid, "review.summary", { summary: err });
      return;
    }
    const resume = this.threadFor(sid);
    const isFirstMacchiatoTurn = !resume && !UUID_RE.test(sid) && !isE2E;
    if (isFirstMacchiatoTurn && !this.titled.has(sid)) void this.maybeTitle(sid, text);

    // exec 級標誌(--json/-s/-C/--skip-git-repo-check/-m)是 `exec` 的選項,必須放在 `resume`
    // 子命令**之前**(codex exec resume 不接這些,實測 2026-07-12)。
    //   codex exec --json --skip-git-repo-check -s <sandbox> -C <cwd> [-m <model>] [resume <id>] <prompt>
    const args = ["exec", "--json", "--skip-git-repo-check", "-s", sandboxMode(), "-C", cwd];
    // #143 per-session model(空 = 不傳 -m,用 codex 自身配置默認;絕不 hardcode)。放 resume 之前。
    const model = this.modelFor(sid);
    if (model) args.push("-m", model);
    if (resume) args.push("resume", resume);
    args.push(text);
    const proc = spawn(resolveCodexBin(), args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    const turn: Turn = {
      proc,
      stdoutBuf: "",
      agentText: "",
      started: false,
      completed: false,
      usage: {},
      isE2E,
      isFirstMacchiatoTurn,
      toolItems: new Map(),
    };
    this.active.set(sid, turn);
    this.pending.add(sid); // #200
    this.saveMap();

    proc.stdout!.on("data", (chunk: Buffer) => {
      turn.stdoutBuf += chunk.toString("utf8");
      let nl: number;
      while ((nl = turn.stdoutBuf.indexOf("\n")) >= 0) {
        const line = turn.stdoutBuf.slice(0, nl).trim();
        turn.stdoutBuf = turn.stdoutBuf.slice(nl + 1);
        if (line) this.handleEvent(sid, turn, line);
      }
    });
    let stderr = "";
    proc.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    proc.on("close", (code) => this.finishTurn(sid, turn, code, stderr));
    proc.on("error", (e) => this.finishTurn(sid, turn, -1, e.message));
  }

  private startMsg(sid: string, turn: Turn): void {
    if (turn.started || turn.isE2E) return;
    turn.started = true;
    this.emit(sid, "message.start", {});
  }

  private handleEvent(sid: string, turn: Turn, line: string): void {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return; // 非 JSON 行(如 "Reading additional input…")跳過
    }
    switch (ev.type) {
      case "thread.started": {
        const tid = String(ev.thread_id ?? "");
        if (tid && !this.map[sid] && !UUID_RE.test(sid)) {
          this.map[sid] = tid;
          this.saveMap();
          this.mirror?.setDriven(tid); // live 獨佔投遞
        } else if (tid && UUID_RE.test(sid)) {
          this.mirror?.setDriven(tid);
        }
        return;
      }
      case "item.started":
      case "item.completed": {
        const it = ev.item ?? {};
        if (it.type === "agent_message") {
          if (ev.type === "item.completed" && typeof it.text === "string" && it.text) {
            this.startMsg(sid, turn);
            const chunk = turn.agentText ? "\n\n" + it.text : it.text;
            turn.agentText += (turn.agentText ? "\n\n" : "") + it.text;
            if (!turn.isE2E) this.emit(sid, "message.delta", { text: chunk });
          }
        } else if (it.type === "reasoning") {
          // #153 思考完成項透出(token-delta 要 app-server v2 → #132;完成項現在就能給)。
          const rtext = String(it.text ?? it.summary ?? "");
          if (ev.type === "item.completed" && rtext && !turn.isE2E) {
            this.startMsg(sid, turn);
            this.emit(sid, "reasoning.delta", { text: rtext });
          }
        } else if (it.type && it.type !== "agent_message") {
          // #153 工具類 item:按子類型取實料(args 不再恆 {};exit_code≠0/failed 標 error)。
          const id = String(it.id ?? `${it.type}-${turn.toolItems.size}`);
          const card = toolCardFor(it);
          if (ev.type === "item.started") {
            turn.toolItems.set(id, { name: card.name });
            this.startMsg(sid, turn);
            if (!turn.isE2E) this.emit(sid, "tool.start", { tool_id: id, name: card.name });
          } else {
            const t = turn.toolItems.get(id);
            if (t && !turn.isE2E) {
              this.emit(sid, "tool.complete", {
                tool_id: id,
                name: card.name,
                args: card.args,
                result: null,
                result_text: card.resultText.slice(0, 20_000),
                ...(card.error ? { error: card.error } : {}),
              });
            }
          }
        }
        return;
      }
      case "turn.completed":
        if (ev.usage && typeof ev.usage === "object") {
          const u = ev.usage;
          turn.usage = {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cached_input_tokens: u.cached_input_tokens,
            reasoning_output_tokens: u.reasoning_output_tokens,
          };
        }
        return;
      case "turn.failed":
      case "error":
        turn.usage.error = String(ev.message ?? ev.error ?? "turn failed");
        return;
      default:
        return; // thread.resumed / turn.started 等:忽略
    }
  }

  private finishTurn(sid: string, turn: Turn, code: number | null, stderr: string): void {
    if (turn.completed) return;
    turn.completed = true;
    this.active.delete(sid);
    this.pending.delete(sid); // #200
    this.saveMap();
    const interrupted = this.interruptedSids.delete(sid);
    // #145:code===null = 被信號殺(用戶中斷 / 外部 kill 如 earlyoom)→ interrupted,不冒充 complete。
    const err = code !== 0 && code !== null;
    const status = err ? "error" : interrupted || code === null ? "interrupted" : "complete";
    const finalText = turn.agentText;
    if (turn.isE2E) {
      this.sendE2ETurn(sid, finalText);
    } else {
      if (err && !finalText) {
        this.emit(sid, "review.summary", { summary: `❌ 回合失敗(codex exit ${code}${stderr ? ": " + stderr.slice(0, 200) : ""})` });
      }
      this.startMsg(sid, turn);
      this.emit(sid, "message.complete", { text: finalText, status, usage: turn.usage });
    }
    const tid = this.threadFor(sid);
    if (tid) {
      this.mirror?.fastForward(tid);
      this.mirror?.unsetDriven(tid);
    }
    if (turn.isFirstMacchiatoTurn && this.genTitle) this.genTitle = undefined;
    const next = this.queued.get(sid)?.shift();
    if (!this.queued.get(sid)?.length) this.queued.delete(sid);
    if (next !== undefined) this.runTurn(sid, next);
  }

  private async maybeTitle(sid: string, firstUserText: string): Promise<void> {
    try {
      this.titled.add(sid);
      this.saveMap();
      const title = await generateTitle(firstUserText);
      if (!title) return;
      this.genTitle = title;
      this.emit(sid, "session.title", { title });
      console.log(`· 生成標題「${title}」→ ${sid}`);
    } catch (e) {
      console.error(`[title gen failed for ${sid}] ${(e as Error).message}`);
    }
  }

  private sendE2ETurn(sid: string, reply: string): void {
    if (!this.e2e) return;
    const msgs: Record<string, unknown>[] = (this.pendingUser.get(sid) ?? []).map((t) => ({ role: "user", enc: this.e2e!.encryptContent(sid, { text: t }) }));
    this.pendingUser.delete(sid);
    if (reply.trim()) msgs.push({ role: "agent", enc: this.e2e.encryptContent(sid, { text: reply }) });
    if (!msgs.length) return;
    this.linkb.send({ t: "mirror_append", agentLinkId: this.linkb.agentLinkId, sessions: [{ hermesSessionId: sid, source: "codex", e2e: true, messages: msgs }] });
  }

  private loadState(): {
    map: Record<string, string>;
    cwds: Record<string, string>;
    models: Record<string, string>;
    titled: Set<string>;
    pending: string[];
  } {
    try {
      const p = JSON.parse(readFileSync(mapPath(), "utf8"));
      return {
        map: p.map ?? {},
        cwds: p.cwds ?? {},
        models: p.models ?? {}, // #143
        titled: new Set<string>(Array.isArray(p.titled) ? p.titled : []),
        pending: Array.isArray(p.pending) ? (p.pending as string[]) : [], // #200
      };
    } catch {
      return { map: {}, cwds: {}, models: {}, titled: new Set(), pending: [] };
    }
  }
  private saveMap(): void {
    try {
      mkdirSync(dirname(mapPath()), { recursive: true });
      const tmp = `${mapPath()}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ v: 1, map: this.map, cwds: this.cwds, models: this.models, titled: [...this.titled], pending: [...this.pending] }),
      );
      renameSync(tmp, mapPath());
    } catch (e) {
      console.error("[session map save failed]", (e as Error).message);
    }
  }
}
