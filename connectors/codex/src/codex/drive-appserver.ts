/**
 * #132 v2 Drive:常駐 `codex app-server`(JSON-RPC)驅動——exec v1(drive.ts,保留作 fallback)
 * 拿不到的四能力在此齊活(全部 0.144.1 兩輪探針活測背書):
 *   - token 級 delta:item/agentMessage/delta → message.delta(v1 只有整條 item);
 *   - 遠程審批:item/commandExecution|fileChange/requestApproval 反向 JSON-RPC ↔ Macchiato
 *     審批卡(approval.request/respond,對齊 CC canUseTool 橋;all=true → acceptForSession
 *     用 codex 原生會話級審批緩存);
 *   - mid-turn steer:回合進行中的 prompt → turn/steer{expectedTurnId}(v1 只能排隊);
 *   - 原生圖片:image 附件 → UserInput{type:"localImage", path}(v1 只能路徑注入)。
 * 白嫖:thread/tokenUsage/updated → turn.usage 事件(#141 同款 output tokens 計數)。
 *
 * 事實依據(探針):turn/start 立即返回(turn 在後台跑);turn/completed 的 turn.items 是
 * notLoaded 空數組——最終文本必須從 item/completed(agentMessage)累積;app-server 回合照寫
 * ~/.codex/sessions rollout(鏡像/導入零改動);thread/resume 接受 exec 建的既有 rollout id。
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppServerClient, AppServerDied } from "./appserver";
import { loadDriveState, saveDriveState } from "./state";
import { workDir } from "./drive";
import { generateTitle } from "./titles";
import { materializeAttachment } from "./attachments";
import type { LinkBClient } from "../linkb/client";
import type { E2EKeyStore } from "../e2e/keys";
import type { Mirror } from "./mirror";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 審批策略:untrusted(白名單外全問)/on-request(模型自行請求升權)/never。默認 on-request——
 * 沙箱(workspace-write)兜底安全,審批卡只在越沙箱時彈,手機端不被刷屏。 */
function approvalPolicy(): string {
  const m = process.env.MACCHIATO_CODEX_APPROVAL;
  const ok = ["untrusted", "on-request", "never"];
  if (m && ok.includes(m)) return m;
  if (m) console.error(`[drive2] 忽略非法 MACCHIATO_CODEX_APPROVAL=${m}(${ok.join("/")})`);
  return "on-request";
}
/** 沙箱模式(與 v1 同 env)。 */
function sandboxMode(): string {
  const m = process.env.MACCHIATO_CODEX_SANDBOX;
  const ok = ["read-only", "workspace-write", "danger-full-access"];
  if (m && ok.includes(m)) return m;
  return "workspace-write";
}

/** #153 同款工具卡,v2 item 形狀(camelCase:aggregatedOutput/exitCode;schema 0.144.1)。 */
export function toolCardForV2(it: any): { name: string; args: Record<string, unknown>; resultText: string; error?: string } {
  const type = String(it?.type ?? "tool");
  if (type === "commandExecution") {
    const exit = typeof it.exitCode === "number" ? it.exitCode : undefined;
    return {
      name: "command",
      args: { command: String(it.command ?? "") },
      resultText: String(it.aggregatedOutput ?? ""),
      ...(exit !== undefined && exit !== 0 ? { error: `exit ${exit}` } : {}),
    };
  }
  if (type === "fileChange") {
    return {
      name: "file_change",
      args: { changes: it.changes ?? [] },
      resultText: String(it.status ?? ""),
      ...(String(it.status ?? "") === "failed" ? { error: "failed" } : {}),
    };
  }
  if (type === "mcpToolCall") {
    const server = String(it.server ?? "");
    const tool = String(it.tool ?? "");
    return {
      name: server || tool ? `mcp:${[server, tool].filter(Boolean).join(".")}` : "mcpToolCall",
      args: it.arguments && typeof it.arguments === "object" ? it.arguments : {},
      resultText: String(it.result ?? it.status ?? ""),
      ...(String(it.status ?? "") === "failed" ? { error: "failed" } : {}),
    };
  }
  if (type === "webSearch") {
    return { name: "web_search", args: { query: String(it.query ?? "") }, resultText: String(it.status ?? "") };
  }
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(it ?? {})) {
    if (k === "id" || k === "type") continue;
    args[k] = typeof v === "string" && v.length > 500 ? v.slice(0, 500) + "…" : v;
  }
  return { name: type, args, resultText: String(it.command ?? it.text ?? it.status ?? "") };
}

/** app-server 的 UserInput(schema 0.144.1)。 */
type UserInput =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string };

interface ActiveTurn {
  threadId: string;
  turnId?: string;
  started: boolean; // message.start 已發
  agentText: string;
  /** 當前正在流 delta 的 agentMessage itemId + 已流出長度(item/completed 補尾用)。 */
  deltaItem?: string;
  deltaLen: number;
  reasoningSeen: Set<string>;
  toolItems: Map<string, { name: string }>;
  usage: Record<string, unknown>;
  isE2E: boolean;
  isFirstMacchiatoTurn: boolean;
  lastError?: string;
}

interface PendingApproval {
  sid: string;
  resolve: (decision: string) => void;
}

export class AppServerDrive {
  /** #10:累計計數(與 v1 同鍵位,健康上報帶出)。engineAppServer=1 是引擎標記(v1 無此鍵)。 */
  readonly counters: Record<string, number> = { driveErrors: 0, approvalsRequested: 0, steers: 0, engineAppServer: 1 };
  private map: Record<string, string>;
  private cwds: Record<string, string>;
  private models: Record<string, string>;
  private pending: Set<string>;
  private titled: Set<string>;
  private abandonedTurns: string[] = [];
  private readonly active = new Map<string, ActiveTurn>();
  /** threadId → sid(通知路由)。 */
  private readonly byThread = new Map<string, string>();
  /** 本 app-server 進程裡已 start/resume 過的 thread(重啟後要重新 resume)。 */
  private readonly loadedThreads = new Set<string>();
  /** sid → 掛起中的審批(approval.respond 解掛;FIFO 對齊 CC)。 */
  private readonly approvals = new Map<string, PendingApproval[]>();
  private readonly pendingUser = new Map<string, string[]>();
  private readonly interruptedSids = new Set<string>();

  constructor(
    private readonly client: AppServerClient,
    private readonly linkb: LinkBClient,
    private readonly mirror?: Mirror,
    private readonly e2e?: E2EKeyStore,
  ) {
    const st = loadDriveState();
    this.map = st.map;
    this.cwds = st.cwds;
    this.models = st.models;
    this.titled = st.titled;
    this.abandonedTurns = st.pending;
    this.pending = new Set();
    if (st.pending.length) this.saveMap();

    this.client.onNotification((m, p) => this.onNotification(m, p));
    this.client.onReverseRequest("item/commandExecution/requestApproval", (p) => this.onApprovalRequest(p, "command"));
    this.client.onReverseRequest("item/fileChange/requestApproval", (p) => this.onApprovalRequest(p, "fileChange"));
    // app-server 死了重啟:活躍回合已隨進程死 → 清盤 + 對用戶明說(不靜默吞)。
    this.client.onRestart = () => this.onServerRestart();
  }

  wire(): void {
    this.linkb.onFrame((m) => void this.onServerFrame(m));
  }

  dispose(): void {
    this.client.close();
  }

  /** #200:上個進程死於回合中途 → 提示重發(index.ts 在 ready 後調;冪等)。 */
  flushAbandonedTurns(): void {
    const sids = this.abandonedTurns;
    this.abandonedTurns = [];
    for (const sid of sids) {
      if (this.e2e?.isE2E(sid)) continue;
      this.emit(sid, "review.summary", { summary: "⚠️ 連接器剛重啟,上一條消息可能沒跑完——請重發一次。" });
    }
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
    if (UUID_RE.test(sid)) return sid;
    return this.map[sid];
  }
  private cwdFor(sid: string): string {
    const c = this.cwds[sid];
    if (!c) return workDir();
    if (c === "~") return homedir();
    return c.startsWith("~/") ? join(homedir(), c.slice(2)) : c;
  }
  private modelFor(sid: string): string | undefined {
    return this.models[sid] || process.env.MACCHIATO_CODEX_MODEL || undefined;
  }

  // ============================== 下行(server → 連接器) ==============================

  async onServerFrame(msg: Record<string, unknown>): Promise<void> {
    if (msg.t !== "tui" || !msg.frame) return;
    const frame = msg.frame as { method?: string; params?: Record<string, unknown> };
    const params = frame.params ?? {};
    const sid = (msg.sessionId ?? params.session_id) as string | undefined;
    if (!sid || !frame.method) return;
    try {
      switch (frame.method) {
        case "prompt.submit": {
          await this.onPrompt(sid, params);
          return;
        }
        case "approval.respond": {
          // 審批卡回話 → 解掛反向請求(FIFO,對齊 CC)。allow+all → acceptForSession(codex 原生
          // 會話級審批緩存,同類後續免問);deny → decline(agent 收到拒絕並繼續)。
          const list = this.approvals.get(sid);
          const p = list?.shift();
          if (!list?.length) this.approvals.delete(sid);
          if (!p) return;
          const allow = params.choice === "allow";
          const all = params.all === true;
          p.resolve(allow ? (all ? "acceptForSession" : "accept") : "decline");
          return;
        }
        case "session.interrupt": {
          const t = this.active.get(sid);
          if (t?.turnId) {
            this.interruptedSids.add(sid);
            await this.client.request("turn/interrupt", { threadId: t.threadId, turnId: t.turnId });
            console.log(`· turn/interrupt → ${sid}`);
          }
          return;
        }
        case "session.delete": {
          const tid = this.threadFor(sid);
          if (tid) this.mirror?.tombstone(tid); // #161 墓碑;不刪 rollout
          return;
        }
        case "session.create": {
          const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
          if (cwd ? this.cwds[sid] !== cwd : this.cwds[sid] !== undefined) {
            if (cwd) this.cwds[sid] = cwd;
            else delete this.cwds[sid];
            this.saveMap();
          }
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
      this.counters.driveErrors += 1;
      console.error(`[drive2 ${frame.method} failed for ${sid}] ${(e as Error).message}`);
    }
  }

  private async onPrompt(sid: string, params: Record<string, unknown>): Promise<void> {
    let text = String(params.text ?? "").trim();
    const atts = Array.isArray(params.attachments)
      ? (params.attachments as Array<{ id?: string; kind?: string; name?: string; mime?: string; url?: string }>)
      : [];
    const images: UserInput[] = [];
    const attachNotes: string[] = [];
    for (const a of atts) {
      if (a?.kind === "audio" && a.id) {
        // #73/#89 無本地 STT → 立即回失敗回執(server 雲端 BYOK 回退鏈)。
        this.linkb.send({ t: "voice_transcript", agentLinkId: this.linkb.agentLinkId, sessionId: sid, attachmentId: a.id, text: "", error: "stt_unavailable" });
        continue;
      }
      if (!a?.url) continue;
      try {
        const p = await materializeAttachment(a);
        // #132 原生圖片:image 附件 → localImage UserInput(視覺直達,活測 "Red");其餘照舊路徑注入。
        if (a.kind === "image") images.push({ type: "localImage", path: p });
        else attachNotes.push(`[Macchiato 附件 ${a.name ?? "file"}(${a.mime ?? "?"})已保存到:${p}]`);
      } catch (e) {
        console.error(`[attachment failed for ${sid}] ${(e as Error).message}`);
        if (!this.e2e?.isE2E(sid)) {
          this.emit(sid, "review.summary", { summary: `⚠️ 附件 ${a.name ?? ""} 下載失敗:${(e as Error).message.slice(0, 120)}` });
        }
      }
    }
    if (!text && !attachNotes.length && !images.length) return;
    if (this.e2e?.isE2E(sid)) {
      try {
        text = this.e2e.decryptText(sid, text).trim();
      } catch (e) {
        console.error(`[E2E prompt decrypt failed for ${sid}] ${(e as Error).message}`);
        return;
      }
      if (!text && !images.length) return;
      const arr = this.pendingUser.get(sid) ?? [];
      arr.push(text);
      this.pendingUser.set(sid, arr);
    }
    if (attachNotes.length) text = [text, ...attachNotes].filter(Boolean).join("\n\n");
    const input: UserInput[] = [...(text ? [{ type: "text", text } as UserInput] : []), ...images];

    // #132 mid-turn steer:回合進行中 → turn/steer 注入(expectedTurnId 防競態);
    // steer 失敗(回合恰好剛結束/turnId 不匹配)→ 回退起新回合,消息絕不丟。
    const running = this.active.get(sid);
    if (running?.turnId) {
      try {
        await this.client.request("turn/steer", { threadId: running.threadId, expectedTurnId: running.turnId, input });
        this.counters.steers += 1;
        console.log(`· turn/steer 注入跟進消息 → ${sid}`);
        return;
      } catch (e) {
        console.log(`· steer 未命中(${(e as Error).message.slice(0, 120)})→ 起新回合`);
      }
    }
    await this.runTurn(sid, input, text);
  }

  private async runTurn(sid: string, input: UserInput[], firstText: string): Promise<void> {
    const isE2E = this.e2e?.isE2E(sid) ?? false;
    const cwd = this.cwdFor(sid);
    if (!isDir(cwd)) {
      const err = `⚠️ 工作目錄不存在或不是目錄:${cwd}(連接器主機上)。請修正會話目錄後重發。`;
      if (isE2E) this.sendE2ETurn(sid, err);
      else this.emit(sid, "review.summary", { summary: err });
      return;
    }
    let threadId = this.threadFor(sid);
    const isFirstMacchiatoTurn = !threadId && !UUID_RE.test(sid) && !isE2E;
    if (isFirstMacchiatoTurn && !this.titled.has(sid) && firstText) void this.maybeTitle(sid, firstText);
    try {
      if (threadId && !this.loadedThreads.has(threadId)) {
        await this.client.request("thread/resume", { threadId, cwd, approvalPolicy: approvalPolicy(), sandbox: sandboxMode() });
        this.loadedThreads.add(threadId);
      } else if (!threadId) {
        const ts = await this.client.request("thread/start", { cwd, approvalPolicy: approvalPolicy(), sandbox: sandboxMode() });
        threadId = String(ts?.thread?.id ?? "");
        if (!threadId) throw new Error("thread/start 未返回 thread.id");
        this.loadedThreads.add(threadId);
        if (!UUID_RE.test(sid)) {
          this.map[sid] = threadId;
          this.saveMap();
        }
      }
      this.byThread.set(threadId, sid);
      this.mirror?.setDriven(threadId); // live 獨佔投遞
      const turn: ActiveTurn = {
        threadId,
        started: false,
        agentText: "",
        deltaLen: 0,
        reasoningSeen: new Set(),
        toolItems: new Map(),
        usage: {},
        isE2E,
        isFirstMacchiatoTurn,
      };
      this.active.set(sid, turn);
      this.pending.add(sid); // #200
      this.saveMap();
      const model = this.modelFor(sid);
      const res = await this.client.request("turn/start", { threadId, input, ...(model ? { model } : {}) });
      // turn/start 立即返回(探針);turnId 也會隨 turn/started 通知到,這裡先記省一拍。
      if (res?.turn?.id) turn.turnId = String(res.turn.id);
    } catch (e) {
      this.active.delete(sid);
      this.pending.delete(sid);
      this.saveMap();
      const msg = e instanceof AppServerDied ? "codex app-server 不可用(重啟中),請稍後重發" : (e as Error).message.slice(0, 200);
      if (isE2E) this.sendE2ETurn(sid, `❌ 回合啟動失敗:${msg}`);
      else this.emit(sid, "review.summary", { summary: `❌ 回合啟動失敗:${msg}` });
      this.counters.driveErrors += 1;
    }
  }

  // ============================== 上行(app-server 通知 → server) ==============================

  private onNotification(method: string, p: any): void {
    const threadId = String(p?.threadId ?? "");
    const sid = threadId ? this.byThread.get(threadId) : undefined;
    if (!sid) return;
    const turn = this.active.get(sid);
    switch (method) {
      case "turn/started": {
        if (turn && !turn.turnId) turn.turnId = String(p.turn?.id ?? "");
        return;
      }
      case "item/agentMessage/delta": {
        if (!turn) return;
        const itemId = String(p.itemId ?? "");
        const delta = String(p.delta ?? "");
        if (!delta) return;
        this.startMsg(sid, turn);
        // 換 agentMessage item(commentary → final_answer)→ 段落分隔,對齊 v1 的 "\n\n" join。
        if (turn.deltaItem && turn.deltaItem !== itemId && turn.agentText) {
          turn.agentText += "\n\n";
          if (!turn.isE2E) this.emit(sid, "message.delta", { text: "\n\n" });
        }
        if (turn.deltaItem !== itemId) {
          turn.deltaItem = itemId;
          turn.deltaLen = 0;
        }
        turn.agentText += delta;
        turn.deltaLen += delta.length;
        if (!turn.isE2E) this.emit(sid, "message.delta", { text: delta });
        return;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        if (!turn || turn.isE2E) return;
        const delta = String(p.delta ?? "");
        if (!delta) return;
        this.startMsg(sid, turn);
        turn.reasoningSeen.add(String(p.itemId ?? ""));
        this.emit(sid, "reasoning.delta", { text: delta });
        return;
      }
      case "item/started":
      case "item/completed": {
        if (!turn) return;
        this.onItem(sid, turn, method === "item/completed", p.item ?? {});
        return;
      }
      case "thread/tokenUsage/updated": {
        // #141 同款回合 token 計數 + 定稿 usage(turn/completed 不帶 usage,靠這裡最後一拍)。
        const last = p.tokenUsage?.last ?? {};
        if (turn) {
          turn.usage = {
            input_tokens: last.inputTokens,
            output_tokens: last.outputTokens,
            cached_input_tokens: last.cachedInputTokens,
            reasoning_output_tokens: last.reasoningOutputTokens,
          };
          if (!turn.isE2E && typeof last.outputTokens === "number") {
            this.emit(sid, "turn.usage", { output_tokens: last.outputTokens });
          }
        }
        return;
      }
      case "error": {
        if (turn) turn.lastError = String(p.message ?? "");
        return;
      }
      case "turn/completed": {
        if (!turn) return;
        this.finishTurn(sid, turn, p.turn ?? {});
        return;
      }
      default:
        return;
    }
  }

  private onItem(sid: string, turn: ActiveTurn, completed: boolean, it: any): void {
    const type = String(it?.type ?? "");
    if (type === "agentMessage") {
      if (!completed) return;
      const text = String(it.text ?? "");
      // delta 已流出的部分不重發;斷流(通知丟失)時補尾,保定稿完整。
      if (String(it.id ?? "") === turn.deltaItem) {
        const missing = text.slice(turn.deltaLen);
        if (missing) {
          turn.agentText += missing;
          if (!turn.isE2E) this.emit(sid, "message.delta", { text: missing });
        }
        turn.deltaLen = text.length;
      } else if (text) {
        this.startMsg(sid, turn);
        const chunk = turn.agentText ? "\n\n" + text : text;
        turn.agentText += chunk;
        if (!turn.isE2E) this.emit(sid, "message.delta", { text: chunk });
      }
      return;
    }
    if (type === "reasoning") {
      // 思考正文走 textDelta 流;沒流過的(只有 summary 定稿)補整條。
      if (!completed || turn.isE2E) return;
      if (turn.reasoningSeen.has(String(it.id ?? ""))) return;
      const parts = [...(Array.isArray(it.summary) ? it.summary : []), ...(Array.isArray(it.content) ? it.content : [])];
      const rtext = parts
        .map((s: any) => (typeof s === "string" ? s : String(s?.text ?? "")))
        .filter(Boolean)
        .join("\n");
      if (rtext) {
        this.startMsg(sid, turn);
        this.emit(sid, "reasoning.delta", { text: rtext });
      }
      return;
    }
    if (type === "userMessage" || type === "") return; // 自己的輸入回顯,不投
    // 工具類 item(commandExecution/fileChange/mcpToolCall/webSearch/未知)。
    const id = String(it.id ?? `${type}-${turn.toolItems.size}`);
    const card = toolCardForV2(it);
    if (!completed) {
      turn.toolItems.set(id, { name: card.name });
      this.startMsg(sid, turn);
      if (!turn.isE2E) this.emit(sid, "tool.start", { tool_id: id, name: card.name });
    } else if (turn.toolItems.has(id) && !turn.isE2E) {
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

  private startMsg(sid: string, turn: ActiveTurn): void {
    if (turn.started || turn.isE2E) return;
    turn.started = true;
    this.emit(sid, "message.start", {});
  }

  private finishTurn(sid: string, turn: ActiveTurn, turnObj: any): void {
    this.active.delete(sid);
    this.pending.delete(sid);
    this.saveMap();
    // 懸空審批(回合結束仍沒人回)→ decline 收尾,別讓反向請求永久掛起。
    for (const p of this.approvals.get(sid) ?? []) p.resolve("decline");
    this.approvals.delete(sid);
    const interrupted = this.interruptedSids.delete(sid);
    const st = String(turnObj.status ?? "completed"); // TurnStatus: completed/interrupted/failed/inProgress
    const status = st === "failed" ? "error" : st === "interrupted" || interrupted ? "interrupted" : "complete";
    const errMsg = turnObj.error?.message ?? turn.lastError;
    if (turn.isE2E) {
      this.sendE2ETurn(sid, turn.agentText);
    } else {
      if (status === "error" && !turn.agentText) {
        this.emit(sid, "review.summary", { summary: `❌ 回合失敗:${String(errMsg ?? "unknown").slice(0, 200)}` });
      }
      this.startMsg(sid, turn);
      this.emit(sid, "message.complete", { text: turn.agentText, status, usage: turn.usage });
    }
    this.mirror?.fastForward(turn.threadId);
    this.mirror?.unsetDriven(turn.threadId);
  }

  // ============================== 審批橋 ==============================

  /** 反向請求 → approval.request 卡(payload 對齊 CC 的形狀);掛起等 approval.respond。 */
  private onApprovalRequest(p: any, kind: "command" | "fileChange"): Promise<Record<string, unknown>> {
    const sid = this.byThread.get(String(p?.threadId ?? ""));
    if (!sid) return Promise.resolve({ decision: "decline" }); // 不認識的 thread(不該發生)
    this.counters.approvalsRequested += 1;
    const command =
      kind === "command"
        ? String(p.command ?? "")
        : `修改文件:${(Array.isArray(p.changes) ? p.changes : []).map((c: any) => String(c?.path ?? "")).filter(Boolean).join(", ").slice(0, 300) || "(見詳情)"}`;
    const reason = p.reason ? String(p.reason) : "";
    this.emit(sid, "approval.request", {
      command: command.slice(0, 500),
      pattern_key: kind === "command" ? "shell" : "fileChange",
      pattern_keys: [kind === "command" ? "shell" : "fileChange"],
      description: reason || (kind === "command" ? `Codex 想在 ${String(p.cwd ?? "")} 執行命令` : "Codex 想寫入以上文件"),
      ...(p.itemId ? { request_id: String(p.itemId) } : {}),
    });
    return new Promise((resolve) => {
      const list = this.approvals.get(sid) ?? [];
      list.push({ sid, resolve: (decision) => resolve({ decision }) });
      this.approvals.set(sid, list);
    });
  }

  // ============================== 其餘(與 v1 對齊) ==============================

  /** app-server 重啟:活躍回合已死 → 定稿 interrupted + 提示重發;thread 需重新 resume。 */
  private onServerRestart(): void {
    this.loadedThreads.clear();
    for (const [sid, turn] of [...this.active]) {
      this.active.delete(sid);
      this.pending.delete(sid);
      for (const p of this.approvals.get(sid) ?? []) p.resolve("decline");
      this.approvals.delete(sid);
      if (turn.isE2E) {
        this.sendE2ETurn(sid, turn.agentText);
      } else {
        this.startMsg(sid, turn);
        this.emit(sid, "message.complete", { text: turn.agentText, status: "interrupted", usage: turn.usage });
        this.emit(sid, "review.summary", { summary: "⚠️ codex app-server 重啟,這一回合被打斷——請重發一次。" });
      }
      this.mirror?.unsetDriven(turn.threadId);
    }
    this.saveMap();
  }

  private async maybeTitle(sid: string, firstUserText: string): Promise<void> {
    try {
      this.titled.add(sid);
      this.saveMap();
      const title = await generateTitle(firstUserText);
      if (!title) return;
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

  private saveMap(): void {
    saveDriveState({ map: this.map, cwds: this.cwds, models: this.models, titled: this.titled, pending: this.pending });
  }
}
