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
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AppServerClient, AppServerDied } from "./appserver";
import { type CwdResolution, resolveCwd } from "../_core/cwd";
import { loadDriveState, saveDriveState, codexPermsFor, CODEX_AUTH_ERR_RE } from "./state";
import { deriveMeta, discoverRollouts } from "./mirror";
import { fallbackTitle, titleMode } from "./titles";
import { materializeAttachment } from "./attachments";
import { formatCodexTurnError, parseModelNeedsNewerCli } from "./turn-errors";
import type { LinkBClient } from "../_core/linkb/client";
import type { E2EKeyStore } from "../_core/e2e/keys";
import {
  canonicalE2EApprovalDisplay,
  dispatchForE2EControl,
  e2eApprovalRequestDigest,
  E2EControlError,
  E2EControlVerifier,
  immutableE2EApprovalSnapshot,
  type E2EControlEnvelopeV1,
  type E2EControlKind,
} from "../_core/e2e/control";
import { e2eControlStorePath } from "../_core/identity";
import { KIND } from "../identity";
import type { Mirror } from "./mirror";
import { formatCommandInvokeLog, logContent, safeErr, shortId, textLen } from "../_core/safe-log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 必须与 iOS E2EControlCrypto.maxPayloadBytes 一致；设备会拒绝更大的解密 JSON。 */
const E2E_APPROVAL_PLAINTEXT_MAX_BYTES = 64 * 1024;

function sameLocalUUID(a: string, b: string): boolean {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  return UUID_RE.test(lowerA) && UUID_RE.test(lowerB) && lowerA === lowerB;
}

/** #279 E2E prompt 解密失敗的用戶可見回執(僅提示語,零內容洩漏;四連接器同文案)。 */
const E2E_DECRYPT_FAIL_WARNING = "無法解密這條消息(設備與連接器的加密密鑰可能失步)——請重試,或重新關閉再開啟本會話的端到端加密。";

const AUTHENTICATED_E2E_CONTROL = Symbol("authenticated-e2e-control");
interface AuthenticatedControlTag {
  kind: E2EControlKind;
  msgId: string;
  envelope: E2EControlEnvelopeV1;
}
type TaggedControlFrame = Record<string, unknown> & {
  [AUTHENTICATED_E2E_CONTROL]?: AuthenticatedControlTag;
};
const E2E_SENSITIVE_METHODS = new Set([
  "command.invoke",
  "approval.respond",
  "clarify.respond",
  "secret.respond",
  "session.create",
  "session.interrupt",
  "task.stop",
  "session.e2e.disable",
  "session.delete",
  "session.rename",
  "session.archive",
  "session.retitle",
  // #473 rewind 是破壞性寫(fork 重指線程),E2E 下不認 server 裸帧(server v1 也直接拒 E2E)。
  "session.rewind",
]);



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

/** #895 回合看門狗(與 exec v1 同 env / 默認)。活動式;掛起審批時豁免。 */
function turnStallMs(): number {
  const v = Number(process.env.MACCHIATO_CODEX_TURN_STALL_MS);
  if (Number.isFinite(v) && v >= 0) return v;
  return 30 * 60_000;
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

/** app-server 的 UserInput(schema 0.144.1;skill 臂 #317)。 */
type UserInput =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string };

interface ActiveTurn {
  threadId: string;
  turnId?: string;
  started: boolean; // message.start 已發
  /** #393 本回合 prompt 文本(回填 user 消息 srcId 時文本匹配 rollout 的 user_message 行)。 */
  userText: string;
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
  /** #245 interrupt 點在 turnId 未到位的窗口 → 掛起,turnId 到位即補發。 */
  interruptPending?: boolean;
  /** 本回合完整 input(模型版本失敗時可靜默換模重試,不讓用戶重發)。 */
  input?: UserInput[];
  /** 本回合 turn/start 實際帶上的 model(空 = 未指定,走 CLI 默認)。 */
  modelUsed?: string;
  /** 已因「模型需更新 CLI」自動降級重試過一次——防死循環。 */
  modelFallbackTried?: boolean;
  /** #895 看門狗:最近一次 app-server 通知時刻。 */
  lastActivityAt: number;
  /** #895 看門狗 timer。 */
  watchdog?: ReturnType<typeof setTimeout>;
  /** #895 已由看門狗強制收尾——晚到的 turn/completed 不再二次 finish。 */
  finalized?: boolean;
}

type CodexApprovalKind = "command" | "fileChange";
type CodexApprovalExecutionSnapshot = {
  v: 1;
  connector: "codex-app-server";
  sessionId: string;
  requestId: string;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval";
  params: Record<string, unknown>;
};

function codexApprovalExecutionRequest(
  sid: string,
  requestId: string,
  kind: CodexApprovalKind,
  params: Record<string, unknown>,
): CodexApprovalExecutionSnapshot {
  return {
    v: 1,
    connector: "codex-app-server",
    sessionId: sid,
    requestId,
    method:
      kind === "command"
        ? "item/commandExecution/requestApproval"
        : "item/fileChange/requestApproval",
    params,
  };
}

interface PendingApproval {
  sid: string;
  /** #245 反向請求的 itemId(隨 approval.request 的 request_id 上行;respond 回帶則精準配對)。 */
  requestId?: string;
  /** #370 E2E 审批必须同时绑定请求摘要；非 E2E 保持 undefined。 */
  requestDigest?: string;
  /** digest、密文卡片以及该 reverse RPC decision 绑定的 immutable 完整请求。 */
  executionSnapshot?: CodexApprovalExecutionSnapshot;
  /** 仅用于执行前确认 AppServer 回调对象自请求后未发生 mutation。 */
  sourceParams?: Record<string, unknown>;
  kind?: CodexApprovalKind;
  resolve: (decision: string) => void;
}

export class AppServerDrive {
  /** #10:累計計數(與 v1 同鍵位,健康上報帶出)。engineAppServer=1 是引擎標記(v1 無此鍵)。 */
  readonly counters: Record<string, number> = { driveErrors: 0, approvalsRequested: 0, steers: 0, engineAppServer: 1, unknownNotifications: 0 };
  /** #310 認證失效持續態:auth 類回合失敗置 true(health 上報 authOk=false),成功回合恢復。 */
  authFailed = false;
  /** #669 心跳:有進行中回合(在途 sid 集非空)。為「閒時更新」預留,本階段只寫進 health.json。 */
  get busy(): boolean {
    return this.pending.size > 0;
  }
  /** #669 心跳:有待用戶審批的工具調用(approval.respond 解掛前)。 */
  get hasPendingApproval(): boolean {
    for (const list of this.approvals.values()) if (list.length > 0) return true;
    return false;
  }
  /** #258 已告警過的未知通知 method(去重,不刷屏)。 */
  private readonly loggedUnknownNotif = new Set<string>();
  /**
   * 本進程已知「需更新 CLI 才能跑」的 model id。turn/start 不再帶上,避免用戶連發三條都撞同一牆。
   * 進程級即可:CLI 升級後連接器重啟/health 重探會清空。
   */
  private readonly modelsBlockedByCliVersion = new Set<string>();
  private map: Record<string, string>;
  private cwds: Record<string, string>;
  private models: Record<string, string>;
  private efforts: Record<string, string>; // #231
  /** #230 serverSid → 會話 permissionMode(映射為 codex sandbox + approvalPolicy)。 */
  private perms: Record<string, string>;
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
  /** #224 自己 thread/name/set 寫過的 threadId→title(抑制回聲 thread/name/updated 重投 session.title)。 */
  private readonly renamedTitles = new Map<string, string>();
  /** 僅主身份快照完整解析，或已把當前完整映射成功雙寫，才可放行非 UUID E2E wire sid。 */
  private identityStateTrusted: boolean;
  private readonly e2eControl?: E2EControlVerifier;
  private readonly e2eQuiescing = new Map<
    string,
    { requestId: string; mode: "enable" | "disable" }
  >();
  private readonly contentInflight = new Set<string>();

  constructor(
    private readonly client: AppServerClient,
    private readonly linkb: LinkBClient,
    private readonly mirror?: Mirror,
    private readonly e2e?: E2EKeyStore,
    /** #227 回合末惰性版本化鉤子。 */
    private readonly projects?: { checkTurnEnd(): void },
    /** #317 skills 索引(name→SKILL.md 路徑),command.invoke 組 SkillUserInput 用。 */
    private readonly skills?: { pathFor(name: string): string | undefined },
    e2eControl?: E2EControlVerifier,
  ) {
    const st = loadDriveState();
    this.map = st.map;
    this.cwds = st.cwds;
    this.models = st.models;
    this.efforts = st.efforts;
    this.perms = st.perms;
    this.titled = st.titled;
    this.identityStateTrusted = st.identityStateTrusted;
    this.abandonedTurns = st.pending;
    this.pending = new Set();
    this.e2eControl = e2eControl ?? (e2e ? new E2EControlVerifier(e2e, e2eControlStorePath(KIND)) : undefined);
    // 影子兜底:啟動時把既有 wire→local 映射的 thread uuid 全灌給鏡像(跨重啟持久),鏡像據此
    // 永不給這些「被驅動過」的 thread 單獨建明文會話(重啟後內存態丟失也不復發)。
    for (const localSid of Object.values(this.map)) this.mirror?.markDrivenUuid?.(localSid);
    if (st.pending.length) this.saveMap();

    this.client.onNotification((m, p) => this.onNotification(m, p));
    this.client.onReverseRequest("item/commandExecution/requestApproval", (p) => this.onApprovalRequest(p, "command"));
    this.client.onReverseRequest("item/fileChange/requestApproval", (p) => this.onApprovalRequest(p, "fileChange"));
    // app-server 死了重啟:活躍回合已隨進程死 → 清盤 + 對用戶明說(不靜默吞)。
    this.client.onRestart = () => this.onServerRestart();
  }

  wire(): void {
    this.linkb.onFrame((m) => {
      const frame = m.frame as { method?: string; params?: { session_id?: string } } | undefined;
      const sid = (m.sessionId ?? frame?.params?.session_id) as string | undefined;
      const content = frame?.method === "prompt.submit" || frame?.method === "command.invoke";
      if (content && sid && this.e2eQuiescing.has(sid)) {
        console.error(`[E2E quiesce ${sid}] rejected late ${frame?.method}`);
        return;
      }
      if (content && sid) this.contentInflight.add(sid);
      void this.onServerFrame(m).finally(() => {
        if (content && sid) this.contentInflight.delete(sid);
      });
    });
  }

  applyE2EQuiesceState(
    sessions: Array<{ hermesSessionId: string; pendingOp: "enable" | "disable" | null }>,
  ): void {
    const pending = new Map(
      sessions
        .filter((session) => session.pendingOp !== null)
        .map((session) => [session.hermesSessionId, session.pendingOp as "enable" | "disable"]),
    );
    for (const sid of this.e2eQuiescing.keys()) if (!pending.has(sid)) this.e2eQuiescing.delete(sid);
    for (const [sid, mode] of pending) this.e2eQuiescing.set(sid, { requestId: `ready:${mode}`, mode });
  }

  beginE2ETransition(sid: string, mode: "enable" | "disable"): void {
    const current = this.e2eQuiescing.get(sid);
    this.e2eQuiescing.set(sid, { requestId: current?.requestId ?? `resume:${mode}`, mode });
  }

  releaseE2EQuiesce(sid: string, mode?: "enable" | "disable", requestId?: string): void {
    const current = this.e2eQuiescing.get(sid);
    if (!current || (mode && current.mode !== mode) || (requestId && current.requestId !== requestId)) return;
    this.e2eQuiescing.delete(sid);
  }

  async quiesceE2E(sid: string, mode: "enable" | "disable", requestId: string): Promise<boolean> {
    const current = this.e2eQuiescing.get(sid);
    if (current && current.requestId !== requestId) return false;
    this.e2eQuiescing.set(sid, { requestId, mode });
    const configured = Number(process.env.MACCHIATO_E2E_QUIESCE_MS);
    const deadline = Date.now() + (Number.isFinite(configured) && configured > 0 ? configured : 4 * 60_000);
    while (
      this.pending.has(sid) ||
      this.active.has(sid) ||
      this.contentInflight.has(sid)
    ) {
      if (Date.now() >= deadline) {
        this.releaseE2EQuiesce(sid, mode, requestId);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.e2eQuiescing.get(sid)?.requestId === requestId;
  }

  dispose(): void {
    for (const t of this.active.values()) this.clearTurnWatchdog(t);
    this.client.close();
  }

  /**
   * #895 回合看門狗:引擎活着但連續無通知達 stall → 強制 interrupted 收尾。
   * 否則 active 永佔 → 後續 prompt 靜默排隊;server stream GC 後停止鍵消失。
   * 掛起審批豁免(等用戶點卡不是卡死)。
   */
  private armTurnWatchdog(sid: string, turn: ActiveTurn): void {
    this.clearTurnWatchdog(turn);
    const stall = turnStallMs();
    if (!stall) return;
    const due = turn.lastActivityAt + stall - Date.now();
    turn.watchdog = setTimeout(() => {
      turn.watchdog = undefined;
      if (turn.finalized || this.active.get(sid) !== turn) return;
      // 審批卡掛起 / 期間有活動 → 沒卡,重排
      if ((this.approvals.get(sid)?.length ?? 0) > 0 || Date.now() - turn.lastActivityAt < stall) {
        this.armTurnWatchdog(sid, turn);
        return;
      }
      this.forceFinalizeStuck(sid, turn, stall);
    }, Math.max(due, 25));
    turn.watchdog.unref?.();
  }

  private clearTurnWatchdog(turn: ActiveTurn): void {
    if (turn.watchdog) {
      clearTimeout(turn.watchdog);
      turn.watchdog = undefined;
    }
  }

  /** #895 卡死回合強制收尾(best-effort interrupt + 本地定稿 interrupted)。 */
  private forceFinalizeStuck(sid: string, turn: ActiveTurn, stall: number): void {
    this.clearTurnWatchdog(turn);
    if (turn.finalized || this.active.get(sid) !== turn) return;
    console.error(
      `[turn watchdog] ${sid} 回合 ${Math.round(stall / 1000)}s 無任何通知 → 判定卡死,強制中斷`,
    );
    this.interruptedSids.add(sid);
    if (turn.turnId) {
      void this.client
        .request("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId })
        .catch(() => {
          /* 引擎若也掛了,本地定稿仍要走 */
        });
    }
    if (!turn.isE2E) {
      this.emit(sid, "review.summary", {
        summary: "⚠️ 回合長時間無響應，已判定卡死並中斷——請重試。",
      });
    }
    this.finishTurn(sid, turn, { status: "interrupted" });
  }

  /**
   * #200 + #489 F-12:優先從本地 rollout 只讀補撈已落盤 agent 內容；失敗回退「請重發」。
   * **絕不**自動重投 prompt（副作用雙投雷）。冪等。index.ts 在 ready 後調。
   */
  flushAbandonedTurns(): void {
    const sids = this.abandonedTurns;
    this.abandonedTurns = [];
    for (const sid of sids) {
      if (this.e2e?.isE2E(sid)) continue;
      let salvaged = false;
      try {
        const local = this.localSessionIdFor(sid);
        if (local && this.mirror) salvaged = this.mirror.salvageCrash(local, sid);
      } catch (e) {
        console.error(`[F-12 salvage ${sid}] ${(e as Error).message}`);
      }
      this.emit(sid, "review.summary", {
        summary: salvaged
          ? "♻️ 連接器剛重啟——已從本地 rollout 補撈已落盤內容（未自動重跑，避免副作用雙投）。若仍不完整，請先檢查後再決定是否手動重發。"
          : "⚠️ 連接器剛重啟,上一條消息可能沒跑完——請重發一次。",
      });
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

  /**
   * #473 把該會話回退到 targetSrcId 這條用戶消息之前。
   *
   * codex 的最小回退單位是**回合**(`thread/fork` + `lastTurnId`,inclusive 保留)——同回合裡
   * 目標之前的消息會被一起截掉,所以把實際截斷起點(`cutSrcId`)回報給 server,讓它把自己的
   * 刪行對齊到 agent 真正忘掉的位置,否則 UI 留着 AI 已不記得的消息。
   *
   * 順序(cc 同款教訓,一步都不能亂):
   *  1. 回合進行中不動(fork 的 lastTurnId 也不接受 in-progress 回合);
   *  2. fork 出新 thread 後**立刻** mirror.adoptForked——水位不坐到 EOF,下一輪 poll 會把
   *     複製過去的整段歷史當新消息重灌;
   *  3. 舊 thread 記墓碑:它已不代表這個會話,若用戶日後在終端 resume 它,鏡像絕不能把
   *     「被回退掉的舊世界線」再灌回 app(rollout 檔本身不動,#161 語義);
   *  4. 最後才重指 map(下個 prompt resume 新 thread)。
   *
   * 目標在第一個回合 → 沒有回合可保留(省略 lastTurnId = 全量複製,正好相反)→ 丟映射,
   * 下個 prompt 自然開全新會話。
   */
  private async rewindSession(
    sid: string,
    targetSrcId: string,
  ): Promise<{ ok: boolean; rewound?: number; fromSrcId?: string; error?: "unsupported" | "not_found" | "busy" | "failed" }> {
    const tid = this.threadFor(sid);
    if (!tid || !targetSrcId) return { ok: false, error: "not_found" };
    if (this.active.has(sid)) return { ok: false, error: "busy" };
    const plan = this.mirror?.rewindPlan?.(tid, targetSrcId) ?? null;
    if (!plan) return { ok: false, error: "not_found" };

    if (plan.lastTurnId === null) {
      this.mirror?.tombstone(tid);
      this.byThread.delete(tid);
      this.loadedThreads.delete(tid);
      delete this.map[sid];
      this.saveMap();
      console.log(`· session.rewind ${sid} → 目標在首回合,丟映射(下個 prompt 開新會話;舊 thread ${tid} 墓碑)`);
      return { ok: true, rewound: 0, fromSrcId: plan.cutSrcId };
    }

    let forked: string;
    try {
      const res = await this.client.request("thread/fork", {
        threadId: tid,
        lastTurnId: plan.lastTurnId,
        cwd: this.cwdFor(sid),
      });
      forked = String((res as { thread?: { id?: unknown } })?.thread?.id ?? "");
    } catch (e) {
      console.error(`[session.rewind ${sid} fork 失敗] ${String(e).slice(0, 200)}`);
      return { ok: false, error: "failed" };
    }
    if (!forked) return { ok: false, error: "failed" };

    this.mirror?.adoptForked?.(forked); // ⚠️ 必須先於 map 落盤:防歷史重灌
    this.mirror?.tombstone(tid); // 舊世界線永不再撈(rollout 檔不動)
    this.byThread.delete(tid);
    this.loadedThreads.delete(tid);
    this.loadedThreads.delete(forked); // 下個 prompt 走 thread/resume 從磁盤載入,不信 fork 的記憶體態
    this.map[sid] = forked;
    this.byThread.set(forked, sid);
    this.mirror?.markDrivenUuid?.(forked);
    this.saveMap();
    console.log(`· session.rewind ${sid} → fork ${forked}(保留至回合 ${plan.lastTurnId};舊 ${tid} 墓碑)`);
    return { ok: true, fromSrcId: plan.cutSrcId };
  }

  private threadFor(sid: string): string | undefined {
    if (UUID_RE.test(sid)) return sid;
    return this.map[sid];
  }

  /** E2E backfill 的本地 rollout 身份；wire sid 由控制層原樣保留。 */
  localSessionIdFor(sid: string): string | undefined {
    return this.threadFor(sid);
  }

  private protectedWireSids(): string[] {
    const fn = (this.e2e as (E2EKeyStore & { protectedSessionIds?: () => string[] }) | undefined)
      ?.protectedSessionIds;
    return typeof fn === "function" ? fn.call(this.e2e) : [];
  }

  /** 禁止用 protected wire sid 对应的本地 thread UUID 另开明文身份直达同一线程。 */
  private protectedInboundAliasOwner(sid: string): string | undefined {
    return this.protectedWireSids().find((wireSid) => {
      if (wireSid === sid) return false;
      if (sameLocalUUID(wireSid, sid)) return true;
      const localSid = this.map[wireSid];
      return localSid !== undefined && (localSid === sid || sameLocalUUID(localSid, sid));
    });
  }

  /** 見 exec Drive 同名方法：壞/缺 sid↔thread 身份快照時禁止任何 plaintext fallback。 */
  assertE2EIdentitySafe(allowMissingSids: ReadonlySet<string> = new Set()): void {
    const requiringMap = this.protectedWireSids().filter(
      (sid) => !allowMissingSids.has(sid) && !UUID_RE.test(sid),
    );
    if (!requiringMap.length) return;
    const missing = requiringMap.filter((sid) => !UUID_RE.test(this.map[sid] ?? ""));
    if (!this.identityStateTrusted || missing.length) {
      throw new Error(
        `Codex E2E identity map unavailable/incomplete (trusted=${this.identityStateTrusted}, ` +
          `missing=${missing.slice(0, 3).join(",") || "unknown"}); refusing plaintext fallback`,
      );
    }
  }

  plaintextLocalMirrorAllowed(): boolean {
    try {
      this.assertE2EIdentitySafe();
      return true;
    } catch {
      return false;
    }
  }

  /** Mirror 的本地 UUID → E2E wire ULID 反向解析；只回傳仍受 E2E 保護的映射。 */
  e2eWireSessionIdFor(localSid: string): string | undefined {
    if (!this.e2e) return undefined;
    for (const [wireSid, mappedLocalSid] of Object.entries(this.map)) {
      if (mappedLocalSid === localSid && this.e2e.isE2E(wireSid)) return wireSid;
    }
    return undefined;
  }

  /** history import 的本地 UUID → wire sid E2E 判定快照；任一關聯 wire 為 E2E 即過濾。 */
  localSessionE2EStatus(): { isE2E(localSid: string): boolean } {
    const e2e = this.e2e;
    if (!e2e) return { isE2E: () => false };
    try {
      this.assertE2EIdentitySafe();
    } catch {
      return { isE2E: () => true };
    }
    const protectedLocal = new Set<string>();
    for (const [wireSid, localSid] of Object.entries(this.map)) {
      if (e2e.isE2E(wireSid)) protectedLocal.add(localSid);
    }
    return {
      isE2E: (localSid: string) => protectedLocal.has(localSid) || e2e.isE2E(localSid),
    };
  }

  /** #377 解析+校驗會話工作目錄(realpath/存在性/目錄/可選 allowlist;見 cwd.ts)。 */
  private resolveSessionCwd(sid: string): CwdResolution {
    return resolveCwd(KIND, this.cwds[sid]);
  }

  /** ok 時回 realpath 規範路徑,否則回嘗試路徑(供提示/比對)。 */
  private cwdFor(sid: string): string {
    return this.resolveSessionCwd(sid).cwd;
  }
  private modelFor(sid: string): string | undefined {
    const raw = this.models[sid] || process.env.MACCHIATO_CODEX_MODEL || undefined;
    if (!raw) return undefined;
    // 已知本機 CLI 跑不動 → 省略,讓 Codex 用其默認(或用戶之後手動換模)
    if (this.modelsBlockedByCliVersion.has(raw)) return undefined;
    return raw;
  }
  private effortFor(sid: string): string | undefined {
    return this.efforts[sid] || process.env.MACCHIATO_CODEX_EFFORT || undefined; // #231
  }
  /** #230 per-session sandbox/approval:permissionMode 映射優先(三檔),否則回退進程級 env 默認。
   *  注:app-server 的 sandbox/approval 在 thread start/resume 時定;會話啟動後再改要等線程重載才生效。 */
  private sandboxFor(sid: string): string {
    return codexPermsFor(this.perms[sid])?.sandbox ?? sandboxMode();
  }
  private approvalFor(sid: string): string {
    return codexPermsFor(this.perms[sid])?.approval ?? approvalPolicy();
  }

  // ============================== 下行(server → 連接器) ==============================

  private sendE2EControlResult(
    rawEnvelope: unknown,
    wireSid: string,
    ok: boolean,
    error?: "control_rejected" | "side_effect_failed",
  ): void {
    if (rawEnvelope === null || typeof rawEnvelope !== "object" || Array.isArray(rawEnvelope)) return;
    const envelope = rawEnvelope as Partial<E2EControlEnvelopeV1>;
    if (typeof envelope.sessionId !== "string" || !envelope.sessionId) return;
    if (typeof envelope.msgId !== "string" || !envelope.msgId) return;
    this.linkb.send({
      t: "e2e_control_result",
      agentLinkId: this.linkb.agentLinkId,
      sessionId: envelope.sessionId,
      hermesSessionId: wireSid,
      msgId: envelope.msgId,
      ok,
      ...(error ? { error } : {}),
    });
  }

  private async onE2EControl(wireSid: string, rawEnvelope: unknown): Promise<void> {
    let dispatchStarted = false;
    try {
      if (!this.e2eControl) throw new E2EControlError("E2E control verifier unavailable");
      const verified = this.e2eControl.verifyAndConsume(rawEnvelope, wireSid);
      if (
        verified.kind === "clarify.respond" ||
        verified.kind === "secret.respond" ||
        verified.kind === "task.stop"
      ) {
        throw new E2EControlError(`${verified.kind} is not supported by Codex`);
      }
      const dispatch = dispatchForE2EControl(verified.kind, verified.payload);
      if (verified.kind === "command.invoke" && typeof dispatch.params.argsEnc === "string") {
        if (!this.e2e) throw new E2EControlError("E2E command decryptor unavailable");
        try {
          dispatch.params.args = this.e2e.decryptText(wireSid, dispatch.params.argsEnc);
          delete dispatch.params.argsEnc;
        } catch (error) {
          throw new E2EControlError("failed to decrypt authenticated command args", {
            cause: error,
          });
        }
      }
      const tagged: TaggedControlFrame = {
        t: "tui",
        sessionId: wireSid,
        frame: {
          jsonrpc: "2.0",
          method: dispatch.method,
          params: { session_id: wireSid, ...dispatch.params },
        },
        [AUTHENTICATED_E2E_CONTROL]: {
          kind: verified.kind,
          msgId: verified.envelope.msgId,
          envelope: verified.envelope,
        },
      };
      dispatchStarted = true;
      await this.onServerFrame(tagged);
      this.sendE2EControlResult(verified.envelope, wireSid, true);
    } catch (error) {
      console.error(`[E2E control rejected ${wireSid}]`, error instanceof Error ? error.message : String(error));
      this.sendE2EControlResult(
        rawEnvelope,
        wireSid,
        false,
        dispatchStarted ? "side_effect_failed" : "control_rejected",
      );
    }
  }

  async onServerFrame(msg: Record<string, unknown>): Promise<void> {
    if (msg.t !== "tui" || !msg.frame) return;
    const frame = msg.frame as { method?: string; params?: Record<string, unknown> };
    const params = frame.params ?? {};
    const outerSid = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
    const paramsSid = typeof params.session_id === "string" ? params.session_id : undefined;
    if (
      (msg.sessionId !== undefined && !outerSid) ||
      (params.session_id !== undefined && !paramsSid) ||
      (outerSid && paramsSid && outerSid !== paramsSid)
    ) {
      console.error(
        `[drive2 rejected] Link B outer/params session mismatch: ${String(msg.sessionId)} != ${String(params.session_id)}`,
      );
      return;
    }
    const sid = outerSid ?? paramsSid;
    if (!sid || !frame.method) return;
    let aliasOwner: string | undefined;
    try {
      aliasOwner = this.protectedInboundAliasOwner(sid);
    } catch (error) {
      console.error(
        `[E2E inbound quarantined ${sid}] ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (aliasOwner) {
      console.error(`[E2E local alias rejected ${sid}] canonical wire session is ${aliasOwner}`);
      return;
    }
    const authenticated = (msg as TaggedControlFrame)[AUTHENTICATED_E2E_CONTROL];
    if (frame.method === "e2e.control") {
      if (authenticated || !outerSid || !paramsSid) return;
      await this.onE2EControl(sid, params.envelope);
      return;
    }
    try {
      if (
        this.e2e?.isE2E(sid) &&
        E2E_SENSITIVE_METHODS.has(frame.method) &&
        authenticated === undefined
      ) {
        console.error(`[E2E legacy control rejected ${sid}] ${frame.method}`);
        return;
      }
      switch (frame.method) {
        case "prompt.submit": {
          await this.onPrompt(sid, params);
          return;
        }
        case "command.invoke": {
          // #317 skill 調用(composer / 菜單選中):組原生 SkillUserInput {type:"skill",name,path}
          // (schema 0.144.1;path 從 SkillsReporter 索引拿),args 附 text 項。索引未命中(skill
          // 已刪/改名/枚舉未跑)→ 回退 `$name` 文本(codex 原生 mention 語法),消息不丟。
          // E2E:invoke 幀本就明文(#199 既定設計),命令文本記入 pendingUser 供回合末密文回灌。
          const name = String(params.command ?? "")
            .trim()
            .replace(/^\//, "");
          if (!name) return;
          const args = String(params.args ?? "").trim();
          const path = this.skills?.pathFor(name);
          const input: UserInput[] = path
            ? [{ type: "skill", name, path }, ...(args ? [{ type: "text", text: args } as UserInput] : [])]
            : [{ type: "text", text: `$${name}${args ? ` ${args}` : ""}` }];
          const display = `/${name}${args ? ` ${args}` : ""}`;
          if (this.e2e?.isE2E(sid)) {
            const arr = this.pendingUser.get(sid) ?? [];
            arr.push(display);
            this.pendingUser.set(sid, arr);
          }
          // #381:默认日志只记命令名 + args 长度 + 截断 id,绝不写 args/prompt 正文
          console.log(
            formatCommandInvokeLog({
              tag: "#317",
              name,
              argsLen: args.length,
              sid,
              e2e: authenticated !== undefined,
              extra: path ? undefined : "fallback=$name",
            }),
          );
          logContent("command.invoke", display);
          await this.dispatchInput(sid, input, display, authenticated !== undefined);
          return;
        }
        case "approval.respond": {
          // 審批卡回話 → 解掛反向請求。#245:優先按 request_id(=itemId)精準配對——codex 並行
          // 工具下同會話可同掛多個審批(command+fileChange 交錯),純 FIFO 會把回話錯配到先掛的
          // 請求(批錯命令);缺省回退 FIFO(舊 server 兼容,CC #102 同款)。allow+all →
          // acceptForSession(codex 原生會話級審批緩存);deny → decline(agent 收到拒絕並繼續)。
          const list = this.approvals.get(sid);
          if (!list?.length) {
            this.approvals.delete(sid);
            if (authenticated) throw new E2EControlError("no matching pending approval");
            return;
          }
          const reqId = typeof params.request_id === "string" ? params.request_id : "";
          const reqDigest = typeof params.requestDigest === "string" ? params.requestDigest : "";
          let p: PendingApproval | undefined;
          if (authenticated) {
            if (authenticated.kind !== "approval.respond" || !reqId || !reqDigest) {
              throw new E2EControlError("authenticated approval is missing request identity");
            }
            const i = list.findIndex(
              (item) => {
                if (
                  item.requestId !== reqId ||
                  item.requestDigest !== reqDigest ||
                  item.executionSnapshot === undefined ||
                  item.sourceParams === undefined ||
                  item.kind === undefined
                ) {
                  return false;
                }
                const key = this.e2e!.requireKey(sid);
                // 同时核验 immutable snapshot 与当前 reverse-RPC 对象；后者若被回调方修改，
                // 即使已签旧 digest 也不能放行。
                return (
                  e2eApprovalRequestDigest(key, item.executionSnapshot) === reqDigest &&
                  e2eApprovalRequestDigest(
                    key,
                    codexApprovalExecutionRequest(
                      sid,
                      reqId,
                      item.kind,
                      item.sourceParams,
                    ),
                  ) === reqDigest
                );
              },
            );
            if (i >= 0) p = list.splice(i, 1)[0];
            if (!p) throw new E2EControlError("approval request id/digest mismatch");
          } else {
            if (reqId) {
              const i = list.findIndex((x) => x.requestId === reqId);
              if (i >= 0) p = list.splice(i, 1)[0];
            }
            p ??= list.shift();
          }
          if (!list.length) this.approvals.delete(sid);
          if (!p) return;
          const choice = String(params.choice ?? "deny");
          // #359 審批選擇映射(對齊 CC drive.ts):yes/allow/always → 放行;no/deny/未知 → decline
          // (choice 缺省即 "deny",故未知值 fail-closed 落到 decline)。always 即使 server 未回帶
          // all(REST 通知快捷入口寫死 all=false、web WS 根本不發 all)也要走會話級授權——靠 choice
          // 自身判定,不再依賴 all。舊 all=true 路徑保留兼容。
          const allow = choice === "allow" || choice === "always" || choice === "yes";
          const always = allow && (params.all === true || choice === "always");
          p.resolve(allow ? (always ? "acceptForSession" : "accept") : "decline");
          return;
        }
        case "session.interrupt": {
          const t = this.active.get(sid);
          if (!t) {
            if (authenticated) throw new E2EControlError("no active turn to interrupt");
            return;
          }
          this.interruptedSids.add(sid);
          if (t.turnId) {
            await this.client.request("turn/interrupt", { threadId: t.threadId, turnId: t.turnId });
            // ⚠️ 回歸契約:scripts/regression/run-codex-regression.mjs 斷言「turn/interrupt → 」,改動需同步
            console.log(`· turn/interrupt → ${sid}`);
          } else {
            // #245:turn/start 未返回的窗口點停止,舊實現靜默吞掉 → turnId 到位即補發
            t.interruptPending = true;
            console.log(`· interrupt 掛起(turnId 未到位,到位即補發)→ ${sid}`);
          }
          return;
        }
        case "session.e2e.disable": {
          if (authenticated?.kind !== "session.e2e.disable") {
            throw new E2EControlError("session.e2e.disable requires authenticated control");
          }
          if (!this.e2e || !this.mirror) {
            throw new E2EControlError("E2E disable dependencies unavailable");
          }
          this.assertE2EIdentitySafe();
          this.e2e.markServerE2E(sid, "disable");
          this.e2e.beginDisable(sid, authenticated.envelope);
          await this.mirror.backfillE2E(sid, this.localSessionIdFor(sid), "disable");
          return;
        }
        case "session.delete": {
          const tid = this.threadFor(sid);
          if (tid) this.mirror?.tombstone(tid); // #161 墓碑;不刪 rollout
          return;
        }
        case "session.rewind": {
          // #473 回退到某條用戶消息之前。server 在等 ACK——它只有收到 ok 才刪自己的行,
          // 所以無論成敗都必須回一幀,否則它 30s 超時判失敗、用戶白等。
          const requestId = typeof params.request_id === "string" ? params.request_id : "";
          const targetSrcId = typeof params.target_src_id === "string" ? params.target_src_id : "";
          void this.rewindSession(sid, targetSrcId)
            .catch(() => ({ ok: false as const, error: "failed" as const }))
            .then((r) =>
              this.linkb.send({
                t: "rewind_result",
                agentLinkId: this.linkb.agentLinkId,
                hermesSessionId: sid,
                requestId,
                ok: r.ok,
                ...(r.ok
                  ? { rewound: r.rewound ?? 0, ...(r.fromSrcId ? { fromSrcId: r.fromSrcId } : {}) }
                  : { error: r.error ?? "failed" }),
              }),
            );
          return;
        }
        case "session.rename": {
          // #224 改名回寫:app 改標題 → thread/name/set,codex 本地(TUI /resume 列表)看到同名。
          // 僅 app-server 引擎有此能力(exec drive 無此 case,靜默跳過)。無 thread(尚未建會話)→ 跳過。
          const tid = this.threadFor(sid);
          const title = typeof params.title === "string" ? params.title.trim() : "";
          if (tid && title) {
            try {
              await this.client.request("thread/name/set", { threadId: tid, name: title });
              this.renamedTitles.set(tid, title); // 標記自寫,回聲的 thread/name/updated 不再回投
              // #381:标题正文不落默认日志
              console.log(`· #224 thread/name/set ${shortId(tid)} len=${textLen(title)}`);
              logContent("thread/name/set", title);
            } catch (e) {
              console.error(`[#224 thread/name/set failed ${shortId(tid)}] ${safeErr(e)}`);
            }
          }
          return;
        }
        case "session.retitle": {
          // #257 app「重新生成標題」:codex 無 LLM 標題(截斷哲學)→ 從 rollout 首條 user 消息
          // 重算 fallbackTitle 並回投。此前無此 case、對 codex 是靜默 no-op。E2E 跳過(標題明文)。
          if (this.e2e?.isE2E(sid)) return;
          const tid = this.threadFor(sid);
          if (!tid) return;
          try {
            const rf = discoverRollouts().rollouts.find((r) => r.threadId === tid);
            if (!rf || !existsSync(rf.file)) return;
            const { title } = deriveMeta(readFileSync(rf.file, "utf8"));
            if (title && title !== "Codex") {
              this.emit(sid, "session.title", { title });
              console.log(`· #257 session.retitle ${shortId(sid)} len=${textLen(title)}`);
              logContent("session.retitle", title);
            }
          } catch (e) {
            console.error(`[#257 retitle failed ${shortId(sid)}] ${safeErr(e)}`);
          }
          return;
        }
        case "session.archive":
          // #257 codex 無歸檔概念(不像 Hermes 有 state.db archived 列)——明確 no-op,不落 default。
          return;
        case "session.create": {
          const partial = authenticated !== undefined;
          if (!partial || Object.hasOwn(params, "cwd")) {
            const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
            this.persistSessionSetting(this.cwds, sid, cwd, authenticated, "cwd");
          }
          if (!partial || Object.hasOwn(params, "model")) {
            const md = typeof params.model === "string" ? params.model.trim() : "";
            this.persistSessionSetting(this.models, sid, md, authenticated, "model");
          }
          if (!partial || Object.hasOwn(params, "effort")) {
            const ef = typeof params.effort === "string" ? params.effort.trim() : ""; // #231
            this.persistSessionSetting(this.efforts, sid, ef, authenticated, "effort");
          }
          // #230 permissionMode(upsert)。空 = 回退進程級 env 默認。
          if (!partial || Object.hasOwn(params, "permissionMode")) {
            const pm = typeof params.permissionMode === "string" ? params.permissionMode.trim() : "";
            this.persistSessionSetting(this.perms, sid, pm, authenticated, "permissionMode");
          }
          const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
          if (cwd && !this.e2e?.isE2E(sid)) {
            const res = this.resolveSessionCwd(sid);
            if (!res.ok) this.emit(sid, "review.summary", { summary: `⚠️ ${res.reason}（連接器主機上）` });
          }
          return;
        }
        default:
          return;
      }
    } catch (e) {
      this.counters.driveErrors += 1;
      console.error(`[drive2 ${frame.method} failed for ${sid}] ${(e as Error).message}`);
      if (authenticated) throw e;
    }
  }

  private async onPrompt(sid: string, params: Record<string, unknown>): Promise<void> {
    let text = String(params.text ?? "").trim();
    const atts = Array.isArray(params.attachments)
      ? (params.attachments as Array<{ id?: string; kind?: string; name?: string; mime?: string; url?: string }>)
      : [];
    // E2E 附件没有端到端密文/完整性协议；在任何 STT、网络或落盘副作用前拒绝整帧。
    if (atts.length && this.e2e?.isE2E(sid)) {
      console.error(`[E2E prompt rejected ${sid}] attachments are not supported`);
      return;
    }
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
        // #859 視頻：無原生視頻輸入 → 路徑注入 + ffmpeg 抽幀提示。
        const mime = String(a.mime ?? "?");
        if (a.kind === "image") images.push({ type: "localImage", path: p });
        else if (a.kind === "video" || mime.toLowerCase().startsWith("video/")) {
          attachNotes.push(
            `[Macchiato 視頻 ${a.name ?? "file"}(${mime})已保存到:${p}。模型通常不能直接讀視頻，可用 ffmpeg 抽幀後查看，例如: ffmpeg -i ${p} -vf fps=1/5 frame_%03d.jpg]`,
          );
        } else attachNotes.push(`[Macchiato 附件 ${a.name ?? "file"}(${mime})已保存到:${p}]`);
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
        // #279:靜默丟=用戶氣泡「已發送」卻永無回應。回 error 終態回合(僅提示語,零內容洩漏)。
        this.emit(sid, "message.start", {});
        this.emit(sid, "message.complete", { text: "", status: "error", warning: E2E_DECRYPT_FAIL_WARNING });
        return;
      }
      if (!text && !images.length) return;
      const arr = this.pendingUser.get(sid) ?? [];
      arr.push(text);
      this.pendingUser.set(sid, arr);
    }
    if (attachNotes.length) text = [text, ...attachNotes].filter(Boolean).join("\n\n");
    const input: UserInput[] = [...(text ? [{ type: "text", text } as UserInput] : []), ...images];
    // #552 回合中發送的顯式模式;未知值防禦性忽略(= 歷史默認 inject/steer)。
    const mode =
      params.mode === "inject" || params.mode === "queue" || params.mode === "interrupt"
        ? params.mode
        : undefined;
    await this.dispatchInput(sid, input, text, false, mode);
  }

  /** #552 queue/stop&send 排隊的輸入:回合結束由 finishTurn 作為新回合投遞(絕不與 active 併發)。 */
  private readonly queuedInputs = new Map<string, Array<{ input: UserInput[]; firstText: string }>>();
  /** #623 turn/steer 注入的 user 文本池(per-sid,trim 後,時序,capped)。**不掛 ActiveTurn**:
   * 注入可能被引擎排到下一回合,rollout 的 user 行到下回合才落盤——srcId 回填必須跨回合重試,
   * 配對成功才出池,否則注入的 user 行沒 dedup_key,鏡像重讀雙投用戶氣泡(cc 同款,#552/#601 家族)。 */
  private readonly injectedTexts = new Map<string, string[]>();

  /**
   * #132/#317/#552 投遞一回合輸入(prompt.submit 與 command.invoke 共用)。閒置 = 起新回合;
   * 回合進行中按 mode 分流:
   *  - `inject` / 缺省(歷史默認):turn/steer 注入(expectedTurnId 防競態);steer 未命中
   *    (回合恰好剛結束/turnId 不匹配)→ 回退起新回合,消息絕不丟;
   *  - `queue`:入 queuedInputs,回合結束由 finishTurn 續投,不打斷;
   *  - `interrupt`(stop & send):排隊 + turn/interrupt(turnId 未到位走 #245 deferral),
   *    回合定稿 interrupted 後排隊消息接管。
   */
  private async dispatchInput(
    sid: string,
    input: UserInput[],
    firstText: string,
    requireDelivery = false,
    mode?: "inject" | "queue" | "interrupt",
  ): Promise<void> {
    const running = this.active.get(sid);
    if (running && (mode === "queue" || mode === "interrupt")) {
      // get→push 同一 tick(無 await),finishTurn 不可能插隊——排隊後必有一次回合收尾來投遞。
      const q = this.queuedInputs.get(sid) ?? [];
      q.push({ input, firstText });
      this.queuedInputs.set(sid, q);
      if (mode === "queue") {
        // ⚠️ 回歸契約:scripts/regression/run-codex-regression.mjs 斷言「Queue:排隊等當前回合結束」,改動需同步
        console.log(`· Queue:排隊等當前回合結束 → ${sid}`);
        return;
      }
      this.interruptedSids.add(sid);
      if (running.turnId) {
        try {
          await this.client.request("turn/interrupt", { threadId: running.threadId, turnId: running.turnId });
          // ⚠️ 回歸契約:run-codex-regression.mjs + localchain(agents/codex.mjs modeStopSend)均斷言此串
          console.log(`· turn/interrupt(stop&send)→ ${sid}`);
        } catch (e) {
          // 回合恰好剛結束等:排隊消息仍由回合收尾/下一回合入口投遞,不丟。
          console.log(`· stop&send interrupt 未命中(${(e as Error).message.slice(0, 120)})`);
        }
      } else {
        running.interruptPending = true; // #245:turn/start 未返回的窗口,turnId 到位即補發
        console.log(`· stop&send interrupt 掛起(turnId 未到位,到位即補發)→ ${sid}`);
      }
      return;
    }
    if (running?.turnId) {
      try {
        await this.client.request("turn/steer", { threadId: running.threadId, expectedTurnId: running.turnId, input });
        this.counters.steers += 1;
        // #623 注入文本入池(srcId 回填跨回合配對用)
        if (firstText.trim()) {
          const injected = this.injectedTexts.get(sid) ?? [];
          injected.push(firstText.trim());
          while (injected.length > 8) injected.shift(); // 有界防洩漏
          this.injectedTexts.set(sid, injected);
        }
        // ⚠️ 回歸契約:scripts/regression/run-codex-regression.mjs 斷言「turn/steer 注入跟進消息」,改動需同步
        console.log(`· turn/steer 注入跟進消息 → ${sid}`);
        return;
      } catch (e) {
        console.log(`· steer 未命中(${(e as Error).message.slice(0, 120)})→ 起新回合`);
      }
    }
    await this.runTurn(sid, input, firstText, requireDelivery);
  }

  private async runTurn(
    sid: string,
    input: UserInput[],
    firstText: string,
    requireDelivery = false,
  ): Promise<void> {
    const isE2E = this.e2e?.isE2E(sid) ?? false;
    // #377 每回合校驗工作目錄(realpath/allowlist 硬校驗);不通過就回提示、不起回合。
    const res = this.resolveSessionCwd(sid);
    if (!res.ok) {
      const err = `⚠️ ${res.reason}(連接器主機上)。請修正會話目錄後重發。`;
      if (isE2E) this.sendE2ETurn(sid, err);
      else this.emit(sid, "review.summary", { summary: err });
      if (requireDelivery) throw new E2EControlError(err);
      return;
    }
    const cwd = res.cwd;
    let threadId = this.threadFor(sid);
    const isFirstMacchiatoTurn = !threadId && !UUID_RE.test(sid) && !isE2E;
    if (isFirstMacchiatoTurn && !this.titled.has(sid) && firstText) this.maybeTitle(sid, firstText);
    try {
      if (threadId && !this.loadedThreads.has(threadId)) {
        await this.client.request("thread/resume", { threadId, cwd, approvalPolicy: this.approvalFor(sid), sandbox: this.sandboxFor(sid) });
        this.loadedThreads.add(threadId);
      } else if (!threadId) {
        const ts = await this.client.request("thread/start", { cwd, approvalPolicy: this.approvalFor(sid), sandbox: this.sandboxFor(sid) });
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
      const model = this.modelFor(sid);
      const turn: ActiveTurn = {
        threadId,
        started: false,
        userText: firstText,
        agentText: "",
        deltaLen: 0,
        reasoningSeen: new Set(),
        toolItems: new Map(),
        usage: {},
        isE2E,
        isFirstMacchiatoTurn,
        input,
        lastActivityAt: Date.now(), // #895
        ...(model ? { modelUsed: model } : {}),
      };
      this.active.set(sid, turn);
      this.pending.add(sid); // #200
      this.saveMap();
      this.armTurnWatchdog(sid, turn); // #895 在 turn/start 之前掛——start 本身掛死也要收
      const effort = this.effortFor(sid); // #231 per-turn reasoning effort
      const res = await this.client.request("turn/start", { threadId, input, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      // 看門狗可能在 await 期間已強制收尾——別再寫 turnId / 補發 interrupt
      if (turn.finalized || this.active.get(sid) !== turn) return;
      // turn/start 立即返回(探針);turnId 也會隨 turn/started 通知到,這裡先記省一拍。
      if (res?.turn?.id) turn.turnId = String(res.turn.id);
      if (turn.turnId && turn.interruptPending) void this.fireDeferredInterrupt(sid, turn); // #245
    } catch (e) {
      // runTurn 失敗路徑:若看門狗已收尾(active 已空),別再潑第二條錯誤。
      const stuck = this.active.get(sid);
      if (!stuck) {
        this.counters.driveErrors += 1;
        if (requireDelivery) throw e;
        return;
      }
      this.clearTurnWatchdog(stuck);
      this.active.delete(sid);
      this.pending.delete(sid);
      this.saveMap();
      if (e instanceof AppServerDied) {
        const note = "❌ codex app-server 不可用(重啟中),請稍後重發";
        if (isE2E) this.sendE2ETurn(sid, note);
        else this.emit(sid, "review.summary", { summary: note });
      } else {
        // 同步失敗也可能是「模型需更新 CLI」——先記黑名單,文案人話化(與 finishTurn 同路)
        const raw = (e as Error).message;
        const need = parseModelNeedsNewerCli(raw);
        if (need) this.blockModelNeedingNewerCli(sid, need.model);
        const note = formatCodexTurnError(raw);
        if (isE2E) this.sendE2ETurn(sid, note);
        else this.emit(sid, "review.summary", { summary: note });
      }
      this.counters.driveErrors += 1;
      if (requireDelivery) throw e;
    }
  }

  // ============================== 上行(app-server 通知 → server) ==============================

  private onNotification(method: string, p: any): void {
    const threadId = String(p?.threadId ?? "");
    const sid = threadId ? this.byThread.get(threadId) : undefined;
    if (!sid) return;
    const turn = this.active.get(sid);
    if (turn) turn.lastActivityAt = Date.now(); // #895 看門狗續期
    switch (method) {
      case "turn/started": {
        if (turn && !turn.turnId) turn.turnId = String(p.turn?.id ?? "");
        if (turn?.turnId && turn.interruptPending) void this.fireDeferredInterrupt(sid, turn); // #245
        return;
      }
      case "thread/name/updated": {
        // #224 codex 自己起的 thread 名 → session.title(替代首條消息截斷的土標題)。
        // 自寫回聲(session.rename 觸發的)不回投;E2E 跳過(標題事件明文,#113 紀律)。
        const name = typeof p.threadName === "string" ? p.threadName.trim() : "";
        if (!name || this.e2e?.isE2E(sid)) return;
        if (this.renamedTitles.get(threadId) === name) {
          this.renamedTitles.delete(threadId);
          return;
        }
        this.emit(sid, "session.title", { title: name });
        console.log(`· #224 thread/name/updated → session.title(${sid})`);
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
        // #258 已知線程的未處理通知 method = codex 可能升版改了通知面(delta/審批等可能靜默消失)。
        // 此前 default 一行 log 都不打 → 無感知。去重告警 + 計數(health 帶出 unknownNotifications)。
        if (!this.loggedUnknownNotif.has(method)) {
          this.loggedUnknownNotif.add(method);
          console.error(`[#258 未知 app-server 通知 method=${method}——codex 可能升版改了通知面,請查是否需處理(delta 恐靜默消失)]`);
        }
        this.counters.unknownNotifications += 1;
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
    if (turn.finalized) return; // #895 看門狗已收尾 / 防雙份
    turn.finalized = true;
    this.clearTurnWatchdog(turn);
    this.active.delete(sid);
    this.pending.delete(sid);
    this.saveMap();
    // 懸空審批(回合結束仍沒人回)→ decline 收尾,別讓反向請求永久掛起。
    for (const p of this.approvals.get(sid) ?? []) p.resolve("decline");
    this.approvals.delete(sid);
    const interrupted = this.interruptedSids.delete(sid);
    const st = String(turnObj.status ?? "completed"); // TurnStatus: completed/interrupted/failed/inProgress
    const status = st === "failed" ? "error" : st === "interrupted" || interrupted ? "interrupted" : "complete";
    const errMsg = turnObj.error?.message ?? turnObj.error ?? turn.lastError;
    // #310 認證失效偵測:auth 類失敗置持續態(health authOk=false → app 顯降級);成功回合恢復。
    const errText = String(errMsg ?? "");
    const authErr = status === "error" && CODEX_AUTH_ERR_RE.test(errText);
    if (authErr) this.authFailed = true;
    else if (status === "complete") this.authFailed = false;

    // 模型需更新 CLI:黑名單 + 清粘滯;若本回合是帶了該 model 起的,靜默換模重試一次(用戶不用重發)。
    const needNewer = status === "error" && !turn.agentText ? parseModelNeedsNewerCli(errMsg) : null;
    if (needNewer) this.blockModelNeedingNewerCli(sid, needNewer.model);
    const canFallback =
      !!needNewer &&
      !turn.isE2E &&
      !turn.modelFallbackTried &&
      Array.isArray(turn.input) &&
      turn.input.length > 0 &&
      // 只有「我們主動指定了壞 model」時重試才有意義;未指定 = CLI 默認就是壞的,省略 model 仍會撞牆
      turn.modelUsed === needNewer.model;
    if (canFallback) {
      this.emit(sid, "review.summary", {
        summary: `⚠️ 模型 ${needNewer!.model} 本機 Codex 暫不可用，已自動改用可用模型重試…`,
      });
      // 不發 error 終態(避免空失敗氣泡);直接起新回合,帶 modelFallbackTried 防循環
      void this.runTurnWithFallback(sid, turn.input!, turn.userText);
      // 排隊消息仍要在重試回合之後投——先塞回隊首,等重試 finish 再 dequeue
      // (runTurnWithFallback 的 finish 會走正常 queue 路徑)
      this.mirror?.fastForward(turn.threadId);
      this.mirror?.unsetDriven(turn.threadId);
      this.projects?.checkTurnEnd();
      return;
    }

    if (turn.isE2E) {
      this.sendE2ETurn(sid, turn.agentText);
    } else {
      if (status === "error" && !turn.agentText) {
        // 人話 + 可行動下一步(#310 auth / 模型需更新 CLI / 一般錯誤剝 JSON 殼)
        this.emit(sid, "review.summary", {
          summary: formatCodexTurnError(errMsg ?? "unknown"),
        });
      }
      this.startMsg(sid, turn);
      this.emit(sid, "message.complete", { text: turn.agentText, status, usage: turn.usage });
    }
    // #393 回合末把本回合 live 消息回填 srcId(server dedup_key),跨進程重啟後鏡像重投同一 rollout 行
    // 撞 (session,dedup_key) 唯一索引被吃掉,不再雙份。E2E 走加密批(自帶 srcId)。
    if (!turn.isE2E) this.backfillLiveSrcIds(sid, turn);
    this.mirror?.fastForward(turn.threadId);
    this.mirror?.unsetDriven(turn.threadId);
    this.projects?.checkTurnEnd(); // #227
    // #552 queue/stop&send 排隊的消息:回合收尾後作為新回合投遞。
    const next = this.queuedInputs.get(sid)?.shift();
    if (!this.queuedInputs.get(sid)?.length) this.queuedInputs.delete(sid);
    if (next) void this.runTurn(sid, next.input, next.firstText);
  }

  /** 模型版本失敗後的一次自動重試:不再帶壞 model(已進黑名單);標記寫在 turn 建立後、完成前。 */
  private async runTurnWithFallback(sid: string, input: UserInput[], firstText: string): Promise<void> {
    await this.runTurn(sid, input, firstText);
    // runTurn 只等到 turn/start 返回;active 裡仍是新回合——立刻打標,避免異步完成前又觸發一次 fallback
    const t = this.active.get(sid);
    if (t) t.modelFallbackTried = true;
  }

  /** 記黑名單 + 清本會話粘滯 model(若正好是這個),避免下一條消息再撞牆。 */
  private blockModelNeedingNewerCli(sid: string, model: string): void {
    this.modelsBlockedByCliVersion.add(model);
    if (this.models[sid] === model) {
      delete this.models[sid];
      this.saveMap();
    }
    console.error(
      `[drive2] model ${model} 需更新本機 Codex CLI → 已拉黑(本進程);會話粘滯已清(若匹配)`,
    );
  }

  /**
   * #393 回合末:把本回合 live 投遞的 user/agent 消息回填 rollout 行 srcId 作 server dedup_key
   * (message_srcid,#13 同款,Hermes/OpenClaw 驗過的模式)。Codex 無常駐 gateway,live×mirror 收斂
   * 全靠此:server 的 (session_id,dedup_key) 唯一索引此後對 Codex 生效,跨進程重啟鏡像重投同一 rollout
   * 行撞索引被 onConflictDoNothing 吃掉,不再雙份。rollout 行無 uuid → srcId 是 srcIdFor 內容指紋,故
   * 用文本匹配 user_message / 取最後一條 agent_message(= live 的 message.complete 文本所屬行)。
   * 取捨(見 PR):① rollout 尾行可能晚於 turn/completed 落盤 → 偶爾取不到,留待後續(去重是加固);
   * ② 帶多條 agent_message 的回合 live 只投一條合併消息,僅最後一條收斂——與 OpenClaw lastAssistant 同限。
   * 純只讀快照,失敗吞掉(不影響主回合)。
   */
  private backfillLiveSrcIds(sid: string, turn: ActiveTurn): void {
    try {
      const msgs = this.mirror?.srcIdSnapshot(turn.threadId) ?? [];
      if (!msgs.length) return;
      const items: Array<{ role: "user" | "agent"; srcId: string }> = [];
      // agent:rollout 最後一條 agent_message(= 本回合剛畢的回覆;append-only,尾行即本回合)。
      const agent = [...msgs].reverse().find((m) => m.role === "agent");
      if (agent?.srcId) items.push({ role: "agent", srcId: agent.srcId });
      // user:文本匹配。#623 本回合可能有多條 user(開場 prompt + turn/steer 注入)——server 側
      // backfillDedupKey 恆取「最新一條 dedup 為空的 user 行」,items 必須**新→舊**:注入的(倒序)
      // 在前,開場 prompt 最後。注入池跨回合:本次配不上的留給下一次回合收尾再試。
      const injected = this.injectedTexts.get(sid) ?? [];
      const wants: Array<{ text: string; fromPool: boolean }> = [
        ...[...injected].reverse().map((t) => ({ text: t, fromPool: true })),
        { text: turn.userText.trim(), fromPool: false },
      ];
      const used = new Set<string>();
      const rev = [...msgs].reverse();
      for (const want of wants) {
        if (!want.text) continue;
        const user = rev.find((m) => m.role === "user" && m.text.trim() === want.text && !!m.srcId && !used.has(m.srcId));
        if (user?.srcId) {
          used.add(user.srcId);
          items.push({ role: "user", srcId: user.srcId });
          if (want.fromPool) {
            const at = injected.lastIndexOf(want.text);
            if (at >= 0) injected.splice(at, 1);
          }
        }
      }
      if (!injected.length) this.injectedTexts.delete(sid);
      if (items.length) {
        this.linkb.send({ t: "message_srcid", agentLinkId: this.linkb.agentLinkId, sessionId: sid, items });
      }
    } catch (e) {
      console.error(`[#393 Codex srcId 回填失敗 ${sid}] ${(e as Error).message}`);
    }
  }

  // ============================== 審批橋 ==============================

  /** #245:補發掛起的 interrupt(點停止時 turn/start 尚未返回)。 */
  private async fireDeferredInterrupt(sid: string, turn: ActiveTurn): Promise<void> {
    turn.interruptPending = false;
    try {
      await this.client.request("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId });
      console.log(`· turn/interrupt(補發) → ${sid}`);
    } catch (e) {
      console.error(`[#245 補發 interrupt 失敗 ${sid}] ${(e as Error).message}`);
    }
  }

  /** 反向請求 → approval.request 卡(payload 對齊 CC 的形狀);掛起等 approval.respond。 */
  private onApprovalRequest(p: any, kind: CodexApprovalKind): Promise<Record<string, unknown>> {
    const sid = this.byThread.get(String(p?.threadId ?? ""));
    if (!sid) return Promise.resolve({ decision: "decline" }); // 不認識的 thread(不該發生)
    this.counters.approvalsRequested += 1;
    const sourceParams = p as Record<string, unknown>;
    // #240 E2E:命令全文/文件路徑/cwd 都敏感 → 加密進 enc,明文只留占位 + 類別 + request_id。
    const isE2E = this.e2e?.isE2E(sid) ?? false;
    const requestId = p.itemId ? String(p.itemId) : isE2E ? randomUUID() : undefined;
    let executionSnapshot: CodexApprovalExecutionSnapshot | undefined;
    let executionDisplay: string | undefined;
    if (isE2E && requestId) {
      try {
        executionSnapshot = immutableE2EApprovalSnapshot<CodexApprovalExecutionSnapshot>(
          codexApprovalExecutionRequest(sid, requestId, kind, sourceParams),
        );
        executionDisplay = canonicalE2EApprovalDisplay(executionSnapshot);
      } catch (error) {
        console.error(
          `[E2E approval auto-declined ${sid}] ${error instanceof Error ? error.message : String(error)}`,
        );
        return Promise.resolve({ decision: "decline" });
      }
    }
    const request = executionSnapshot?.params ?? sourceParams;
    const command =
      kind === "command"
        ? String(request.command ?? "")
        : `Modify files: ${(Array.isArray(request.changes) ? request.changes : []).map((c: any) => String(c?.path ?? "")).filter(Boolean).join(", ").slice(0, 300) || "(see details)"}`;
    const reason = request.reason ? String(request.reason) : "";
    const cmd = command.slice(0, 500);
    // #364 回退文案改英文正典(對齊 CC 的 `Claude Code wants to use X`);不 hardcode 繁中,
    // 英語界面不再顯示中文。真實 reason(Codex 提供)照原樣透傳,client 按語言本地化見 issue #364。
    const desc = reason || (kind === "command" ? `Codex wants to run a command in ${String(request.cwd ?? "")}` : "Codex wants to write the files above");
    const patternKey = kind === "command" ? "shell" : "fileChange";
    const requestDigest =
      executionSnapshot
        ? e2eApprovalRequestDigest(this.e2e!.requireKey(sid), executionSnapshot)
        : undefined;
    const approvalPlaintext =
      isE2E && requestId && requestDigest
        ? {
            command: cmd,
            description: desc,
            patternKey,
            requestId,
            requestDigest,
            executionRequest: executionSnapshot,
            executionDisplay,
          }
        : undefined;
    if (
      approvalPlaintext
      && Buffer.byteLength(JSON.stringify(approvalPlaintext), "utf8")
        > E2E_APPROVAL_PLAINTEXT_MAX_BYTES
    ) {
      console.error(
        `[E2E approval auto-declined ${sid}] encrypted approval payload exceeds device limit`,
      );
      return Promise.resolve({ decision: "decline" });
    }
    // 尺寸闸门必须先于 emit / approvals.push；否则设备拒绝卡片后本地反向请求会永久挂起。
    const enc = approvalPlaintext
      ? this.e2e!.encryptContent(sid, approvalPlaintext)
      : undefined;
    this.emit(sid, "approval.request", {
      command: isE2E ? "🔒 加密審批請求" : cmd,
      pattern_key: patternKey,
      pattern_keys: [patternKey],
      description: isE2E ? "" : desc,
      ...(enc ? { enc } : {}),
      ...(requestId ? { request_id: requestId } : {}),
      ...(requestDigest ? { request_digest: requestDigest } : {}),
    });
    return new Promise((resolve) => {
      const list = this.approvals.get(sid) ?? [];
      list.push({
        sid,
        requestId,
        requestDigest,
        executionSnapshot,
        sourceParams: executionSnapshot ? sourceParams : undefined,
        kind: executionSnapshot ? kind : undefined,
        resolve: (decision) => resolve({ decision }),
      });
      this.approvals.set(sid, list);
    });
  }

  // ============================== 其餘(與 v1 對齊) ==============================

  /** app-server 重啟:活躍回合已死 → 定稿 interrupted + 提示重發;thread 需重新 resume。 */
  private onServerRestart(): void {
    this.loadedThreads.clear();
    for (const [sid, turn] of [...this.active]) {
      this.clearTurnWatchdog(turn); // #895
      this.active.delete(sid);
      this.pending.delete(sid);
      turn.finalized = true;
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
    // #552 排隊的消息沒了投遞時機(引擎死了,不自動重跑防雙投副作用)→ 可見提示,絕不靜默丟。
    for (const sid of [...this.queuedInputs.keys()]) {
      this.queuedInputs.delete(sid);
      const note = "⚠️ 排隊的消息未投遞(codex 引擎重啟),請重發。";
      if (this.e2e?.isE2E(sid)) this.sendE2ETurn(sid, note);
      else this.emit(sid, "review.summary", { summary: note });
    }
    this.saveMap();
  }

  /**
   * #224 app-server 標題:codex 原生 thread/name/updated 提供好標題並覆蓋。這裡只即時落一個
   * **便宜的截斷佔位**(不再起額外 codex exec 生成標題——那在 app-server 下純屬浪費),讓會話立刻
   * 有名、codex 的原生名一到就蓋掉。E2E 不落(明文標題,#113 紀律)。
   */
  private maybeTitle(sid: string, firstUserText: string): void {
    try {
      this.titled.add(sid);
      this.saveMap();
      if (titleMode() === "off") return; // off:不落佔位(codex 原生名或無)
      const title = fallbackTitle(firstUserText);
      if (!title) return;
      this.emit(sid, "session.title", { title });
    } catch (e) {
      console.error(`[title placeholder failed for ${sid}] ${(e as Error).message}`);
    }
  }

  private sendE2ETurn(sid: string, reply: string): void {
    // #350 與 exec 引擎共用 rollout durable outbox；只有 mirror_ack 才推水位。
    this.pendingUser.delete(sid);
    void reply;
  }

  private persistSessionSetting(
    target: Record<string, string>,
    sid: string,
    value: string,
    authenticated: AuthenticatedControlTag | undefined,
    label: string,
  ): void {
    const hadPrevious = Object.hasOwn(target, sid);
    const previous = target[sid];
    if (value ? previous === value : !hadPrevious) return;
    if (value) target[sid] = value;
    else delete target[sid];
    if (this.saveMap()) return;
    if (hadPrevious) target[sid] = previous!;
    else delete target[sid];
    if (authenticated) {
      throw new E2EControlError(`failed to persist authenticated ${label}`);
    }
  }

  private saveMap(): boolean {
    const saved = saveDriveState({ map: this.map, cwds: this.cwds, models: this.models, efforts: this.efforts, perms: this.perms, titled: this.titled, pending: this.pending });
    if (saved) {
      const protectedIds = this.protectedWireSids().filter((sid) => !UUID_RE.test(sid));
      if (protectedIds.every((sid) => UUID_RE.test(this.map[sid] ?? ""))) this.identityStateTrusted = true;
    }
    return saved;
  }
}
