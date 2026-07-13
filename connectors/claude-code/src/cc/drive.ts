/**
 * Drive：Macchiato → Claude Code 的雙向橋（經官方 Agent SDK）。
 *
 * #118 起為 streaming-input 架構：每個活躍會話一條**長活通道**（`query({prompt: PushStream})`），
 * 後續 prompt 直接 push（不再每回合新起 query/CLI 進程）。要點（全部有 #116 探針背書）：
 *   - 閒置回收：回合結束後 MACCHIATO_CC_IDLE_S（默認 600s）無活動 → close() 回收 CLI（~257MB RSS/會話）；
 *     下個 prompt 用 resume 重建，上下文零丟失。
 *   - 送達確認：push 後 CLI 未及處理即死（毫秒級窗口）→ 自動重投一次（新通道 resume）；
 *     已見事件的回合崩潰 → 定稿 error（user 消息已落 transcript，不重投防雙投）。
 *   - interrupt() 不殺通道（探針 g）：result(error_during_execution) 到、同通道下一回合照常。
 *   - 每回合一個 system/init（streaming 模式特性），據此 setDriven/存映射。
 *
 * 下行（server → 連接器, t:"tui" 幀）：
 *   prompt.submit     → 通道 push 一回合；回合進行中 → steer(#75:打斷當前回合+新消息接管)
 *   session.interrupt → channel.q.interrupt()
 *   session.create    → 登記（首次 prompt 才真建 CC 會話, init 事件回 session_id）；cwd 變更 → 閒置通道重建
 *   approval.respond  → 解掛 canUseTool（request_id 精準配對,缺省 FIFO）
 * 上行（SDK 流式事件 → server tui EVENT）：
 *   stream_event content_block_delta text_delta     → message.delta（token 級）
 *   stream_event content_block_delta thinking_delta  → reasoning.delta
 *   stream_event content_block_start tool_use        → tool.start
 *   user 消息裡的 tool_result                         → tool.complete
 *   result                                            → message.complete{status,usage} + 鏡像快進（防雙投）
 *   canUseTool 回調                                   → approval.request{request_id}（掛起直到用戶批/拒）
 *   system compact_boundary/status/api_retry/permission_denied → review.summary 系統行（#102）
 *   其餘 SDKMessage（37 種 union 的長尾）              → 一次性 debug log（#102 兜底,防升級漂移無感知）
 *
 * 會話映射：鏡像來的 sid 本身就是 CC session uuid → 直接 resume；Macchiato 新建會話（ULID sid）
 * 首回合 init 拿到 CC session_id 後持久映射（~/.macchiato/claude-code-sessions.json，原子寫）——
 * 沒有這個映射，重啟後續聊就找不回上下文（Hermes stored_session_id 的同款教訓）。
 */
import {
  query,
  renameSession,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { imageBlockFor, materializeAttachment } from "./attachments";
import { claudeBinIsAbsolute, resolveClaudeBin } from "./claude-bin";
import { generateTitle } from "./titles";
import type { LinkBClient } from "../linkb/client";
import type { E2EKeyStore } from "../e2e/keys";
import { discoverSessions, type Mirror } from "./mirror";
import { foldEntries, readEntries } from "./transcripts";

const CC_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function mapPath(): string {
  return process.env.MACCHIATO_CC_SESSIONS || join(homedir(), ".macchiato/claude-code-sessions.json");
}

export function workDir(): string {
  return process.env.MACCHIATO_CC_WORKDIR || homedir();
}

/** #118 閒置回收:回合結束後這麼久無新 prompt → close 通道回收 CLI 進程(resume 重建零丟失)。 */
function idleMs(): number {
  const s = Number(process.env.MACCHIATO_CC_IDLE_S || "600");
  return (Number.isFinite(s) && s > 0 ? s : 600) * 1000;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** SDK PermissionMode 合法值(對齊 @anthropic-ai/claude-agent-sdk)。 */
const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const;
type PermMode = (typeof PERMISSION_MODES)[number];

/** MACCHIATO_CC_PERMISSION_MODE → 校驗過的 permissionMode;未設/非法 → undefined(走 canUseTool 審批)。 */
export function permissionMode(): PermMode | undefined {
  const m = process.env.MACCHIATO_CC_PERMISSION_MODE;
  if (m && (PERMISSION_MODES as readonly string[]).includes(m)) return m as PermMode;
  if (m) console.error(`[drive] 忽略非法 MACCHIATO_CC_PERMISSION_MODE=${m}（合法:${PERMISSION_MODES.join("/")})`);
  return undefined;
}

/** #98 UI 四檔(協議 PermissionMode)。 */
const UI_MODES = ["ask", "acceptEdits", "plan", "bypass"] as const;
type UiMode = (typeof UI_MODES)[number];
/** 文件編輯類工具——acceptEdits 檔在 canUseTool 內自動批(#116:SDK acceptEdits 被 canUseTool 覆蓋,故自實現)。 */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "ApplyPatch"]);
/**
 * #98 UI 四檔 → SDK permissionMode + canUseTool 策略(#116 探針背書)。
 * - ask       → default,每工具問
 * - acceptEdits → default,編輯類自動批、其餘問(不用 SDK acceptEdits:被 canUseTool 覆蓋)
 * - plan      → plan,ExitPlanMode 經審批橋(#99)
 * - bypass    → bypassPermissions,不調 canUseTool
 */
function mapUiMode(ui: UiMode): { sdk: PermMode | undefined; editAuto: boolean } {
  switch (ui) {
    case "ask":
      return { sdk: "default", editAuto: false };
    case "acceptEdits":
      return { sdk: "default", editAuto: true };
    case "plan":
      return { sdk: "plan", editAuto: false };
    case "bypass":
      return { sdk: "bypassPermissions", editAuto: false };
  }
}

/** #118 可推送 async iterable —— streaming-input 的 prompt 載體(#116 探針同款)。 */
class PushStream<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private notify: (() => void) | undefined;
  private closed = false;
  push(v: T): void {
    this.queue.push(v);
    this.notify?.();
  }
  close(): void {
    this.closed = true;
    this.notify?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => (this.notify = r));
      this.notify = undefined;
    }
  }
}

interface PendingApproval {
  resolve: (allow: boolean, always: boolean) => void;
  toolName: string;
  /** #102 SDK 給的 toolUseID(隨 approval.request 上行;server 支持後 respond 回帶精準配對)。 */
  requestId?: string;
}

/** #109 AskUserQuestion 的單題掛起（clarify.respond 按 request_id 回填;empty answer = 跳過）。 */
interface PendingClarify {
  sid: string;
  /** 記一題答案（null = 跳過）;組內全部到齊時解掛 canUseTool。 */
  record: (answer: string | null) => void;
}

/** 一回合的 prompt 內容:純文本,或 #118 原生塊數組(text + image content blocks)。 */
type TurnContent = string | unknown[];

/** TurnContent → 首段文本(標題生成/日誌用)。 */
function contentText(c: TurnContent): string {
  if (typeof c === "string") return c;
  const t = c.find((b: any) => b?.type === "text") as { text?: string } | undefined;
  return t?.text ?? "";
}

/** #118 一個進行中回合的狀態(原 runTurn 的局部變量,搬進通道供 consume 循環跨消息使用)。 */
interface TurnCtx {
  content: TurnContent;
  /** tool_use id → {name, argsText}(tool.complete 回填用)。 */
  tools: Map<string, { name: string; argsText: string }>;
  started: boolean;
  completed: boolean;
  /** 本回合已見任何 SDK 事件 —— 送達確認(#116 b:未見即死 → 重投一次)。 */
  seen: boolean;
  /** 重投已用過(防循環)。 */
  retried: boolean;
  acc: string;
  lastError?: string; // #102 assistant.error(auth/billing/rate_limit…)→ 失敗行帶上
  isE2E: boolean;
  isFirstMacchiatoTurn: boolean;
}

/** #118 一條長活通道(每活躍會話一條;閒置回收,resume 重建)。 */
interface Channel {
  sid: string;
  /** 通道創建時的工作目錄(#105 變更 → 閒置/回合末重建通道生效)。 */
  cwd: string;
  /** #98 通道創建時的權限模式(UI 檔或 env 兜底標記;變更 → 同 cwd 重建通道)。 */
  permKey: string;
  /** #143 通道創建時的 model(per-session 選擇或 env 兜底;變更 → 重建通道)。 */
  modelKey: string;
  input: PushStream<unknown>;
  q: Query;
  turn?: TurnCtx;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** close() 已叫(閒置回收/cwd 變更/dispose)——迭代器自然結束不當 crash。 */
  closing: boolean;
}

export class Drive {
  /** #10:累計計數(進程生命週期),健康上報帶出。 */
  readonly counters: Record<string, number> = { driveErrors: 0, turnErrors: 0 };
  /** serverSid → CC session uuid（跨重啟持久）。 */
  private map: Record<string, string>;
  /** #105 serverSid → 會話工作目錄（session.create.cwd 下發；跨重啟持久，與 map 同文件 v2 存）。 */
  private cwds: Record<string, string>;
  /** #98 serverSid → UI 權限檔（session.create.permissionMode 下發；持久，同文件存）。 */
  private permModes: Record<string, string>;
  /** #143 serverSid → 會話 model（session.create.model 下發；持久，同文件存）。 */
  private models: Record<string, string>;
  /**
   * #200 一期(可見化):**在途回合**的 sid 集(持久)。回合起加、止刪;進程死在回合中途 →
   * 該 sid 留在盤上 → 下次啟動撈出、Link B ready 後回一條 system 提示「連接器重啟了,這條沒跑完,
   * 請重發」,消滅「發消息無響應無報錯」的靜默失敗(設備重啟同理)。不做自動 resume(避雙投)。
   */
  private pending: Set<string>;
  /** #200 上個進程死時遺留的在途回合(構造時從盤載入、當即清盤;flushAbandoned 在 ready 後告知)。 */
  private abandonedTurns: string[] = [];
  /** #118 sid → 長活通道。 */
  private readonly channels = new Map<string, Channel>();
  /** sid → 排隊的後續 prompt（回合進行中收到的;#118 起可含原生塊數組）。 */
  private readonly queued = new Map<string, TurnContent[]>();
  /** sid → 待批審批（#102 起 respond 帶 request_id 精準配對;缺省回退 FIFO 兼容舊 server）。 */
  private readonly approvals = new Map<string, PendingApproval[]>();
  /** #109 request_id → 待答的 AskUserQuestion 單題（多題共享一個 group,收齊才解掛 canUseTool）。 */
  private readonly clarifies = new Map<string, PendingClarify>();
  /** #102 sid → 本回合被 session.interrupt 中斷(result 定性 interrupted 而非 error)。 */
  private readonly interruptedSids = new Set<string>();
  /** #102 未處理 SDK 消息類型一次性日誌去重(`type/subtype`)——37 種 SDKMessage 只處理一小撮,靜默丟=升級漂移無感知。 */
  private readonly loggedUnknown = new Set<string>();
  /** sid → 本會話「總是允許」的工具名（approval.respond all=true 記住）。 */
  private readonly alwaysAllow = new Map<string, Set<string>>();
  /** §19 E2E：回合內暫存的（已解密）用戶消息，回合結束隨加密批投遞。 */
  private readonly pendingUser = new Map<string, string[]>();

  constructor(
    private readonly linkb: LinkBClient,
    private readonly mirror?: Mirror,
    private readonly e2e?: E2EKeyStore,
  ) {
    const state = this.loadState();
    this.map = state.map;
    this.cwds = state.cwds;
    this.permModes = state.permModes;
    this.models = state.models;
    // 影子兜底:啟動時把既有 ULID→CLI 映射的 CLI uuid 全灌給鏡像(跨重啟持久),鏡像據此永不給
    // 這些「被驅動過」的 CLI 會話單獨建會話(防重啟後污染態丟失又復發)。
    for (const cc of Object.values(this.map)) this.mirror?.markDrivenUuid(cc);
    // #200 上個進程死時盤上還留著的在途回合 = 被殺掉的回合。撈出待 flush(ready 後告知),當即清盤
    // (新回合從空集重記,不與舊的混)。
    this.abandonedTurns = state.pending;
    this.pending = new Set();
    if (state.pending.length) this.saveMap();
  }

  /**
   * #200 一期:Link B ready 後,對「上個進程死時被殺的在途回合」回一條 system 提示,把靜默無響應變
   * 成明確可操作(重發)。非 E2E 才發明文提示(E2E 不洩明文;其會話重發即可)。冪等——清空後不再發。
   */
  flushAbandonedTurns(): void {
    const sids = this.abandonedTurns;
    this.abandonedTurns = [];
    for (const sid of sids) {
      if (this.e2e?.isE2E(sid)) continue;
      this.emit(sid, "review.summary", {
        summary: "⚠️ 連接器剛重啟,上一條消息可能沒跑完——請重發一次。",
      });
    }
  }

  /** #98 該會話當前 SDK 權限模式 + 編輯自動批策略。UI 檔優先,回退 env(逃生門)。permKey=通道重建判據。 */
  private resolvePerm(sid: string): { sdk: PermMode | undefined; editAuto: boolean; permKey: string } {
    const ui = this.permModes[sid];
    if (ui && (UI_MODES as readonly string[]).includes(ui)) {
      const m = mapUiMode(ui as UiMode);
      return { ...m, permKey: `ui:${ui}` };
    }
    const env = permissionMode();
    return { sdk: env, editAuto: false, permKey: `env:${env ?? "ask"}` };
  }

  /**
   * #143 該會話當前 model:per-session 選擇優先,回退 env `MACCHIATO_CC_MODEL`(逃生門),
   * 都無 → undefined(不傳 model,用 CLI 配置默認)。絕不 hardcode(鐵律)——列表由 web 端提供,
   * 連接器只透傳用戶所選。返回 undefined 時通道 modelKey="default"。
   */
  private resolveModel(sid: string): string | undefined {
    const ui = this.models[sid];
    if (ui) return ui;
    const env = process.env.MACCHIATO_CC_MODEL;
    return env || undefined;
  }

  wire(): void {
    this.linkb.onFrame((m) => void this.onServerFrame(m));
  }

  /** #118 關停:回收全部通道(CLI 進程),供 index.ts shutdown 調用。 */
  dispose(): void {
    for (const ch of [...this.channels.values()]) this.closeChannel(ch);
  }

  private emit(sid: string, type: string, payload: Record<string, unknown>): void {
    this.linkb.send({
      t: "tui",
      agentLinkId: this.linkb.agentLinkId,
      sessionId: sid,
      frame: { jsonrpc: "2.0", method: "event", params: { type, session_id: sid, payload } },
    });
  }

  private ccSidFor(sid: string): string | undefined {
    if (CC_UUID_RE.test(sid)) return sid; // 鏡像會話：sid 即 CC session id
    return this.map[sid];
  }

  /** sid → 該會話進行中的後台 task_id 集合(task.stop 短 id 前綴還原兜底 + 展示去重)。 */
  private readonly sessionTasks = new Map<string, Set<string>>();
  /** task_id → 上次 progress 上報時刻(節流)。 */
  private readonly taskProgressAt = new Map<string, number>();
  /** #104 進度改原地更新(不再刷屏),節流可比文本行時代(15s)更密。 */
  private static readonly PROGRESS_THROTTLE_MS = 5_000;

  /**
   * #97→#104 後台任務:task_started/progress/notification → 結構化 task.start/update/end
   * (server 落一等 task 塊、原地更新;舊 server 的 switch default 忽略,無害)。
   * subagent 與後台 bash 統一;task_id 全量上報(task.stop 不再靠短 id 還原)。
   * #118 註:task 事件可在回合 result 之後才到(後台任務跑完前通道仍活)——會話級處理,不依賴 turn。
   */
  private handleTaskEvent(sid: string, m: Record<string, any>): void {
    const taskId: string = String(m.task_id ?? "");
    if (!taskId || m.ambient === true) return; // ambient/housekeeping 任務隱藏
    if (m.subtype === "task_started") {
      const set = this.sessionTasks.get(sid) ?? new Set();
      set.add(taskId);
      this.sessionTasks.set(sid, set);
      this.emit(sid, "task.start", {
        task_id: taskId,
        kind: m.subagent_type ? "subagent" : "background",
        ...(m.subagent_type ? { subagent_type: String(m.subagent_type) } : {}),
        desc: String(m.description ?? "task").slice(0, 200),
        // #138:發起任務的 Task 工具調用 id——server 據此把工具塊原地升格為 task 塊。
        ...(m.tool_use_id ? { tool_use_id: String(m.tool_use_id) } : {}),
      });
    } else if (m.subtype === "task_progress") {
      const now = Date.now();
      if (now - (this.taskProgressAt.get(taskId) ?? 0) < Drive.PROGRESS_THROTTLE_MS) return; // 節流
      this.taskProgressAt.set(taskId, now);
      if (!m.last_tool_name) return; // 無新信息就別發空更新
      this.emit(sid, "task.update", { task_id: taskId, last_activity: String(m.last_tool_name) });
    } else if (m.subtype === "task_notification") {
      this.sessionTasks.get(sid)?.delete(taskId);
      this.taskProgressAt.delete(taskId);
      const status = m.status === "completed" ? "completed" : m.status === "stopped" ? "stopped" : "error";
      // notification 的 desc 不回退 summary(否則兩者相同時 summary 被誤判重複而丟——
      // 後台 bash 常只帶 summary 不帶 description)。desc 供 server 錯過 start 時兜底建行。
      const desc = String(m.description ?? "").slice(0, 200);
      const summary = String(m.summary ?? "").slice(0, 500);
      this.emit(sid, "task.end", {
        task_id: taskId,
        status,
        ...(summary && summary !== desc ? { summary } : {}),
        ...(desc ? { desc } : {}),
      });
    }
    // task_updated / task_summary:v1 不單獨展示(進度靠 task_progress,完成靠 notification)。
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
          // #73 語音優雅降級:Claude Code 無 STT。audio 附件立即回「未能轉錄」——否則 server 的
          // 「轉錄中…」占位永久卡住(2026-07-06 實測)。雲端 STT(BYOK)見 #89,屆時 server 側路由。
          const atts = Array.isArray(params.attachments) ? (params.attachments as Record<string, unknown>[]) : [];
          const filePaths: string[] = [];
          const imageBlocks: unknown[] = [];
          for (const a of atts) {
            if (a?.kind === "audio" && a.id) {
              this.linkb.send({
                t: "voice_transcript",
                agentLinkId: this.linkb.agentLinkId,
                sessionId: sid,
                attachmentId: a.id,
                text: "",
                error: "stt_unavailable",
              });
              console.log(`· voice attachment ${a.id} → stt_unavailable (Claude Code has no STT)`);
            } else if (a?.url) {
              // #72 附件入站:下載落盤(SSRF 防護見 attachments.ts)。#118:小圖直接進 content
              // (原生 image block,視覺直達);超限/非圖/E2E → 路徑注入 prompt 供 Read 工具讀。
              try {
                const p = await materializeAttachment(a);
                const blk = this.e2e?.isE2E(sid) ? null : imageBlockFor(p, String(a.mime ?? ""));
                if (blk) imageBlocks.push(blk);
                else filePaths.push(p);
              } catch (e) {
                console.error(`[attachment ${String(a.id)} download failed] ${(e as Error).message}`);
              }
            }
          }
          if (filePaths.length) {
            const note = `[The user attached ${filePaths.length} file(s), read them with the Read tool: ${filePaths.join(", ")}]`;
            text = text ? `${text}\n\n${note}` : note;
          }
          if (!text && !imageBlocks.length) return;
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
          // #118 原生圖片:有圖 → content 塊數組(text 塊 + image 塊);純文本照舊字符串。
          const content: TurnContent = imageBlocks.length
            ? [...(text ? [{ type: "text", text }] : []), ...imageBlocks]
            : text;
          const busy = this.channels.get(sid);
          if (busy?.turn) {
            // #75 steer(硬轉向,2026-07-11 用戶拍板默認行為):回合進行中發消息 = 打斷當前回合
            // (定稿 interrupted,已生成部分保留)+ 新消息作為下一回合立即開跑(finishTurn 的排隊
            // 續投機制,同通道帶完整上下文)。SDK 無「邊生成邊融合」(探測結論 3),打斷+接管是
            // 唯一真 steer;與 OpenClaw 在 Macchiato 的 steer 行為對齊。
            const q = this.queued.get(sid) ?? [];
            q.push(content);
            this.queued.set(sid, q);
            if (!busy.turn.completed) {
              this.interruptedSids.add(sid);
              try {
                await busy.q.interrupt();
              } catch {
                /* 回合恰好剛結束 → interrupt 空打,排隊消息由 finishTurn 正常續投 */
              }
              console.log(`· Steer:打斷當前回合,新消息接管 → ${sid}`);
            }
            return;
          }
          this.startTurn(sid, content);
          return;
        }
        case "session.interrupt": {
          const ch = this.channels.get(sid);
          if (ch?.turn && !ch.turn.completed) {
            this.interruptedSids.add(sid); // #102 隨後的 result(error) 定性為 interrupted
            await ch.q.interrupt(); // #116 g:interrupt 不殺通道,下一回合同通道照常
            console.log(`· Interrupted turn for ${sid}`);
          }
          return;
        }
        case "session.create": {
          // #105 upsert：登記/更新會話工作目錄（CC 會話本體仍由首次 prompt 的 init 建立）。
          // 草稿期改 cwd = server 重發本方法；不帶 cwd = 清回連接器默認。
          const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
          if (cwd ? this.cwds[sid] !== cwd : this.cwds[sid] !== undefined) {
            if (cwd) this.cwds[sid] = cwd;
            else delete this.cwds[sid];
            this.saveMap();
            console.log(`· session.create ${sid} cwd=${cwd || "(default)"}`);
          }
          // #98 權限檔(upsert;隨時可改,不像 cwd)。空/非法 = 清回 env 默認。
          const pm = typeof params.permissionMode === "string" ? params.permissionMode.trim() : "";
          const validPm = (UI_MODES as readonly string[]).includes(pm) ? pm : "";
          if (validPm ? this.permModes[sid] !== validPm : this.permModes[sid] !== undefined) {
            if (validPm) this.permModes[sid] = validPm;
            else delete this.permModes[sid];
            this.saveMap();
            console.log(`· session.create ${sid} permissionMode=${validPm || "(env default)"}`);
          }
          // #143 model(upsert;隨時可改)。空 = 清回連接器默認(env / CLI 配置)。自由字符串——
          // 不校驗枚舉(支持別名 opus/sonnet/haiku 或完整 id),連接器只透傳。
          const md = typeof params.model === "string" ? params.model.trim() : "";
          if (md ? this.models[sid] !== md : this.models[sid] !== undefined) {
            if (md) this.models[sid] = md;
            else delete this.models[sid];
            this.saveMap();
            console.log(`· session.create ${sid} model=${md || "(default)"}`);
          }
          // #98/#118/#143 cwd/權限/model 是通道創建參數:閒置通道立即重建生效;回合進行中的留給回合末。
          const ch = this.channels.get(sid);
          if (
            ch &&
            !ch.turn &&
            (ch.cwd !== this.cwdFor(sid) ||
              ch.permKey !== this.resolvePerm(sid).permKey ||
              ch.modelKey !== (this.resolveModel(sid) ?? "default"))
          ) {
            this.closeChannel(ch);
          }
          // 急校驗：壞目錄立刻回一行 system 提示（system 行不鎖 cwd，草稿仍可改），
          // 別等首條 prompt 才炸。E2E 跳過（不發明文行；startTurn 走加密回覆兜底）。
          if (cwd && !this.e2e?.isE2E(sid)) {
            const resolved = this.cwdFor(sid);
            if (!isDir(resolved)) {
              this.emit(sid, "review.summary", {
                summary: `⚠️ 工作目錄不存在或不是目錄：${resolved}（連接器主機上）`,
              });
            }
          }
          return;
        }
        case "session.archive":
          return; // #75:CC 無歸檔概念,顯式忽略(不落 default 靜默)
        case "session.retitle": {
          // #94 後續:UI 發起「AI 重新命名」。讀該會話 transcript → 生成 → emit session.title。
          void this.retitleFromTranscript(sid);
          return;
        }
        case "task.stop": {
          // #97 停後台任務:channel.q.stopTask(taskId)。#118:通道長活,回合結束後後台任務仍可停。
          // 客戶端從展示行只拿得到 8 位短 id → 先在本會話進行中任務裡按前綴還原全 id。
          let taskId = String(params.taskId ?? "");
          const running = this.sessionTasks.get(sid);
          if (taskId && running && !running.has(taskId)) {
            const full = [...running].find((id) => id.startsWith(taskId));
            if (full) taskId = full;
          }
          const cur = this.channels.get(sid)?.q;
          if (cur && taskId) {
            try {
              await (cur as unknown as { stopTask(id: string): Promise<void> }).stopTask(taskId);
              console.log(`· stopTask ${taskId} for ${sid}`);
            } catch (e) {
              console.error(`[task.stop ${taskId} failed] ${(e as Error).message}`);
            }
          }
          return;
        }
        case "clarify.respond": {
          // #109:AskUserQuestion 單題答案(answer=所選 label;空串=跳過)。恆帶 request_id。
          const reqId = String(params.request_id ?? "");
          const pending = this.clarifies.get(reqId);
          if (!pending) return;
          this.clarifies.delete(reqId);
          const answer = typeof params.answer === "string" ? params.answer : "";
          pending.record(answer || null);
          return;
        }
        case "approval.respond": {
          const list = this.approvals.get(sid);
          if (!list?.length) return;
          // #102:優先按 request_id 配對(server 開始回帶後端到端精準);缺省回退 FIFO(舊 server 兼容)。
          const reqId = typeof params.request_id === "string" ? params.request_id : "";
          let pending: PendingApproval | undefined;
          if (reqId) {
            const i = list.findIndex((p) => p.requestId === reqId);
            if (i >= 0) pending = list.splice(i, 1)[0];
          }
          pending ??= list.shift();
          if (!pending) return;
          const choice = String(params.choice ?? "deny");
          const allow = choice === "allow" || choice === "always" || choice === "yes";
          const always = allow && (params.all === true || choice === "always");
          if (always) {
            const s = this.alwaysAllow.get(sid) ?? new Set();
            s.add(pending.toolName);
            this.alwaysAllow.set(sid, s);
          }
          pending.resolve(allow, always);
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

  /** #105 會話工作目錄：per-session 下發值（~ 由此處展開）優先，回退 env/home 默認。 */
  private cwdFor(sid: string): string {
    const c = this.cwds[sid];
    if (!c) return workDir();
    if (c === "~") return homedir();
    return c.startsWith("~/") ? join(homedir(), c.slice(2)) : c;
  }

  /**
   * #118 起一回合:確保通道存在(閒置回收/cwd 變更後重建,resume 續上下文)→ 建 TurnCtx → push。
   * 同步執行(openChannel 到 turn 賦值之間無 await)——保證 consume 循環首條消息到達時 turn 已就緒。
   */
  private startTurn(sid: string, content: TurnContent, opts?: { retriedDelivery?: boolean }): void {
    const isE2E = this.e2e?.isE2E(sid) ?? false;
    // #105 每回合校驗工作目錄(用戶手輸的可能有 typo,也可能事後被刪):不存在就回提示、不起回合——
    // CC 在壞 cwd 下的報錯難懂。提示走 system 行(review.summary),agent 沒有回覆過 → server 側
    // cwd 仍可改,用戶修正路徑後重發即可;E2E 走加密回覆(不發明文行)。
    const cwd = this.cwdFor(sid);
    if (!isDir(cwd)) {
      const errText = `⚠️ 工作目錄不存在或不是目錄：${cwd}（連接器主機上）。請修正會話目錄後重發。`;
      if (isE2E) this.sendE2ETurn(sid, errText);
      else this.emit(sid, "review.summary", { summary: errText });
      return;
    }
    let ch = this.channels.get(sid);
    // #98/#143 cwd/權限檔/model 變了 → 通道創建參數失效,重建(閒置通道立即,回合中的留到回合末)。
    if (
      ch &&
      (ch.closing ||
        ch.cwd !== cwd ||
        ch.permKey !== this.resolvePerm(sid).permKey ||
        ch.modelKey !== (this.resolveModel(sid) ?? "default"))
    ) {
      this.closeChannel(ch);
      ch = undefined;
    }
    const hadCc = !!this.ccSidFor(sid);
    if (!ch) ch = this.openChannel(sid, cwd);
    if (ch.idleTimer) {
      clearTimeout(ch.idleTimer);
      ch.idleTimer = undefined;
    }
    // #94：Macchiato 發起的會話(非 uuid)首回合(無映射)= 新對話 → **立即**用首條 user 文本生成
    // 標題(不等回合結束,越早越好——用戶剛發第一句、AI 還在想,標題就出來)。重啟安全(映射持久→
    // 有映射→不重生);E2E 跳過(明文洩漏);送達重投跳過(首投已生成緩存)。
    const isFirstMacchiatoTurn = !hadCc && !CC_UUID_RE.test(sid) && !isE2E;
    if (isFirstMacchiatoTurn && !opts?.retriedDelivery) void this.maybeTitle(sid, undefined, contentText(content));
    this.interruptedSids.delete(sid); // 新回合清舊標記
    ch.turn = {
      content,
      tools: new Map(),
      started: false,
      completed: false,
      seen: false,
      retried: !!opts?.retriedDelivery,
      acc: "",
      isE2E,
      isFirstMacchiatoTurn,
    };
    this.pending.add(sid); // #200 在途回合登記(進程死在此後 → 下次啟動提示重發)
    this.saveMap();
    ch.input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "",
    });
  }

  /** #118 開通道:長活 query(streaming-input)+ 後台 consume 循環。 */
  private openChannel(sid: string, cwd: string): Channel {
    const resume = this.ccSidFor(sid);
    // 權限模式:MACCHIATO_CC_PERMISSION_MODE 設 bypassPermissions(全放行,不彈審批卡)/
    // acceptEdits 等 → 傳給 SDK(通道創建參數;#116:bypass 只能啟動時給,中途切換=重建通道)。
    // 提供 canUseTool 時 default/plan 的審批走它(#116 e/f:回調覆蓋 acceptEdits 自動批;bypass 不調)。
    // #98 per-session 權限:UI 檔映射(#116 探針)——ask/acceptEdits=default SDK 模式(編輯自動批在
    // canUseTool 內自實現)、plan=plan、bypass=bypassPermissions。回退 env 逃生門。
    const perm = this.resolvePerm(sid);
    const model = this.resolveModel(sid); // #143 per-session model(回退 env);undefined = CLI 默認
    const input = new PushStream<unknown>();
    const q = query({
      prompt: input as AsyncIterable<never>,
      options: {
        cwd, // #105 per-session 工作目錄（cwdFor 已解析，回退連接器默認）
        ...(resume ? { resume } : {}),
        ...(claudeBinIsAbsolute() ? { pathToClaudeCodeExecutable: resolveClaudeBin() } : {}),
        ...(model ? { model } : {}), // #143 per-session model(空 = 不傳,用 CLI 配置默認)
        ...(perm.sdk ? { permissionMode: perm.sdk } : {}),
        includePartialMessages: true,
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
          // #102 SDK 給的審批上下文:toolUseID(配對鍵)、suggestions(「總是允許」的原生規則,SDK 文檔
          // 明示應原樣回作 updatedPermissions)、title/description(現成的審批文案,優於自拼)。
          opts?: { toolUseID?: string; suggestions?: PermissionUpdate[]; title?: string; description?: string },
        ) => {
          // #109 AskUserQuestion 不是審批是提問:走 clarify 卡收答案,經 updatedInput.answers 回帶
          // (探針驗證:AskUserQuestionInput 頂層有可選 answers,填上即出「questions answered」tool_result)。
          if (toolName === "AskUserQuestion") return await this.requestAnswers(sid, input, opts?.toolUseID);
          if (this.alwaysAllow.get(sid)?.has(toolName)) return { behavior: "allow" as const, updatedInput: input };
          // #98 acceptEdits 檔:文件編輯類自動批(SDK acceptEdits 被 canUseTool 覆蓋,故此處自實現)。
          if (perm.editAuto && EDIT_TOOLS.has(toolName)) return { behavior: "allow" as const, updatedInput: input };
          return await this.requestApproval(sid, toolName, input, opts);
        },
      },
    });
    const ch: Channel = { sid, cwd, permKey: perm.permKey, modelKey: model ?? "default", input, q, closing: false };
    this.channels.set(sid, ch);
    void this.consume(ch);
    return ch;
  }

  /** #118 通道消費循環:活到 close/crash;逐條路由;結束後統一收尾。 */
  private async consume(ch: Channel): Promise<void> {
    let err: Error | undefined;
    try {
      for await (const m of ch.q as AsyncIterable<any>) {
        this.handleMessage(ch, m);
      }
    } catch (e) {
      err = e as Error;
      this.counters.turnErrors += 1; // #10
    }
    this.onChannelEnd(ch, err);
  }

  /** 首個非 E2E 事件 → message.start(每回合一次)。 */
  private startMsg(sid: string, turn: TurnCtx): void {
    if (turn.started || turn.isE2E) return;
    turn.started = true;
    this.emit(sid, "message.start", {});
  }

  private handleMessage(ch: Channel, m: any): void {
    const sid = ch.sid;
    const turn = ch.turn;
    if (turn && !turn.completed) turn.seen = true; // 送達確認(#116 b)
    const isE2E = turn?.isE2E ?? this.e2e?.isE2E(sid) ?? false;

    if (m.type === "system" && m.subtype === "init" && typeof m.session_id === "string") {
      // #118:streaming 模式每回合一個 init。首回合據此存映射;每回合 setDriven(live 獨佔投遞)。
      if (!this.map[sid] && !CC_UUID_RE.test(sid)) {
        this.map[sid] = m.session_id;
        this.saveMap();
      }
      this.mirror?.setDriven(m.session_id); // 本回合 live 獨佔(per-turn)
      this.mirror?.markDrivenUuid(m.session_id); // 影子兜底:永久登記此 CLI uuid 為「被驅動過」
      return;
    }
    // #97 後台任務(subagent + run_in_background bash 統一走 task_*):展示進度/完成。E2E 會話
    // 跳過(避免明文洩漏);ambient/housekeeping 任務隱藏。#118:可在回合間到達(不依賴 turn)。
    if (m.type === "system" && typeof m.subtype === "string" && m.subtype.startsWith("task")) {
      if (!isE2E) this.handleTaskEvent(sid, m);
      return;
    }
    // #102 壓縮可見化:長會話自動/手動壓縮不再是無解釋停頓。
    if (m.type === "system" && m.subtype === "compact_boundary") {
      if (!isE2E) {
        const meta = m.compact_metadata ?? {};
        const trig = meta.trigger === "manual" ? "手動" : "自動";
        const toks = typeof meta.pre_tokens === "number" ? `,壓縮前 ~${meta.pre_tokens} tokens` : "";
        this.emit(sid, "review.summary", { summary: `📦 上下文已壓縮(${trig}${toks})` });
      }
      return;
    }
    if (m.type === "system" && m.subtype === "status") {
      // 只提示 compacting;requesting/null 太碎,靜默。
      if (!isE2E && m.status === "compacting") this.emit(sid, "review.summary", { summary: "📦 正在壓縮上下文…" });
      return;
    }
    // #102 API 重試可見化(限流/過載時用戶不再乾等)。
    if (m.type === "system" && m.subtype === "api_retry") {
      if (!isE2E) {
        const http = m.error_status ? `,HTTP ${m.error_status}` : "";
        this.emit(sid, "review.summary", { summary: `🔁 API 重試中 (${m.attempt}/${m.max_retries}${http})` });
      }
      return;
    }
    // #102 權限規則層拒絕(不經 canUseTool)此前完全隱形。
    if (m.type === "system" && m.subtype === "permission_denied") {
      if (!isE2E) {
        const why = m.message ? `:${String(m.message).slice(0, 200)}` : "";
        this.emit(sid, "review.summary", { summary: `🚫 工具 ${m.tool_name ?? "?"} 被權限規則拒絕${why}` });
      }
      return;
    }
    if (m.type === "stream_event") {
      if (!turn || turn.completed) return; // 回合外的流事件(不應有)——丟棄
      const ev = m.event ?? {};
      if (ev.type === "content_block_delta") {
        const d = ev.delta ?? {};
        if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
          this.startMsg(sid, turn);
          turn.acc += d.text;
          if (!turn.isE2E) this.emit(sid, "message.delta", { text: d.text });
        } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking && !turn.isE2E) {
          this.startMsg(sid, turn);
          this.emit(sid, "reasoning.delta", { text: d.thinking });
        }
      } else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        const b = ev.content_block;
        const id = String(b.id ?? "");
        turn.tools.set(id, { name: String(b.name ?? "tool"), argsText: "" });
        this.startMsg(sid, turn);
        if (!turn.isE2E) this.emit(sid, "tool.start", { tool_id: id, name: String(b.name ?? "tool") });
      }
      return;
    }
    if (m.type === "assistant") {
      if (!turn || turn.completed) return;
      // #102 API 級錯誤分類(authentication_failed/billing_error/rate_limit/overloaded…)留給失敗行
      if (typeof m.error === "string") turn.lastError = m.error;
      // 完整 assistant API 消息：補齊 tool_use 的 args（deltas 裡是分片 json）
      for (const b of m.message?.content ?? []) {
        if (b?.type === "tool_use" && typeof b.id === "string" && turn.tools.has(b.id)) {
          turn.tools.get(b.id)!.argsText = JSON.stringify(b.input ?? {});
        }
      }
      return;
    }
    if (m.type === "user") {
      if (!turn || turn.completed) return;
      for (const b of m.message?.content ?? []) {
        if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const t = turn.tools.get(b.tool_use_id);
        if (!t || turn.isE2E) continue;
        const resultText =
          typeof b.content === "string"
            ? b.content
            : (Array.isArray(b.content) ? b.content : [])
                .filter((x: any) => x?.type === "text")
                .map((x: any) => x.text)
                .join("");
        this.emit(sid, "tool.complete", {
          tool_id: b.tool_use_id,
          name: t.name,
          args: this.safeArgs(t.argsText),
          result: null,
          result_text: String(resultText).slice(0, 20_000),
        });
      }
      return;
    }
    if (m.type === "result") {
      if (!turn || turn.completed) return; // 回合外的 stray result——丟棄
      this.finishTurn(ch, turn, m);
      return;
    }
    // #102 兜底:SDKMessage union 37 個成員只處理上面一小撮,其餘曾靜默丟棄=SDK 升級漂移無感知。
    // 每種 (type/subtype) 進程內只記一次,帶採樣 JSON。
    const key = `${m.type}/${m.subtype ?? ""}`;
    if (!this.loggedUnknown.has(key)) {
      this.loggedUnknown.add(key);
      console.log(`[drive] 未處理的 SDK 消息 ${key}(首次,已忽略): ${JSON.stringify(m).slice(0, 400)}`);
    }
  }

  /** #118 回合定稿(result 到):message.complete + 鏡像快進 + 續投排隊/閒置計時。 */
  private finishTurn(ch: Channel, turn: TurnCtx, m: any): void {
    const sid = ch.sid;
    turn.completed = true;
    const interrupted = this.interruptedSids.delete(sid);
    const isErr = m.subtype !== "success" || m.is_error === true;
    // #102 status:協議 MessageCompletePayload 本就有(server 已消費 done/interrupted/error);
    // 此前不發 → 失敗回合對用戶靜默成「正常結束」。
    const status = isErr ? (interrupted ? "interrupted" : "error") : "complete";
    const finalText: string = typeof m.result === "string" && m.result ? m.result : turn.acc;
    // #102 usage/cost 上行(協議字段現成;server 落庫/UI 展示為 server/web 側後續)。
    const usage: Record<string, unknown> = {
      ...(m.usage && typeof m.usage === "object" ? m.usage : {}),
      ...(typeof m.total_cost_usd === "number" ? { total_cost_usd: m.total_cost_usd } : {}),
      ...(typeof m.num_turns === "number" ? { num_turns: m.num_turns } : {}),
      ...(typeof m.duration_ms === "number" ? { duration_ms: m.duration_ms } : {}),
      ...(m.modelUsage && typeof m.modelUsage === "object" ? { models: Object.keys(m.modelUsage) } : {}),
    };
    if (turn.isE2E) {
      this.sendE2ETurn(sid, finalText);
    } else {
      // #102 失敗回合(非用戶中斷)給一條可讀錯誤行:subtype + assistant.error 分類 + 首條 errors[]
      if (isErr && !interrupted) {
        const detail = [
          typeof m.subtype === "string" && m.subtype !== "success" ? m.subtype : "",
          turn.lastError ?? "",
          ...(Array.isArray(m.errors) ? m.errors.slice(0, 1).map(String) : []),
        ]
          .filter(Boolean)
          .join(" · ");
        this.emit(sid, "review.summary", {
          summary: `❌ 回合失敗${detail ? `(${detail.slice(0, 200)})` : ""}`,
        });
      }
      this.startMsg(sid, turn);
      this.emit(sid, "message.complete", { text: finalText, status, usage });
    }
    // 懸而未決的審批一律拒（回合都結束了）
    for (const p of this.approvals.get(sid) ?? []) p.resolve(false, false);
    this.approvals.delete(sid);
    const cc = this.ccSidFor(sid);
    if (cc) {
      this.mirror?.fastForward(cc); // live 已投遞 → 鏡像水位線快進越過本回合
      this.mirror?.unsetDriven(cc); // 僅回合級跳過：解除後終端側活動恢復鏡像（CC 無 gateway,鏡像是唯一路）
    }
    // #94：標題已在回合開頭立即生成(見 startTurn),此處不重複。回合末補寫回 transcript
    // (終端也見同一標題;ccSid 此時已建立)——只寫回,不重新生成(genTitle 由早期生成緩存)。
    if (turn.isFirstMacchiatoTurn && cc && this.genTitle) {
      void renameSession(cc, this.genTitle).catch(() => {});
      this.genTitle = undefined;
    }
    ch.turn = undefined;
    this.pending.delete(sid); // #200 回合正常收尾 → 出在途集(有續投則 startTurn 再加回)
    this.saveMap();
    // 排隊的後續 prompt → 同通道續投(startTurn 自檢 cwd 變更);沒有 → 閒置計時回收。
    const next = this.queued.get(sid)?.shift();
    if (!this.queued.get(sid)?.length) this.queued.delete(sid);
    if (next !== undefined) {
      this.startTurn(sid, next);
      return;
    }
    if (ch.cwd !== this.cwdFor(sid)) {
      this.closeChannel(ch); // #105 回合中 cwd 被改 → 回合末重建生效
      return;
    }
    ch.idleTimer = setTimeout(() => this.closeChannel(ch), idleMs());
    ch.idleTimer.unref?.();
  }

  /** #118 通道結束(close/crash 後的統一收尾):未完回合定性;送達重投;續投排隊。 */
  private onChannelEnd(ch: Channel, err?: Error): void {
    const sid = ch.sid;
    if (this.channels.get(sid) === ch) this.channels.delete(sid);
    if (ch.idleTimer) {
      clearTimeout(ch.idleTimer);
      ch.idleTimer = undefined;
    }
    const turn = ch.turn;
    ch.turn = undefined;
    this.pending.delete(sid); // #200 通道收尾 → 出在途集(下面若走送達重投,startTurn 會再加回)
    this.saveMap();
    if (turn && !turn.completed) {
      // 送達確認(#116 b):push 後 CLI 未及處理(未見任何事件)即死 → 重投一次(新通道 resume)。
      // 已見事件的回合:user 消息已落 transcript(#116 b 實測),重投=雙投,只能定稿 error。
      if (err && !turn.seen && !turn.retried) {
        console.error(`[channel died before delivery for ${sid}] ${err.message} → 重投一次`);
        this.startTurn(sid, turn.content, { retriedDelivery: true });
        return;
      }
      console.error(`[turn failed for ${sid}] ${err?.message ?? "channel closed mid-turn"}`);
      const interrupted = this.interruptedSids.delete(sid);
      if (!turn.isE2E) {
        this.startMsg(sid, turn);
        this.emit(sid, "message.complete", {
          text: turn.acc || `(error: ${err?.message ?? "channel closed"})`,
          status: interrupted ? "interrupted" : "error",
          usage: {},
        });
      }
      for (const p of this.approvals.get(sid) ?? []) p.resolve(false, false);
      this.approvals.delete(sid);
      // #109 懸掛的 AskUserQuestion 單題:record(null) 令組內計數歸零、canUseTool 以無答案解掛
      // (通道已死,resolve 結果無人消費,但清掉防 map 泄漏)。
      for (const [reqId, c] of this.clarifies) {
        if (c.sid === sid) {
          this.clarifies.delete(reqId);
          c.record(null);
        }
      }
      const cc = this.ccSidFor(sid);
      if (cc) {
        this.mirror?.fastForward(cc);
        this.mirror?.unsetDriven(cc);
      }
    }
    // 通道死了但還有排隊 → 繼續(startTurn 會開新通道 resume)。
    const next = this.queued.get(sid)?.shift();
    if (!this.queued.get(sid)?.length) this.queued.delete(sid);
    if (next !== undefined) this.startTurn(sid, next);
  }

  /** #118 關通道:回收 CLI 進程(閒置/變更 cwd/dispose)。consume 循環隨後自然結束。 */
  private closeChannel(ch: Channel): void {
    ch.closing = true;
    if (ch.idleTimer) {
      clearTimeout(ch.idleTimer);
      ch.idleTimer = undefined;
    }
    if (this.channels.get(ch.sid) === ch) this.channels.delete(ch.sid);
    try {
      ch.input.close();
    } catch {
      /* 重複 close 無害 */
    }
  }

  /** 回合開頭生成的標題(緩存供回合末寫回 transcript;避免二次生成)。 */
  private genTitle: string | undefined;

  /** #94：立即用首條 user 文本生成標題 → emit session.title(server 更新)。ccSid 有則順帶寫回 transcript。 */
  private async maybeTitle(sid: string, ccSid: string | undefined, firstUserText: string): Promise<void> {
    try {
      const title = await generateTitle(firstUserText);
      if (!title) return;
      this.genTitle = title; // 供回合末寫回 transcript(首回合時 ccSid 尚未建立)
      this.emit(sid, "session.title", { title });
      if (ccSid) {
        try {
          await renameSession(ccSid, title);
        } catch {
          /* 寫回 transcript 失敗不致命(session.title 已發給 server) */
        }
      }
      console.log(`· 生成標題「${title}」→ ${sid}`);
    } catch (e) {
      console.error(`[title gen failed for ${sid}] ${(e as Error).message}`);
    }
  }

  /**
   * #94 後續:UI 發起 AI 重新命名。讀該會話的 transcript 首條真人消息 → generateTitle → session.title。
   * 對鏡像會話(uuid sid=CC session id)與 Macchiato 會話(映射到 cc sid)都適用;E2E 跳過(防洩漏)。
   */
  private async retitleFromTranscript(sid: string): Promise<void> {
    if (this.e2e?.isE2E(sid)) return;
    try {
      const cc = this.ccSidFor(sid);
      if (!cc) return;
      const file = discoverSessions().find((s) => s.sid === cc)?.file;
      if (!file) {
        console.error(`[retitle] 找不到 ${cc} 的 transcript`);
        return;
      }
      const { entries, endOffset } = readEntries(file, 0);
      const { messages } = foldEntries(entries, endOffset, Number.MAX_SAFE_INTEGER);
      const firstUser = messages.find((m) => m.role === "user")?.text;
      if (!firstUser) return;
      const title = await generateTitle(firstUser);
      if (!title) return;
      this.emit(sid, "session.title", { title });
      try {
        await renameSession(cc, title);
      } catch {
        /* 寫回 transcript 失敗不致命 */
      }
      console.log(`· AI 重新命名「${title}」→ ${sid}`);
    } catch (e) {
      console.error(`[retitle failed for ${sid}] ${(e as Error).message}`);
    }
  }

  /**
   * canUseTool → approval.request，掛起等 approval.respond。
   * #102:payload 帶 request_id(=SDK toolUseID);respond 回帶則精準配對,缺省 FIFO(舊 server 兼容)。
   * 「總是允許」優先回 SDK 給的 suggestions(原生規則,SDK 文檔明示的用法);沒有則退化 addRules
   * destination:"session"。#118 通道長活後會話級規則在通道生命期內天然持久;內存 alwaysAllow
   * Set 仍保留為真來源(通道閒置回收後重建也不丟)。
   */
  private requestApproval(
    sid: string,
    toolName: string,
    input: Record<string, unknown>,
    opts?: { toolUseID?: string; suggestions?: PermissionUpdate[]; title?: string; description?: string },
  ): Promise<PermissionResult> {
    // #99 Plan 模式:ExitPlanMode 經此橋;input.plan=計劃全文 → 作卡片正文(而非工具名+JSON)。
    const isPlan = toolName === "ExitPlanMode";
    const planText = isPlan && typeof input?.plan === "string" ? (input.plan as string) : "";
    const argsPreview = JSON.stringify(input ?? {}).slice(0, 500);
    this.emit(sid, "approval.request", {
      command: isPlan ? "批准計劃並開始執行" : opts?.title || `${toolName} ${argsPreview}`,
      pattern_key: toolName,
      pattern_keys: [toolName],
      description: isPlan ? planText.slice(0, 8000) : opts?.description || `Claude Code wants to use ${toolName}`,
      ...(isPlan ? { plan: planText.slice(0, 20000) } : {}),
      ...(opts?.toolUseID ? { request_id: opts.toolUseID } : {}),
    });
    return new Promise((resolve) => {
      const list = this.approvals.get(sid) ?? [];
      list.push({
        toolName,
        requestId: opts?.toolUseID,
        resolve: (allow, always) =>
          resolve(
            allow
              ? {
                  behavior: "allow",
                  updatedInput: input,
                  ...(always
                    ? {
                        updatedPermissions: opts?.suggestions?.length
                          ? opts.suggestions
                          : ([
                              { type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" },
                            ] satisfies PermissionUpdate[]),
                      }
                    : {}),
                }
              : { behavior: "deny", message: "Denied via Macchiato" },
          ),
      });
      this.approvals.set(sid, list);
    });
  }

  /**
   * #109 AskUserQuestion → 逐題 clarify.request（帶 request_id=`${toolUseID}#i`），收齊
   * clarify.respond 後把答案掛回 `updatedInput.answers`（`{問題原文: 所選 label}`）解掛 canUseTool。
   * 全部跳過/無答案 → 原樣 allow（CLI 自答「The user did not answer the questions.」，模型自行繼續）。
   * multiSelect 一律單選（v1）；「Other」自由文本不做（用戶可事後追問）。
   */
  private requestAnswers(
    sid: string,
    input: Record<string, unknown>,
    toolUseID?: string,
  ): Promise<PermissionResult> {
    const questions = Array.isArray((input as { questions?: unknown }).questions)
      ? ((input as { questions: unknown[] }).questions as Record<string, unknown>[])
      : [];
    if (!questions.length) return Promise.resolve({ behavior: "allow", updatedInput: input });
    const base = toolUseID || `ask_${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve) => {
      const answers: Record<string, string> = {};
      let remaining = questions.length;
      const finishOne = (question: string, answer: string | null) => {
        if (answer) answers[question] = answer;
        if (--remaining > 0) return;
        const hasAnswers = Object.keys(answers).length > 0;
        resolve({ behavior: "allow", updatedInput: hasAnswers ? { ...input, answers } : input });
      };
      questions.forEach((q, i) => {
        const question = String(q?.question ?? "").slice(0, 500);
        const reqId = `${base}#${i}`;
        this.clarifies.set(reqId, { sid, record: (answer) => finishOne(question, answer) });
        this.emit(sid, "clarify.request", {
          question,
          // Macchiato 對 choices 的形狀約定（見 protocol ClarifyRequestPayload 註釋）:
          // {header?, multiSelect?, options:[{id,label,description?}]}。server 映射成選項卡。
          choices: {
            ...(typeof q?.header === "string" && q.header ? { header: q.header } : {}),
            ...(q?.multiSelect === true ? { multiSelect: true } : {}),
            options: (Array.isArray(q?.options) ? (q.options as Record<string, unknown>[]) : [])
              .slice(0, 8)
              .map((o, j) => ({
                id: String(j),
                label: String(o?.label ?? "").slice(0, 120),
                ...(typeof o?.description === "string" && o.description
                  ? { description: o.description.slice(0, 300) }
                  : {}),
              })),
          },
          request_id: reqId,
        });
      });
    });
  }

  /** §19：E2E 回合結束 → 用戶消息 + 回覆加密成 mirror_append 批（方案 A，同 OpenClaw）。 */
  private sendE2ETurn(sid: string, reply: string): void {
    if (!this.e2e) return;
    const msgs: Record<string, unknown>[] = (this.pendingUser.get(sid) ?? []).map((t) => ({
      role: "user",
      enc: this.e2e!.encryptContent(sid, { text: t }),
    }));
    this.pendingUser.delete(sid);
    if (reply.trim()) msgs.push({ role: "agent", enc: this.e2e.encryptContent(sid, { text: reply }) });
    if (!msgs.length) return;
    this.linkb.send({
      t: "mirror_append",
      agentLinkId: this.linkb.agentLinkId,
      sessions: [{ hermesSessionId: sid, source: "claude-code", e2e: true, messages: msgs }],
    });
    console.log(`· E2E turn → encrypted mirror batch (${sid}, ${msgs.length} messages)`);
  }

  private safeArgs(s: string): Record<string, unknown> {
    try {
      return JSON.parse(s || "{}");
    } catch {
      return { raw: s.slice(0, 500) };
    }
  }

  /** 存檔：v2 = `{v:2, map, cwds}`（#105 起）；舊版是平面 `Record<sid, ccSid>`，讀時兼容。 */
  private loadState(): {
    map: Record<string, string>;
    cwds: Record<string, string>;
    permModes: Record<string, string>;
    models: Record<string, string>;
    pending: string[];
  } {
    try {
      const parsed = JSON.parse(readFileSync(mapPath(), "utf8")) as Record<string, unknown>;
      if (parsed && parsed.v === 2) {
        return {
          map: (parsed.map ?? {}) as Record<string, string>,
          cwds: (parsed.cwds ?? {}) as Record<string, string>,
          permModes: (parsed.permModes ?? {}) as Record<string, string>, // #98
          models: (parsed.models ?? {}) as Record<string, string>, // #143
          pending: Array.isArray(parsed.pending) ? (parsed.pending as string[]) : [], // #200
        };
      }
      return { map: (parsed ?? {}) as Record<string, string>, cwds: {}, permModes: {}, models: {}, pending: [] };
    } catch {
      return { map: {}, cwds: {}, permModes: {}, models: {}, pending: [] };
    }
  }
  private saveMap(): void {
    try {
      mkdirSync(dirname(mapPath()), { recursive: true });
      const tmp = `${mapPath()}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({
          v: 2,
          map: this.map,
          cwds: this.cwds,
          permModes: this.permModes,
          models: this.models,
          pending: [...this.pending], // #200 在途回合
        }),
      );
      renameSync(tmp, mapPath());
    } catch (e) {
      console.error("[session map save failed]", (e as Error).message);
    }
  }
}
