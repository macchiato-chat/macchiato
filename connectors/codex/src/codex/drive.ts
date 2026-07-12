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
  /** sid → 進行中回合。 */
  private readonly active = new Map<string, Turn>();
  /** sid → 排隊的後續 prompt。 */
  private readonly queued = new Map<string, string[]>();
  /** sid → E2E 回合暫存的(已解密)用戶消息。 */
  private readonly pendingUser = new Map<string, string[]>();
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
    this.titled = st.titled;
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
          // 附件:Codex exec 無原生媒體通道 → 圖片/文件降級回執(同 OpenClaw #60);audio 走雲端 STT。
          const atts = Array.isArray(params.attachments) ? (params.attachments as Array<{ id?: string; kind?: string }>) : [];
          for (const a of atts) {
            if (a?.kind === "audio" && a.id) {
              this.linkb.send({ t: "voice_transcript", agentLinkId: this.linkb.agentLinkId, sessionId: sid, attachmentId: a.id, text: "", error: "stt_unavailable" });
            }
          }
          const dropped = atts.filter((a) => a?.kind && a.kind !== "audio").length;
          if (dropped && !this.e2e?.isE2E(sid)) {
            this.emit(sid, "review.summary", { summary: `⚠️ Codex 連接器暫不支持附件——已忽略 ${dropped} 個附件,僅文字送達` });
          }
          if (!text) return;
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
            t.proc.kill("SIGTERM");
            console.log(`· Interrupted turn for ${sid}`);
          }
          return;
        }
        case "session.create": {
          const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
          if (cwd ? this.cwds[sid] !== cwd : this.cwds[sid] !== undefined) {
            if (cwd) this.cwds[sid] = cwd;
            else delete this.cwds[sid];
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

    // exec 級標誌(--json/-s/-C/--skip-git-repo-check)是 `exec` 的選項,必須放在 `resume`
    // 子命令**之前**(codex exec resume 不接這些,實測 2026-07-12)。
    //   codex exec --json --skip-git-repo-check -s <sandbox> -C <cwd> [resume <id>] <prompt>
    const args = ["exec", "--json", "--skip-git-repo-check", "-s", sandboxMode(), "-C", cwd];
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
        } else if (it.type && it.type !== "agent_message") {
          // 工具類 item(file_change / command_execution / …):start/complete 成對
          const id = String(it.id ?? `${it.type}-${turn.toolItems.size}`);
          if (ev.type === "item.started") {
            turn.toolItems.set(id, { name: String(it.type) });
            this.startMsg(sid, turn);
            if (!turn.isE2E) this.emit(sid, "tool.start", { tool_id: id, name: String(it.type) });
          } else {
            const t = turn.toolItems.get(id);
            if (t && !turn.isE2E) {
              this.emit(sid, "tool.complete", {
                tool_id: id,
                name: t.name,
                args: {},
                result: null,
                result_text: String(it.command ?? it.text ?? it.status ?? "").slice(0, 20_000),
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
    const err = code !== 0 && code !== null;
    const status = err ? "error" : "complete";
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

  private loadState(): { map: Record<string, string>; cwds: Record<string, string>; titled: Set<string> } {
    try {
      const p = JSON.parse(readFileSync(mapPath(), "utf8"));
      return { map: p.map ?? {}, cwds: p.cwds ?? {}, titled: new Set<string>(Array.isArray(p.titled) ? p.titled : []) };
    } catch {
      return { map: {}, cwds: {}, titled: new Set() };
    }
  }
  private saveMap(): void {
    try {
      mkdirSync(dirname(mapPath()), { recursive: true });
      const tmp = `${mapPath()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, map: this.map, cwds: this.cwds, titled: [...this.titled] }));
      renameSync(tmp, mapPath());
    } catch (e) {
      console.error("[session map save failed]", (e as Error).message);
    }
  }
}
