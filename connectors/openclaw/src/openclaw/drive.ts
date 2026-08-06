/**
 * Drive：Macchiato → OpenClaw 的雙向橋（對應 Hermes 連接器的 tui 分派 + 事件回傳）。
 *
 * 下行（server → 連接器, t:"tui" 幀）：
 *   prompt.submit  → chat.send（回合進行中 → sessions.steer 注入, §18 方案 D, 實測可用）
 *   session.interrupt → sessions.abort
 *   session.create → 登記 driven（chat.send 首次提交時自動建會話）
 * 上行（OpenClaw gateway 事件 → server tui EVENT, 形狀均為 2026-07-04 活測捕獲）：
 *   chat state:"delta" {deltaText}        → message.start（首個 delta 補發）+ message.delta
 *   chat state:"final" {message.content}  → message.complete（ingest 對累積/增量雙容）
 *   agent lifecycle start/end             → 回合活躍表 + 結束時讓鏡像快進（防雙投）
 *   exec.approval.requested               → approval.request（F-09/#486 · #281 live 審批卡）
 * 下行審批：
 *   approval.respond                      → exec.approval.resolve{id, decision}
 *
 * 會話映射：server 下發 hermesSessionId；`agent:` 開頭 = OpenClaw 真實 key（鏡像來的會話, 直接續聊）；
 * 否則是 Macchiato 新建會話 → 包成 `agent:main:macchiato:<sid>`（無渠道綁定, 回覆只走 Macchiato）。
 * ⚠️ 續聊渠道會話（discord key）的回覆是否會同時投遞到該渠道 —— chat.send 無 deliver 參數
 *（sessions.send 也實測拒收 deliver）, 待真機驗證；probe 證明無綁定 key 是乾淨的。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { LinkBClient } from "../_core/linkb/client";
import { fetchChatAttachment, type ChatAttachment } from "./attachments";
import type { OpenClawGateway, GatewayEvent } from "./gateway";
import { keyForSid, sidForKey, type Mirror } from "./mirror";
import { generateTitle, loadTitled, saveTitled } from "./titles";
import { extractMediaPaths, readMediaFile, resolveMediaAllowRoots } from "./media";
import type { E2EKeyStore, ServerE2EStateV1 } from "../_core/e2e/keys";
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
import { formatCommandInvokeLog, logContent, safeErr, shortId, textLen } from "../_core/safe-log";

/** E2E 加密審批明文尺寸閘（與 CC/Codex 對齊；須先於 emit/掛起）。 */
const E2E_APPROVAL_PLAINTEXT_MAX_BYTES = 64 * 1024;

/**
 * #555 lifecycle `end` 早於尾段 `chat` delta/final 時,等 final 的 grace 窗(毫秒)。
 * 實測 final 只晚 ~2ms;真沒 final(錯誤/中斷/靜默回合)才會等滿,再走兜底定稿。
 */
const END_GRACE_MS = Number(process.env.MACCHIATO_OPENCLAW_END_GRACE_MS) || 3000;

/** OpenClaw gateway 審批決策（官方 resolve 枚舉）。 */
type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";

interface PendingExecApproval {
  /** gateway 審批 id（exec.approval.resolve 回帶）。 */
  id: string;
  sid: string;
  /** E2E: keyed digest，respond 必須對得上才執行。 */
  requestDigest?: string;
  executionSnapshot?: Record<string, unknown>;
  /** gateway 標明不可用的決策（常見：allow-always）。 */
  unavailableDecisions: Set<string>;
}

type OpenClawApprovalExecutionSnapshot = {
  v: 1;
  connector: "openclaw";
  sessionId: string;
  requestId: string;
  command: string;
  cwd: string;
  host?: string;
  agentId?: string;
  sessionKey?: string;
} & Record<string, unknown>;

// key ↔ sid 映射移居 mirror.ts（E2E 回灌也要用）；re-export 保持既有導入面不變。
export { keyForSid, sidForKey };

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
]);

/**
 * Link B ready 的 E2E 身份閘門。pending-enable 的 bootstrap control 一定排在 ready 後：
 * 僅准該快照中的 sid 暫缺 mirror fileId，以便收到 backfill 後用 gateway 權威 sessionId 補圖。
 * drive identity、mirror state trust、stable/disable 的 fileId 都不得豁免；內容面另走 strict assert。
 */
export function applyReadyE2EIdentityState(
  e2e: E2EKeyStore,
  drive: Pick<Drive, "applyE2EQuiesceState" | "assertE2EIdentitySafe">,
  mirror: Pick<Mirror, "assertE2EIdentitySafe">,
  rawState: unknown,
): string[] {
  const blocked = e2e.applyServerState(rawState);
  // applyServerState 已完整驗證 shape，之後才可读取 pending-enable 精確白名單。
  const state = rawState as ServerE2EStateV1;
  drive.applyE2EQuiesceState(state.sessions);
  const pendingEnables = new Set(
    state.sessions
      .filter((session) => session.pendingOp === "enable")
      .map((session) => session.hermesSessionId),
  );
  drive.assertE2EIdentitySafe();
  mirror.assertE2EIdentitySafe(pendingEnables);
  return blocked;
}

/** #202 drive 持久狀態文件(driven key→sid + 對賬水位線)。 */
function driveStatePath(): string {
  return process.env.MACCHIATO_OPENCLAW_DRIVE || join(homedir(), ".macchiato/openclaw-drive.json");
}

interface PersistedDriveState {
  driven: Record<string, string>;
  wm: Record<string, number>;
  identityStateTrusted: boolean;
}

function parseDriveState(raw: string, identityStateTrusted: boolean): PersistedDriveState {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("drive state root must be an object");
  }
  const drivenRaw = value.driven;
  const wmRaw = value.wm ?? {};
  if (drivenRaw === null || typeof drivenRaw !== "object" || Array.isArray(drivenRaw)) {
    throw new Error("driven must be an object");
  }
  if (wmRaw === null || typeof wmRaw !== "object" || Array.isArray(wmRaw)) {
    throw new Error("wm must be an object");
  }
  const driven: Record<string, string> = {};
  for (const [key, sid] of Object.entries(drivenRaw)) {
    if (!key || typeof sid !== "string" || !sid) throw new Error("driven contains an invalid entry");
    if (keyForSid(sid) !== key) throw new Error("driven key does not canonically match its wire sid");
    driven[key] = sid;
  }
  const wm: Record<string, number> = {};
  for (const [key, seq] of Object.entries(wmRaw)) {
    if (!key || typeof seq !== "number" || !Number.isFinite(seq) || seq < 0) {
      throw new Error("wm contains an invalid entry");
    }
    wm[key] = seq;
  }
  return { driven, wm, identityStateTrusted };
}

/** #261 工具卡 args_text:JSON 化(截斷,防超大 args 撐爆幀)。 */
function previewJson(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 2000 ? s.slice(0, 2000) + "…" : s;
  } catch {
    return "";
  }
}

/** #261 工具卡 result_text:從 session.tool result 提一行人類可讀摘要(exec 給 exit/status;
 * session.tool 的 bash result 只帶 {status,exitCode,durationMs},不含 stdout——回覆正文另有)。 */
function toolResultText(d: Record<string, unknown>): string {
  const r = d.result;
  if (r && typeof r === "object") {
    const ro = r as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof ro.exitCode === "number") parts.push(`exit ${ro.exitCode}`);
    if (typeof ro.status === "string" && ro.status !== "completed") parts.push(String(ro.status));
    if (d.isError) parts.push("(error)");
    return parts.join(" ").trim();
  }
  if (typeof r === "string") return r.slice(0, 2000);
  return d.isError ? "(error)" : "";
}

export class Drive {
  /** key → runId（回合進行中）。 */
  private readonly active = new Map<string, string>();
  /** 已發過 message.start 的 runId。 */
  private readonly started = new Set<string>();
  /** runId → 已收 delta 的累積文本（lifecycle end 無 final 時兜底 complete 用）。 */
  private readonly acc = new Map<string, string>();
  /** 已發 message.complete 的 runId。 */
  private readonly completed = new Set<string>();
  /**
   * #555 runId → 「lifecycle end 已到但 chat final 還沒到」的兜底定稿計時器。
   * 2026-07-29 狗糧機實測(OpenClaw 2026.7.1-2):`agent` lifecycle `end` 會**早於**本回合最後
   * 一批 `chat` delta/final 到達(同 seq,end 先發)。舊碼在 end 立刻定稿 → 尾段 delta 被當成
   * 新回合另開一條消息,同一句回覆在 app 裡裂成兩條氣泡("LIVE" + "_DRIVE_OK")。
   */
  private readonly endGrace = new Map<string, ReturnType<typeof setTimeout>>();
  /** 本進程驅動過的 key（鏡像跳過 → live 路徑獨佔投遞）。 */
  private readonly driven = new Set<string>();
  /** 小寫 key → server 原始 sid（大寫 ULID）；回傳事件用它找回 server 認識的 sid。 */
  private readonly sidByKey = new Map<string, string>();
  /**
   * #432 sid → 本進程 live 已投過的 toolCallId。gateway 的 live `session.tool` result 只帶
   * `{status, exitCode, durationMs}`——**沒有工具輸出正文**,完整 input/output 只在 transcript 裡,
   * 由鏡像回合末打撈。此表讓打撈能認出「這個工具 live 已經投過卡了」→ 走 enrichLiveTool 原地補內容,
   * 而不是當作新內容再 append 一條消息(#261 加了 live 投遞卻沒改 #147 的打撈前提 → 同一批工具
   * 在正文前後各出現一次,前空後滿)。有界:超額按 FIFO 淘汰最舊 sid。
   */
  private readonly liveToolIds = new Map<string, Set<string>>();
  private static readonly LIVE_TOOL_SIDS = 64;
  private static readonly LIVE_TOOL_IDS_PER_SID = 512;
  /**
   * #202 對賬狀態(持久,跨重啟):驅動過的 key→sid + 每 key 已對賬的最大 __openclaw.seq 水位線。
   * driven key 的投遞是 live 獨佔(鏡像跳過),live 漏收 gateway 廣播(WS 重連窗/進程死)= 該段丟。
   * 對賬 = 重連/啟動時拉 chat.history(每條帶穩定 __openclaw.id + 單調 seq),把 seq>水位線的行
   * 用 mirror_append+srcId 補投——已由 live 投遞且回合末回填過 srcId 的行撞 (session,dedup_key)
   * 唯一索引被吃掉,不雙投;真漏的行被補上,不再丟。
   */
  private wmByKey: Record<string, number> = {};
  private drivenPersist: Record<string, string> = {};
  /** 主 driven key↔wire sid 快照是否完整可信；backup/空 fallback 不足以證明 E2E identity。 */
  private identityStateTrusted = false;

  /** E2E 會話：runId 前暫存的（已解密）用戶消息, 回合結束隨加密批一起投遞。 */
  private readonly pendingUser = new Map<string, string[]>();
  /** #244 本回合經 Macchiato 發出的 prompt 文本(chat.send/steer/重投都記):回合末對賬按
   * 文本匹配區分「我們的 user 行(只回填 srcId)」vs「渠道側 user 行(live 從未投遞 → 補投)」。
   * 舊實現不分,把渠道行 id 誤回填給 Macchiato 消息,渠道 user 消息則永不進 Macchiato。 */
  private readonly sentTexts = new Map<string, string[]>();
  /** #162 回合中帶附件的跟進消息:整條排隊(steer 無附件通道),lifecycle end 自動 chat.send 送達。 */
  private readonly pendingFollowUps = new Map<string, Array<{ sid: string; text: string; attachments: ChatAttachment[] }>>();

  /** #113 已自動生成過標題的 sid(持久,重啟不重生、不覆蓋用戶手改)。 */
  private readonly titled = loadTitled();
  private readonly e2eControl?: E2EControlVerifier;
  private readonly e2eQuiescing = new Map<
    string,
    { requestId: string; mode: "enable" | "disable" }
  >();
  private readonly contentInflight = new Set<string>();

  /** #4 已重投過的 `sid:text哈希`——每條 prompt 最多重投一次,寧丟勿雙發。 */
  private readonly promptRetried = new Set<string>();
  /** #4 最近一次重投任務(測試 await 用;生產無人等)。 */
  retryTask: Promise<void> | null = null;
  /** #5 重投等待中的 key;用戶中斷時據此標記取消——已叫停的 prompt 不許復活雙發。 */
  private readonly retryWaiting = new Set<string>();
  private readonly retryCancelled = new Set<string>();

  /** #10:累計計數(進程生命週期),健康上報帶出。 */
  readonly counters: Record<string, number> = {
    promptRetries: 0,
    promptRetryFails: 0,
    driveErrors: 0,
    approvalsRequested: 0,
    approvalsResolved: 0,
  };

  /** #669 心跳:有進行中回合(key → runId 映射非空)。為「閒時更新」預留,本階段只寫進 health.json。 */
  get busy(): boolean {
    return this.active.size > 0;
  }
  /** #669 心跳:有掛起的 exec 審批(F-09/#486)。 */
  get hasPendingApproval(): boolean {
    return this.pendingApprovals.size > 0;
  }

  /**
   * F-09/#486:gateway 掛起的 exec 審批（id → pending）。
   * request_id 精確配對；缺省時按 sid FIFO（舊 server 兼容）。
   */
  private readonly pendingApprovals = new Map<string, PendingExecApproval>();
  /** sid → 該會話掛起審批 id 順序（FIFO 兜底）。 */
  private readonly pendingApprovalOrder = new Map<string, string[]>();

  constructor(
    private readonly gw: OpenClawGateway,
    private readonly linkb: LinkBClient,
    private readonly mirror?: Mirror,
    private readonly e2e?: E2EKeyStore,
    e2eControl?: E2EControlVerifier,
  ) {
    // #202 載入持久對賬狀態;歷史 driven key 重新登記(鏡像跳過 + 事件路由 + 對賬覆蓋)。
    for (const [path, isPrimary] of [[driveStatePath(), true], [`${driveStatePath()}.bak`, false]] as const) {
      try {
        const st = parseDriveState(readFileSync(path, "utf8"), isPrimary);
        this.drivenPersist = st.driven;
        this.wmByKey = st.wm;
        this.identityStateTrusted = st.identityStateTrusted;
        break;
      } catch {
        /* backup 是舊代，只恢復內容，不把 E2E identity 提升成可信。 */
      }
    }
    for (const [key, sid] of Object.entries(this.drivenPersist)) {
      this.driven.add(key);
      this.sidByKey.set(key, sid);
      this.mirror?.setDriven(key, sid);
    }
    this.e2eControl = e2eControl ?? (e2e ? new E2EControlVerifier(e2e, e2eControlStorePath(KIND)) : undefined);
    this.mirror?.setDriveIdentityResolver?.(
      (identity) => this.wireSessionIdForLocalIdentity(identity),
      () => this.plaintextLocalIdentityAllowed(),
    );
    this.mirror?.setLiveToolEnricher?.((sid, tool) => this.enrichLiveTool(sid, tool)); // #432
  }

  private saveDriveState(): void {
    try {
      const p = driveStatePath();
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.tmp`;
      const backupTmp = `${p}.bak.tmp`;
      const snapshot = JSON.stringify({ v: 1, driven: this.drivenPersist, wm: this.wmByKey });
      writeFileSync(tmp, snapshot);
      renameSync(tmp, p);
      writeFileSync(backupTmp, snapshot);
      renameSync(backupTmp, `${p}.bak`);
      const requiringMap = this.protectedWireSids().filter((sid) => !sid.startsWith("agent:"));
      if (requiringMap.every((sid) => this.drivenPersist[keyForSid(sid)] === sid)) {
        this.identityStateTrusted = true;
      }
    } catch (e) {
      console.error("[drive state save failed]", (e as Error).message);
    }
  }

  private protectedWireSids(): string[] {
    const fn = (this.e2e as (E2EKeyStore & { protectedSessionIds?: () => string[] }) | undefined)
      ?.protectedSessionIds;
    return typeof fn === "function" ? fn.call(this.e2e) : [];
  }

  /**
   * OpenClaw 的本地 key 可由 wire sid 确定性推导。恶意 server 若把
   * `agent:main:macchiato:<sid>` 当成新 sid，下游仍会命中同一 gateway 会话；必须反查
   * canonical protected wire identity 后拒绝整帧。
   */
  private protectedInboundAliasOwner(sid: string): string | undefined {
    const key = keyForSid(sid);
    return this.protectedWireSids().find(
      (wireSid) => wireSid !== sid && keyForSid(wireSid) === key,
    );
  }

  /** E2E wire ULID 必須能由持久 driven key 精確還原大小寫；否則禁止整個內容面 ready。 */
  assertE2EIdentitySafe(): void {
    const requiringMap = this.protectedWireSids().filter((sid) => !sid.startsWith("agent:"));
    if (!requiringMap.length) return;
    const missing = requiringMap.filter((sid) => this.drivenPersist[keyForSid(sid)] !== sid);
    if (!this.identityStateTrusted || missing.length) {
      throw new Error(
        `OpenClaw E2E driven identity map unavailable/incomplete (trusted=${this.identityStateTrusted}, ` +
          `missing=${missing.slice(0, 3).join(",") || "unknown"}); refusing plaintext fallback`,
      );
    }
  }

  plaintextLocalIdentityAllowed(): boolean {
    try {
      this.assertE2EIdentitySafe();
      return true;
    } catch {
      return false;
    }
  }

  /** plugin / mirror 可傳 driven key 或本地 transcript id；回 server 前統一還原原始 wire sid。 */
  wireSessionIdForLocalIdentity(identity: string): string | undefined {
    if (!identity) return undefined;
    const direct = this.sidByKey.get(identity) ?? this.sidByKey.get(identity.toLowerCase());
    if (direct) return direct;
    return undefined;
  }

  /** 掛上兩側監聽（linkb.start 前調用）。 */
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
    this.gw.onEvent((e) => this.onGatewayEvent(e));
    // #202 重連後對賬 + #242 回合態重置(斷連窗內 lifecycle end 可能已丟)。
    this.gw.onConnected?.(() => void this.onGatewayConnected());
    // #302 gateway 死亡:在途回合立即定稿 error(否則 server 永卡 streaming,用戶氣泡轉圈無終態)。
    this.gw.onDisconnected?.(() => this.onGatewayDisconnected());
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

  /**
   * 屏障可能是**重連時按 DB pending state 重建**的（`applyE2EQuiesceState`）或續跑補的
   * （`beginE2ETransition`）——那時本地沒有真實請求可記，只能用 `ready:`/`resume:` 合成哨兵。
   * 這種代次**永遠對不上** server 那個真 UUID：若嚴格比對 requestId，server 的權威釋放會被
   * 丟掉、屏障永久殘留，該會話的 prompt/command 從此靜默丟棄（用戶側表現為「發了沒反應」）。
   * 故合成代次一律接受同 mode 的權威釋放/接管。
   */
  private static isSyntheticQuiesceId(requestId: string): boolean {
    return requestId.startsWith("ready:") || requestId.startsWith("resume:");
  }

  releaseE2EQuiesce(sid: string, mode?: "enable" | "disable", requestId?: string): void {
    const current = this.e2eQuiescing.get(sid);
    if (!current) return;
    if (mode && current.mode !== mode) return;
    if (
      requestId &&
      current.requestId !== requestId &&
      !Drive.isSyntheticQuiesceId(current.requestId)
    ) {
      return;
    }
    this.e2eQuiescing.delete(sid);
  }

  async quiesceE2E(sid: string, mode: "enable" | "disable", requestId: string): Promise<boolean> {
    const current = this.e2eQuiescing.get(sid);
    // 合成哨兵代次可被真請求接管（否則重連後每次 quiesce 都直接 false，E2E 開關永遠失敗）。
    if (current && current.requestId !== requestId && !Drive.isSyntheticQuiesceId(current.requestId)) {
      return false;
    }
    this.e2eQuiescing.set(sid, { requestId, mode });
    const key = keyForSid(sid);
    const configured = Number(process.env.MACCHIATO_E2E_QUIESCE_MS);
    const deadline = Date.now() + (Number.isFinite(configured) && configured > 0 ? configured : 4 * 60_000);
    while (
      this.active.has(key) ||
      this.contentInflight.has(sid) ||
      (this.pendingFollowUps.get(key)?.length ?? 0) > 0 ||
      this.retryWaiting.has(key)
    ) {
      if (Date.now() >= deadline) {
        this.releaseE2EQuiesce(sid, mode, requestId);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.e2eQuiescing.get(sid)?.requestId === requestId;
  }

  /** #302 gateway 斷開:對齊 CC 語義(onChannelEnd 定稿 error)——所有在途 live 回合就地終態。
   * 重連後 onGatewayConnected 的對賬會把 gateway 側真正落盤的內容補進歷史(srcId 去重),不丟不重。
   * E2E 會話跳過:live 被抑制、無 streaming 態可收。localchain adv-crash 場景為此路徑的防回歸。 */
  private onGatewayDisconnected(): void {
    for (const [key, runId] of this.active) {
      const sid = this.sidByKey.get(key) ?? sidForKey(key);
      if (!(this.e2e?.isE2E(sid) ?? false) && runId && this.started.has(runId) && !this.completed.has(runId)) {
        this.emit(sid, "message.complete", {
          text: this.acc.get(runId) ?? "",
          status: "error",
          warning: "OpenClaw gateway 斷開,本回合中止——內容若已生成,重連對賬後會補進歷史",
        });
        console.error(`[#302] gateway 斷開 → 在途回合定稿 error(${sid})`);
      }
      if (runId) {
        const t = this.endGrace.get(runId); // #555 等 final 的 grace:斷線即作廢
        if (t) {
          clearTimeout(t);
          this.endGrace.delete(runId);
        }
        this.started.delete(runId);
        this.acc.delete(runId);
        this.completed.delete(runId);
      }
    }
    this.active.clear();
  }

  /** #242 gateway (重)連:斷線窗內 lifecycle end 可能已丟——active/回合態全部作廢,
   * 免得後續 prompt 恆走 sessions.steer 打向已死回合、排隊的帶附件跟進永不送達
   * (OpenClaw 每日自動更新 = gateway 重啟是常態,#210)。重置後先對賬補漏,再續投隊列。 */
  /** #261 訂閱 session 事件流(session.tool/message/operation)——連接器默認只收 agent/chat 廣播,
   * 不訂閱就永遠收不到 session.tool、回合進行中的工具塊無從實時映射。訂閱是 per-connection、斷連即
   * 失效:首連由 index.ts 顯式調(onGatewayConnected 只在**重連** fire、不覆蓋首連),重連走本方法。
   * 失敗只記日誌不擋後續。 */
  async subscribeSessionEvents(): Promise<void> {
    try {
      await this.gw.request("sessions.subscribe", {});
      console.log("· #261 sessions.subscribe ok(live 工具事件 session.tool 已訂閱)");
    } catch (e) {
      console.error("[sessions.subscribe failed]", (e as Error).message);
    }
    // F-09:重連/首連後回填斷線窗內已掛起的 exec 審批（官方 gateway client 契約）。
    await this.backfillExecApprovals();
  }

  private async onGatewayConnected(): Promise<void> {
    await this.subscribeSessionEvents(); // #261 重連要重訂(per-connection、斷連即失效)
    const stale = new Set([...this.active.keys(), ...this.pendingFollowUps.keys()]);
    this.active.clear();
    this.started.clear(); // 斷線期的 runId 條目一併作廢(否則只在 lifecycle end 清 → 洩漏)
    this.acc.clear();
    this.completed.clear();
    for (const t of this.endGrace.values()) clearTimeout(t); // #555 grace 計時器同壽
    this.endGrace.clear();
    // 斷連窗內審批可能已被別處 resolve 或過期——清空本地掛起,靠 backfill 重掛仍 pending 的。
    this.pendingApprovals.clear();
    this.pendingApprovalOrder.clear();
    await this.reconcileAll("reconnect");
    for (const key of stale) await this.flushFollowUps(key);
  }

  isDriven(key: string): boolean {
    return this.driven.has(key);
  }


  /** #432 記下 live 已投的工具 id(有界 FIFO)。 */
  private rememberLiveTool(sid: string, toolId: string): void {
    let ids = this.liveToolIds.get(sid);
    if (!ids) {
      ids = new Set();
      this.liveToolIds.set(sid, ids);
      while (this.liveToolIds.size > Drive.LIVE_TOOL_SIDS) {
        this.liveToolIds.delete(this.liveToolIds.keys().next().value!);
      }
    }
    ids.add(toolId);
    while (ids.size > Drive.LIVE_TOOL_IDS_PER_SID) ids.delete(ids.keys().next().value!);
  }

  /**
   * #432 鏡像打撈到某工具時問一句:live 投過同一個 callId 嗎?
   *  - 投過 → 用 transcript 的完整 input/output 補發一次 `tool.complete`(同 tool_id),server 按
   *    callId 找回原塊**原地補空洞**;返回 true,讓打撈把它從 mirror_append 批裡剔除(否則雙投)。
   *  - 沒投過(老 gateway 無 session.tool / live 漏收)→ 返回 false,照舊走 append,保真不丟。
   */
  enrichLiveTool(sid: string, tool: { callId: string; name: string; input?: unknown; output?: string }): boolean {
    if (!tool.callId || !this.liveToolIds.get(sid)?.has(tool.callId)) return false;
    const output = typeof tool.output === "string" ? tool.output : "";
    if (output.trim()) {
      this.emit(sid, "tool.complete", {
        tool_id: tool.callId,
        name: tool.name,
        ...(tool.input !== undefined ? { args: tool.input } : {}),
        result_text: output,
      });
    }
    return true; // 即使無輸出可補也算「已由 live 投遞」——重複 append 才是 bug
  }

  private emit(sid: string, type: string, payload: Record<string, unknown>): void {
    this.linkb.send({
      t: "tui",
      agentLinkId: this.linkb.agentLinkId,
      sessionId: sid,
      frame: { jsonrpc: "2.0", method: "event", params: { type, session_id: sid, payload } },
    });
  }

  private async markDriven(key: string, sid: string): Promise<void> {
    this.driven.add(key);
    this.sidByKey.set(key, sid);
    this.mirror?.setDriven(key, sid); // #147 帶真大小寫 sid(打撈的 mirror_append 用)
    if (this.drivenPersist[key] !== sid) {
      this.drivenPersist[key] = sid; // #202 持久:重啟後仍知道哪些 key 歸 live、對賬要覆蓋誰
      this.saveDriveState();
    }
    // #244 新 driven key 的水位線初值:渠道接管(sid 本身是 agent: 開頭的真實 key)= 當前
    // 檔末——接管前的頻道歷史已由鏡像以**內容指紋** srcId 入庫,對賬若以 wm=0 用
    // __openclaw.id 再投一遍,兩套 dedup 鍵不互通、唯一索引擋不住 → 重複。
    // Macchiato 新建會話(包 macchiato 前綴)無前史,顯式置 0、不打 RPC。
    if (!(key in this.wmByKey)) {
      if (sid.startsWith("agent:")) await this.initWatermark(key);
      else {
        this.wmByKey[key] = 0;
        this.saveDriveState();
      }
    }
  }

  /** #244 渠道接管時把水位線推到檔末(失敗 → 留空,回合末對賬會保守處理)。 */
  private async initWatermark(key: string): Promise<void> {
    try {
      const rows = await this.historyRows(key);
      if (key in this.wmByKey) return; // 並發路徑已寫過 → 別回退
      this.wmByKey[key] = rows.length ? Math.max(...rows.map((r) => r.seq)) : 0;
      this.saveDriveState();
    } catch (e) {
      console.error(`[#244 init watermark failed ${key}] ${(e as Error).message}`);
    }
  }

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
        verified.kind !== "command.invoke" &&
        verified.kind !== "session.interrupt" &&
        verified.kind !== "session.e2e.disable"
      ) {
        throw new E2EControlError(`${verified.kind} is not supported by OpenClaw`);
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
        `[drive rejected] Link B outer/params session mismatch: ${String(msg.sessionId)} != ${String(params.session_id)}`,
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
    const key = keyForSid(sid);
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
          // #73/#89 語音優雅降級：OpenClaw 無 STT——audio 附件立即回「未能轉錄」失敗回執，
          // 否則 server 的「轉錄中…」占位永久卡住（CC 連接器同款修法）。新 server 已按
          // health `stt:false` 預路由、不會下達音頻；這是對舊 server 的兜底。
          const atts = Array.isArray(params.attachments)
            ? (params.attachments as Array<{ id?: string; kind?: string }>)
            : [];
          // E2E 附件没有端到端密文/完整性协议；在任何 STT、网络或落盘副作用前拒绝整帧。
          if (atts.length && this.e2e?.isE2E(sid)) {
            console.error(`[E2E prompt rejected ${sid}] attachments are not supported`);
            return;
          }
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
            }
          }
          // #60 真支持:非 audio 附件(圖片/文件)下載 → base64 → chat.send 的 attachments
          // 參數(gateway 原生收,落 agent 工作區/圖片走視覺,默認 20MB 上限)。
          // 單個失敗不擋正文,失敗的才發降級回執(E2E 跳過明文行——同舊)。
          const media = atts.filter((a) => a?.kind && a.kind !== "audio");
          const chatAtts: ChatAttachment[] = [];
          let failed = 0;
          for (const a of media) {
            try {
              chatAtts.push(await fetchChatAttachment(a as Record<string, unknown>));
            } catch (e) {
              failed += 1;
              console.error(`[#60 attachment ${String((a as any).name ?? (a as any).id)} failed] ${(e as Error).message}`);
            }
          }
          if (failed && !this.e2e?.isE2E(sid)) {
            this.emit(sid, "review.summary", {
              summary: `⚠️ ${failed} 個附件下載失敗已跳過(其餘 ${chatAtts.length} 個已送達 agent)`,
            });
          }
          let text = String(params.text ?? "").trim();
          if (!text && !chatAtts.length) return;
          if (text && this.e2e?.isE2E(sid)) {
            // §19：iOS 發來的是密文 → 解密再提交 agent；記下明文供回合結束的加密鏡像批
            try {
              text = this.e2e.decryptText(sid, text).trim();
            } catch (e) {
              console.error(`[E2E prompt decrypt failed for ${sid}] ${(e as Error).message}`);
              return;
            }
            if (!text && !chatAtts.length) return;
            const arr = this.pendingUser.get(key) ?? [];
            arr.push(text);
            this.pendingUser.set(key, arr);
          }
          await this.markDriven(key, sid);
          // #113 首個 prompt → 自動標題(越早越好,與 CC/Hermes 對齊)。僅 Macchiato 發起的會話
          // (鏡像來的 agent: key 有自己的頻道標題);E2E 跳過(標題事件是明文,防洩漏)。
          if (text && !sid.startsWith("agent:") && !this.e2e?.isE2E(sid) && !this.titled.has(sid)) {
            this.titled.add(sid);
            saveTitled(this.titled);
            void this.autoTitle(sid, text);
          }
          await this.sendPrompt(key, sid, text, chatAtts);
          return;
        }
        case "command.invoke": {
          // #199 skill 調用:翻成 gateway 命令管線文本 `/skill <name> [args]`(無專用 invoke RPC;
          // /skill 前綴無歧義——直呼 /<name> 雖也解析,但會與 /tools 等內建命令搶名字)。
          // 走 sendPrompt 全路徑:回合進行中 steer 注入、斷線重投同 prompt。
          const name = String(params.command ?? "")
            .trim()
            .replace(/^\//, "");
          if (!name) return;
          const args = String(params.args ?? "").trim();
          const text = `/skill ${name}${args ? ` ${args}` : ""}`;
          if (this.e2e?.isE2E(sid)) {
            // 命令名明文是既定設計;文本記入 pendingUser 供回合末加密鏡像批
            const arr = this.pendingUser.get(key) ?? [];
            arr.push(text);
            this.pendingUser.set(key, arr);
          }
          await this.markDriven(key, sid);
          // #381:默认日志只记命令名 + args 长度 + 截断 id,绝不写 args/prompt 正文
          console.log(
            formatCommandInvokeLog({
              tag: "#199",
              name,
              argsLen: args.length,
              sid: key,
              e2e: authenticated !== undefined,
            }),
          );
          logContent("command.invoke", text);
          await this.sendPrompt(key, sid, text, [], authenticated === undefined);
          return;
        }
        case "session.interrupt":
          // #5:重投等待期(#4)收到中斷 → 標記取消重投。
          if (this.retryWaiting.has(key)) {
            this.retryCancelled.add(key);
            console.log(`· 用戶中斷 → 取消待重投 prompt(${shortId(key)})`);
          }
          await this.gw.request("sessions.abort", { key });
          return;
        case "session.e2e.disable":
          if (authenticated?.kind !== "session.e2e.disable") {
            throw new E2EControlError("session.e2e.disable requires authenticated control");
          }
          if (!this.e2e || !this.mirror) {
            throw new E2EControlError("E2E disable dependencies unavailable");
          }
          this.assertE2EIdentitySafe();
          this.mirror.assertE2EIdentitySafe();
          this.e2e.markServerE2E(sid, "disable");
          this.e2e.beginDisable(sid, authenticated.envelope);
          await this.mirror.backfillE2E(sid, "disable");
          return;
        case "session.delete": {
          // #161 墓碑:app 刪會話 → 鏡像/打撈/對賬永不再碰;不刪 agent 側 .jsonl。
          this.mirror?.tombstone(key);
          if (this.drivenPersist[key]) {
            delete this.drivenPersist[key]; // #202 對賬也停(reconcileAll 迭代 drivenPersist)
            delete this.wmByKey[key];
            this.saveDriveState();
          }
          return;
        }
        case "session.create":
          await this.markDriven(key, sid); // 會話本體由首次 chat.send 自動建
          return;
        case "approval.respond": {
          await this.onApprovalRespond(sid, params, authenticated);
          return;
        }
        default:
          return; // 其它方法 v1 忽略
      }
    } catch (e) {
      this.counters.driveErrors += 1; // #10
      console.error(`[drive ${frame.method} failed for ${sid}] ${(e as Error).message}`);
      if (authenticated) throw e;
    }
  }

  /** #162:回合結束續投排隊的帶附件跟進(active 已清 → sendPrompt 走 chat.send 帶附件)。 */
  private async flushFollowUps(key: string): Promise<void> {
    const q = this.pendingFollowUps.get(key);
    if (!q?.length) return;
    this.pendingFollowUps.delete(key);
    for (const f of q) {
      try {
        await this.sendPrompt(key, f.sid, f.text, f.attachments);
      } catch (e) {
        this.counters.driveErrors += 1;
        console.error(`[#162 followup flush failed ${key}] ${(e as Error).message}`);
      }
    }
  }

  /** #4:提交 prompt(回合進行中 → steer 注入);連接死於在途 → 排一次重投。
   * #60:attachments 隨 chat.send 送達(steer 無附件通道——回合進行中只 steer 文字+回執說明)。 */
  private async sendPrompt(
    key: string,
    sid: string,
    text: string,
    attachments: ChatAttachment[] = [],
    retryOnDisconnect = true,
  ): Promise<void> {
    const idem = `mc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      if (this.active.has(key)) {
        if (attachments.length) {
          // #162 steer 無附件通道 → 整條(文字+附件)排隊,回合結束自動 chat.send 送達——
          // 不再丟附件叫用戶手動重發。代價:文字不 steer 進當前回合(隨附件下一回合到,與 codex 一致)。
          const q = this.pendingFollowUps.get(key) ?? [];
          q.push({ sid, text, attachments });
          this.pendingFollowUps.set(key, q);
          if (!this.e2e?.isE2E(sid)) {
            this.emit(sid, "review.summary", { summary: `⏳ 回合進行中——帶附件的消息已排隊,本回合結束後自動送達` });
          }
          return;
        }
        if (!text) return; // 純附件 + 回合進行中:無可 steer
        const r = await this.gw.request("sessions.steer", { key, message: text });
        this.recordSent(key, sid, text); // #244
        console.log(`· Turn in progress → steering follow-up into (${key}, status=${r?.status})`);
      } else {
        await this.gw.request("chat.send", {
          sessionKey: key,
          message: text,
          idempotencyKey: idem,
          ...(attachments.length ? { attachments } : {}),
        });
        this.recordSent(key, sid, text); // #244
      }
    } catch (e) {
      const m = (e as Error).message ?? "";
      // 只重投「連接死亡」類失敗(請求確定沒送達)。timeout 不重投:daemon 可能仍在處理,
      // steer 無冪等鍵,重投有雙發風險——寧丟勿雙發。業務錯誤(gateway error: …)照舊上拋記日誌。
      if (!m.includes("gateway connection lost") && !m.includes("gateway not connected")) throw e;
      // 签名控制已经持久消费 seq；不能一边排异步重试一边回 ok，否则设备 NACK 后
      // 以新 seq 重发会与旧重试双投。认证命令只在同步 gateway 请求成功后 ACK。
      if (!retryOnDisconnect) throw e;
      this.retryTask = this.retryPrompt(key, sid, text, idem, attachments);
    }
  }

  /** #4 prompt 級重試:等 gateway 重連後重投一次。
   * 去重雙保險:① promptRetried 本地記賬,同 (sid, 文本) 只重投一次;
   * ② chat.send 帶**原 idempotencyKey**——即使首發實際已進 daemon(理論窗口),OpenClaw 冪等去重。
   * 重投一律走 chat.send 不走 steer:斷線期間 lifecycle 事件丟失,active 表不可信;
   * 且重連通常意味 daemon 重啟、舊 run 已死。 */
  private async retryPrompt(key: string, sid: string, text: string, idem: string, attachments: ChatAttachment[] = []): Promise<void> {
    const rkey = `${sid}:${createHash("sha256").update(text).digest("hex")}`;
    if (this.promptRetried.has(rkey)) {
      console.error(`[#4 重投已用過,放棄 ${sid}]`);
      return;
    }
    if (this.promptRetried.size > 512) this.promptRetried.clear(); // 防無界(正常極少進來)
    this.promptRetried.add(rkey);
    this.retryWaiting.add(key);
    try {
      const deadline = Date.now() + 180_000; // 覆蓋重連退避(3→60s);gateway 真沒了則放棄
      while (Date.now() < deadline && !this.gw.isConnected) {
        if (this.retryCancelled.has(key)) {
          console.log(`[#5 重投已被用戶中斷取消 ${sid}]`);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (this.retryCancelled.has(key)) {
        console.log(`[#5 重投已被用戶中斷取消 ${sid}]`);
        return;
      }
      if (!this.gw.isConnected) {
        console.error(`[#4 重投放棄:gateway 180s 未重連 ${sid}]`);
        return;
      }
      await this.gw.request("chat.send", {
        sessionKey: key,
        message: text,
        idempotencyKey: idem,
        ...(attachments.length ? { attachments } : {}),
      });
      this.recordSent(key, sid, text); // #244
      this.counters.promptRetries += 1; // #10
      console.log(`· #4 prompt 重投成功 (${key},gateway 死於在途,已補投)`);
    } catch (e) {
      this.counters.promptRetryFails += 1; // #10
      console.error(`[#4 重投失敗,放棄 ${sid}] ${(e as Error).message}`);
    } finally {
      this.retryWaiting.delete(key);
      this.retryCancelled.delete(key);
    }
  }

  /** #113/#376:首條消息本地截斷生成標題(titles.generateTitle,零 LLM、零 RPC)→ session.title。 */
  private async autoTitle(sid: string, firstUserText: string): Promise<void> {
    try {
      const title = await generateTitle(this.gw, sid, firstUserText);
      if (!title) return;
      this.emit(sid, "session.title", { title });
      // #381:标题正文可能含用户首条消息片段,默认只记长度
      console.log(`· session.title len=${textLen(title)} → ${shortId(sid)}`);
      logContent("session.title", title);
    } catch (e) {
      console.error(`[auto title failed for ${shortId(sid)}] ${safeErr(e)}`);
    }
  }

  // ── F-09/#486 · #281 OpenClaw live 審批：exec.approval.* ↔ approval.request/respond ──

  /**
   * 官方 client 契約：hello-ok 後 list 回填斷線前已掛起的審批。
   * list 形狀在版本間可能是 `{approvals|pending|items:[]}` 或直接數組；字段寬鬆解析。
   * 失敗只記日誌（舊 gateway / 無 scope 時不擋主路徑）。
   */
  async backfillExecApprovals(): Promise<void> {
    try {
      const r = (await this.gw.request("exec.approval.list", {})) as
        | Record<string, unknown>
        | unknown[]
        | null
        | undefined;
      const arr = Array.isArray(r)
        ? r
        : Array.isArray((r as any)?.approvals)
          ? ((r as any).approvals as unknown[])
          : Array.isArray((r as any)?.pending)
            ? ((r as any).pending as unknown[])
            : Array.isArray((r as any)?.items)
              ? ((r as any).items as unknown[])
              : [];
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        // list 可能直接是 pending 投影(id+commandText…),也可能是 {id,request,…} 事件形。
        if (row.request && typeof row.request === "object") {
          this.onExecApprovalRequested(row);
        } else {
          this.onExecApprovalRequested({
            id: row.id,
            request: row,
            createdAtMs: row.createdAtMs,
            expiresAtMs: row.expiresAtMs,
          });
        }
      }
      if (arr.length) console.log(`· #486 exec.approval.list backfill: ${arr.length} pending`);
    } catch (e) {
      console.error(`[#486 exec.approval.list failed] ${safeErr(e)}`);
    }
  }

  /**
   * gateway 廣播 / list 回填 → Macchiato approval.request 卡。
   * 只處理 driven 會話（Macchiato 遠程驅動面）；渠道會話的審批留給原生 channel UI。
   * **不**改 OpenClaw 默認 exec 策略——僅在 gateway 已決定要人批時轉卡。
   */
  private onExecApprovalRequested(payload: Record<string, unknown>): void {
    const id = String(payload.id ?? "").trim();
    if (!id) return;
    if (this.pendingApprovals.has(id)) return; // 冪等：list 與 live 競態不雙掛

    const request = (
      payload.request && typeof payload.request === "object"
        ? (payload.request as Record<string, unknown>)
        : payload
    ) as Record<string, unknown>;
    const plan =
      request.systemRunPlan && typeof request.systemRunPlan === "object"
        ? (request.systemRunPlan as Record<string, unknown>)
        : undefined;

    const sessionKeyRaw =
      (typeof request.sessionKey === "string" && request.sessionKey) ||
      (typeof plan?.sessionKey === "string" && plan.sessionKey) ||
      (typeof payload.sessionKey === "string" && payload.sessionKey) ||
      "";
    const key = sessionKeyRaw ? sessionKeyRaw.toLowerCase() : "";
    if (!key || !this.driven.has(key)) {
      // 非 Macchiato 驅動會話：不搶渠道/Control UI 的審批路由。
      return;
    }
    const sid = this.sidByKey.get(key) ?? sidForKey(key);

    const command = String(
      request.command ??
        request.commandText ??
        plan?.commandText ??
        plan?.commandPreview ??
        "",
    ).trim();
    const cwd = String(request.cwd ?? plan?.cwd ?? "").trim();
    const host = typeof request.host === "string" ? request.host : undefined;
    const agentId =
      (typeof request.agentId === "string" && request.agentId) ||
      (typeof plan?.agentId === "string" && plan.agentId) ||
      undefined;
    const cmdPreview = (command || "(exec)").slice(0, 500);
    const desc = cwd
      ? `OpenClaw wants to run a command in ${cwd}`
      : host
        ? `OpenClaw wants to run a command on ${host}`
        : "OpenClaw wants to run a command";
    const patternKey = "shell";

    const unavailable = new Set<string>();
    const rawUnavail = request.unavailableDecisions ?? payload.unavailableDecisions;
    if (Array.isArray(rawUnavail)) {
      for (const d of rawUnavail) if (typeof d === "string" && d) unavailable.add(d);
    }

    const isE2E = this.e2e?.isE2E(sid) ?? false;
    let executionSnapshot: OpenClawApprovalExecutionSnapshot | undefined;
    let executionDisplay: string | undefined;
    let requestDigest: string | undefined;
    if (isE2E) {
      try {
        executionSnapshot = immutableE2EApprovalSnapshot<OpenClawApprovalExecutionSnapshot>({
          v: 1,
          connector: "openclaw",
          sessionId: sid,
          requestId: id,
          command: cmdPreview,
          cwd,
          ...(host ? { host } : {}),
          ...(agentId ? { agentId } : {}),
          ...(sessionKeyRaw ? { sessionKey: sessionKeyRaw } : {}),
        });
        executionDisplay = canonicalE2EApprovalDisplay(executionSnapshot);
        requestDigest = e2eApprovalRequestDigest(this.e2e!.requireKey(sid), executionSnapshot);
      } catch (error) {
        console.error(
          `[E2E approval auto-denied ${shortId(sid)}] ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        void this.resolveExecApproval(id, "deny");
        return;
      }
    }

    const approvalPlaintext =
      isE2E && requestDigest && executionSnapshot
        ? {
            command: cmdPreview,
            description: desc,
            patternKey,
            requestId: id,
            requestDigest,
            executionRequest: executionSnapshot,
            executionDisplay,
          }
        : undefined;
    if (
      approvalPlaintext &&
      Buffer.byteLength(JSON.stringify(approvalPlaintext), "utf8") > E2E_APPROVAL_PLAINTEXT_MAX_BYTES
    ) {
      console.error(
        `[E2E approval auto-denied ${shortId(sid)}] encrypted approval payload exceeds device limit`,
      );
      void this.resolveExecApproval(id, "deny");
      return;
    }
    // 尺寸閘門必須先於 emit / 掛起；否則設備拒卡後 gateway 永久等不到 resolve。
    const enc = approvalPlaintext
      ? this.e2e!.encryptContent(sid, approvalPlaintext)
      : undefined;

    this.pendingApprovals.set(id, {
      id,
      sid,
      requestDigest,
      executionSnapshot,
      unavailableDecisions: unavailable,
    });
    const order = this.pendingApprovalOrder.get(sid) ?? [];
    order.push(id);
    this.pendingApprovalOrder.set(sid, order);
    this.counters.approvalsRequested += 1;

    this.emit(sid, "approval.request", {
      command: isE2E ? "🔒 加密審批請求" : cmdPreview,
      pattern_key: patternKey,
      pattern_keys: [patternKey],
      description: isE2E ? "" : desc,
      ...(enc ? { enc } : {}),
      request_id: id,
      ...(requestDigest ? { request_digest: requestDigest } : {}),
    });
    console.log(`· #486 approval.request id=${id.slice(0, 12)}… → ${shortId(sid)}`);
  }

  /** 他處（CLI/渠道/逾時）已 resolve → 清本地掛起,避免後續 respond 誤發。 */
  private onExecApprovalResolved(payload: Record<string, unknown>): void {
    const id = String(payload.id ?? payload.approvalId ?? "").trim();
    if (!id) return;
    if (!this.pendingApprovals.has(id)) return;
    this.dropPendingApproval(id);
    this.counters.approvalsResolved += 1;
  }

  private dropPendingApproval(id: string): void {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return;
    this.pendingApprovals.delete(id);
    const order = this.pendingApprovalOrder.get(pending.sid);
    if (order) {
      const next = order.filter((x) => x !== id);
      if (next.length) this.pendingApprovalOrder.set(pending.sid, next);
      else this.pendingApprovalOrder.delete(pending.sid);
    }
  }

  /**
   * Macchiato choice → gateway decision:
   *   yes/allow → allow-once；always/all → allow-always（若 gateway 標 unavailable 則降為 once）；
   *   no/deny → deny。
   */
  private choiceToDecision(
    choice: string,
    all: boolean,
    unavailable: Set<string>,
  ): ExecApprovalDecision {
    const c = choice.toLowerCase();
    const allow = c === "allow" || c === "always" || c === "yes";
    if (!allow) return "deny";
    const wantAlways = all || c === "always";
    if (wantAlways && !unavailable.has("allow-always")) return "allow-always";
    return "allow-once";
  }

  private async resolveExecApproval(id: string, decision: ExecApprovalDecision): Promise<void> {
    try {
      await this.gw.request("exec.approval.resolve", { id, decision });
      this.counters.approvalsResolved += 1;
    } catch (e) {
      this.counters.driveErrors += 1;
      console.error(`[#486 exec.approval.resolve failed id=${id.slice(0, 12)}…] ${safeErr(e)}`);
      throw e;
    }
  }

  private async onApprovalRespond(
    sid: string,
    params: Record<string, unknown>,
    authenticated: AuthenticatedControlTag | undefined,
  ): Promise<void> {
    const reqId = typeof params.request_id === "string" ? params.request_id : "";
    const reqDigest = typeof params.requestDigest === "string" ? params.requestDigest : "";
    let pending: PendingExecApproval | undefined;

    if (authenticated) {
      if (authenticated.kind !== "approval.respond" || !reqId || !reqDigest) {
        throw new E2EControlError("authenticated approval is missing request identity");
      }
      const candidate = this.pendingApprovals.get(reqId);
      if (
        !candidate ||
        candidate.sid !== sid ||
        !candidate.executionSnapshot ||
        candidate.requestDigest !== reqDigest ||
        e2eApprovalRequestDigest(this.e2e!.requireKey(sid), candidate.executionSnapshot) !==
          reqDigest
      ) {
        throw new E2EControlError("approval request id/digest mismatch");
      }
      pending = candidate;
    } else if (reqId) {
      const candidate = this.pendingApprovals.get(reqId);
      if (candidate && candidate.sid === sid) pending = candidate;
    }
    if (!pending) {
      // FIFO 兜底（舊 server 不回帶 request_id）
      const order = this.pendingApprovalOrder.get(sid) ?? [];
      while (order.length && !pending) {
        const id = order[0]!;
        const candidate = this.pendingApprovals.get(id);
        if (candidate) pending = candidate;
        else order.shift();
      }
      this.pendingApprovalOrder.set(sid, order);
    }
    if (!pending) {
      if (authenticated) throw new E2EControlError("no matching pending approval");
      return;
    }

    const choice = String(params.choice ?? "deny");
    const all = params.all === true;
    const decision = this.choiceToDecision(choice, all, pending.unavailableDecisions);
    // 先 resolve 成功再 drop：gateway 失敗時保留 pending，用戶可重試（review #517）。
    await this.resolveExecApproval(pending.id, decision);
    this.dropPendingApproval(pending.id);
    console.log(
      `· #486 approval.respond id=${pending.id.slice(0, 12)}… decision=${decision} → ${shortId(sid)}`,
    );
  }

  onGatewayEvent(evt: GatewayEvent): void {
    // F-09/#486:exec 審批事件的 sessionKey 在 request 內嵌,不走頂層 driven 門——先分流。
    if (evt.event === "exec.approval.requested") {
      this.onExecApprovalRequested((evt.payload ?? {}) as Record<string, unknown>);
      return;
    }
    if (evt.event === "exec.approval.resolved") {
      this.onExecApprovalResolved((evt.payload ?? {}) as Record<string, unknown>);
      return;
    }

    const p = (evt.payload ?? {}) as Record<string, any>;
    const key = typeof p.sessionKey === "string" ? p.sessionKey.toLowerCase() : undefined;
    if (!key || !this.driven.has(key)) return;
    const sid = this.sidByKey.get(key) ?? sidForKey(key);

    const isE2E = this.e2e?.isE2E(sid) ?? false;
    if (evt.event === "agent" && p.stream === "lifecycle") {
      const phase = p.data?.phase;
      const runId: string = p.runId ?? "";
      if (phase === "start") {
        this.active.set(key, runId);
        if (isE2E) return; // §19 方案 A：E2E 會話不走明文 live, 內容由加密鏡像批投遞
        // OpenClaw 不做 token 流式（消息級）→ 回合一開跑就發 message.start, 
        // app 立刻顯示「AI 工作中」氣泡, 而不是整個回合靜默（UX）。
        if (runId && !this.started.has(runId)) {
          this.started.add(runId);
          this.emit(sid, "message.start", {});
        }
      } else if (phase === "end") {
        this.active.delete(key);
        if (isE2E) {
          this.mirror?.fastForward(key); // 明文 .jsonl 快進（E2E 內容只走加密批）
          return;
        }
        // #555 上游事件亂序:final 已到(或本回合根本沒開消息)→ 照舊立刻收尾;
        // final 還沒到 → 給一個 grace 窗等它,超時才走「兜底 complete」老路。
        if (this.completed.has(runId) || !runId || !this.started.has(runId)) {
          this.endTurn(key, sid, runId);
        } else if (!this.endGrace.has(runId)) {
          this.endGrace.set(
            runId,
            setTimeout(() => {
              this.endGrace.delete(runId);
              this.endTurn(key, sid, runId);
            }, END_GRACE_MS),
          );
        }
      }
      return;
    }

    // #261 live 工具事件:gateway 廣播 session.tool(需 sessions.subscribe,見 onGatewayConnected)。
    // 把回合進行中的工具塊實時映射成 Macchiato tool.start/tool.complete(對齊 CC/codex 的工具卡);
    // 此前工具塊只在回合末靠鏡像打撈補進歷史 → 回合進行中 app 端一片空白。同 toolCallId 配對:
    // start 帶 args 無 result、result 反之。E2E 跳過(不發明文卡,內容只走加密鏡像批)。
    if (evt.event === "session.tool") {
      if (isE2E) return;
      const d = (p.data ?? {}) as Record<string, any>;
      const toolId = String(d.toolCallId ?? d.itemId ?? "");
      if (!toolId) return;
      const name = String(d.name ?? "tool");
      const meta = typeof d.meta === "string" && d.meta ? d.meta : undefined;
      if (d.phase === "start") {
        this.rememberLiveTool(sid, toolId); // #432 打撈時據此原地補內容,不再重複 append
        this.emit(sid, "tool.start", {
          tool_id: toolId,
          name,
          ...(meta ? { context: meta } : {}),
          ...(d.args !== undefined ? { args_text: previewJson(d.args) } : {}),
        });
      } else if (d.phase === "result") {
        const args = d.args && typeof d.args === "object" ? (d.args as Record<string, unknown>) : {};
        const durMs = Number((d.result as Record<string, unknown>)?.durationMs);
        this.emit(sid, "tool.complete", {
          tool_id: toolId,
          name,
          args,
          result: d.result ?? { status: d.status ?? "completed", isError: !!d.isError },
          ...(Number.isFinite(durMs) && durMs > 0 ? { duration_s: durMs / 1000 } : {}),
          ...(toolResultText(d) ? { result_text: toolResultText(d) } : {}),
        });
      }
      // phase==="update"(增量進度)→ v1 不映射(回合末鏡像打撈仍兜底保真)。
      return;
    }

    if (evt.event === "chat") {
      const runId: string = p.runId ?? "";
      if (isE2E) {
        // §19：final 時把（解密過的）用戶消息 + agent 回覆加密成 enc, 走 mirror_append
        if (p.state === "final" && p.message?.role === "assistant" && this.e2e) {
          const reply = (Array.isArray(p.message.content) ? p.message.content : [])
            .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text)
            .join("");
          const msgs: Record<string, unknown>[] = (this.pendingUser.get(key) ?? []).map((t) => ({
            role: "user",
            enc: this.e2e!.encryptContent(sid, { text: t }),
          }));
          this.pendingUser.delete(key);
          if (reply.trim()) msgs.push({ role: "agent", enc: this.e2e.encryptContent(sid, { text: reply }) });
          if (msgs.length) {
            this.linkb.send({ t: "mirror_append", agentLinkId: this.linkb.agentLinkId, sessions: [
              { hermesSessionId: sid, source: "openclaw", e2e: true, messages: msgs },
            ] });
            console.log(`· E2E turn → encrypted mirror batch (${sid}, ${msgs.length} messages)`);
          }
        }
        return;
      }
      if (p.state === "delta" && typeof p.deltaText === "string" && p.deltaText) {
        if (!this.started.has(runId)) {
          this.started.add(runId);
          this.emit(sid, "message.start", {});
        }
        this.acc.set(runId, (this.acc.get(runId) ?? "") + p.deltaText);
        this.emit(sid, "message.delta", { text: p.deltaText });
      } else if (p.state === "final") {
        const m = p.message ?? {};
        if (m.role !== "assistant") return;
        const text = (Array.isArray(m.content) ? m.content : [])
          .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("");
        if (!this.started.has(runId)) {
          this.started.add(runId);
          this.emit(sid, "message.start", {});
        }
        this.emit(sid, "message.complete", { text });
        this.completed.add(runId);
        this.emitMediaFromText(sid, text); // #158 出站附件(fire-and-forget;E2E 不走本分支)
        // #555 lifecycle end 先到、被 grace 攔下 → final 落地即真正收尾(不必等滿 grace)
        const pending = this.endGrace.get(runId);
        if (pending) {
          clearTimeout(pending);
          this.endGrace.delete(runId);
          this.endTurn(key, sid, runId);
        }
      }
    }
  }

  /**
   * 回合真正收尾:定稿(若 final 沒來就用累積文本兜底)+ 清回合態 + 鏡像快進 + 對賬 + 跟進 flush。
   * 由 lifecycle end 觸發;#555 上游把 end 排在尾段 delta/final **之前**時,改由 final 觸發。
   */
  private endTurn(key: string, sid: string, runId: string): void {
    // 回合結束但沒收到 chat final（錯誤/中斷/靜默回合）→ 兜底 complete, 免得 app 卡轉圈
    if (runId && this.started.has(runId) && !this.completed.has(runId)) {
      this.emit(sid, "message.complete", { text: this.acc.get(runId) ?? "" });
    }
    if (runId) {
      const t = this.endGrace.get(runId);
      if (t) {
        clearTimeout(t);
        this.endGrace.delete(runId);
      }
      this.started.delete(runId);
      this.acc.delete(runId);
      this.completed.delete(runId);
    }
    this.mirror?.fastForward(key); // live 已投遞 → 鏡像水位線快進到文件末, 防雙投
    void this.reconcileTurnEnd(key, sid); // #202 回填 srcId + 推水位線(fire-and-forget)
    void this.flushFollowUps(key); // #162 排隊的帶附件跟進 → chat.send 續投
  }

  /**
   * #158 出站附件 + #372 capability-bound:
   * 回覆正文裡 `MEDIA:` 標的、且落在允許根內的文件 → media.attach(Hermes 同款,server 通吃)。
   * 裸絕對路徑不再自動上傳;根外(/etc、~/.ssh…)一律拒。
   */
  private emitMediaFromText(sid: string, text: string): void {
    try {
      // OpenClaw 目前無 per-session cwd 表;根 = macchiato 管理目錄 + MACCHIATO_MEDIA_ALLOW_ROOTS。
      const roots = resolveMediaAllowRoots();
      for (const path of extractMediaPaths(text, roots)) {
        const payload = readMediaFile(path, roots);
        if (!payload) continue;
        this.emit(sid, "media.attach", payload as unknown as Record<string, unknown>);
        // #381:不写文件名/路径(可能含客户数据);只记 size + 截断 sid
        console.log(`· media.attach size=${payload.size}B → ${shortId(sid)}`);
        logContent("media.attach", String(payload.name ?? ""));
      }
    } catch (e) {
      this.counters.driveErrors += 1;
      console.error(`[#158 media extract failed ${shortId(sid)}] ${safeErr(e)}`);
    }
  }

  // ── #202 對賬:live 漏收廣播 = driven key 唯一投遞路斷 → 靠 chat.history(穩定 id+seq)補齊 ──

  /** chat.history → 規整行 {seq, id, role, text}(role 只留 user/assistant;無 id/seq 的行丟棄)。 */
  private async historyRows(key: string): Promise<Array<{ seq: number; id: string; role: string; text: string }>> {
    const r = await this.gw.request<{ messages?: any[] }>("chat.history", { sessionKey: key, limit: 50 });
    const out: Array<{ seq: number; id: string; role: string; text: string }> = [];
    for (const m of r?.messages ?? []) {
      const meta = m?.__openclaw;
      if (!meta || typeof meta.seq !== "number" || typeof meta.id !== "string") continue;
      const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
      if (role !== "user" && role !== "assistant") continue; // 工具/系統行不入鏡像
      const text =
        typeof m.content === "string"
          ? m.content
          : (Array.isArray(m.content) ? m.content : [])
              .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
              .map((b: any) => b.text)
              .join("");
      out.push({ seq: meta.seq, id: meta.id, role, text });
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /** #244 記錄本回合經 Macchiato 發出的 prompt 文本(E2E 走加密批不參與明文對賬,不記)。 */
  private recordSent(key: string, sid: string, text: string): void {
    const t = text.trim();
    if (!t || this.e2e?.isE2E(sid)) return;
    const list = this.sentTexts.get(key) ?? [];
    list.push(t);
    if (list.length > 50) list.shift(); // 有界(未匹配的殘留別無限積)
    this.sentTexts.set(key, list);
  }

  /**
   * 回合末(lifecycle end):把本回合落庫的行 id 回填給 server 作 live 消息的 dedup_key
   * (#13 同款,Hermes 驗證過的模式),再推水位線。順序刻意:先回填、後推水位——若死在中間,
   * 重啟對賬會重投 >wm 的行,但 srcId 已回填 → 撞唯一索引被吃掉,不雙投。
   * #244:user 行按 sentTexts 文本匹配——匹配的是我們發的(只回填 srcId);不匹配的是
   * 渠道側(discord 等)user 行,live 從未投遞 → mirror_append 補投,別再讓水位線白白推過。
   */
  private async reconcileTurnEnd(key: string, sid: string): Promise<void> {
    if (this.e2e?.isE2E(sid)) return; // E2E 走加密批,不參與明文對賬
    try {
      const rows = await this.historyRows(key);
      const hasWm = key in this.wmByKey; // #244 初值缺失(接管時 gateway 沒連上)→ 保守:不補投
      const fresh = rows.filter((r) => r.seq > (this.wmByKey[key] ?? 0));
      if (!fresh.length) return;
      const sent = this.sentTexts.get(key) ?? [];
      const sentBefore = sent.length;
      let lastOurs: { seq: number; id: string } | undefined;
      let channelUsers: Array<{ id: string; text: string }> = [];
      for (const r of fresh) {
        if (r.role !== "user") continue;
        const i = sent.indexOf(r.text.trim());
        if (i >= 0) {
          sent.splice(i, 1); // 消耗一條(同文本多發按次匹配)
          lastOurs = { seq: r.seq, id: r.id };
        } else if (r.text.trim()) {
          channelUsers.push({ id: r.id, text: r.text });
        }
      }
      if (!lastOurs && sentBefore > 0 && channelUsers.length) {
        // #244 保守回退:本回合明明發過 prompt 卻一條都沒匹配上(OpenClaw 可能改寫落庫文本)
        // → 按舊語義把最後一條 user 行當我們的,且不補投(寧漏勿雙投)。
        lastOurs = { seq: 0, id: channelUsers[channelUsers.length - 1]!.id };
        channelUsers = [];
      }
      const lastAssistant = [...fresh].reverse().find((r) => r.role === "assistant");
      const items: Array<{ role: string; srcId: string }> = [];
      if (lastOurs) items.push({ role: "user", srcId: lastOurs.id }); // 只回填我們的行(#244)
      if (lastAssistant) items.push({ role: "agent", srcId: lastAssistant.id });
      if (items.length) {
        this.linkb.send({ t: "message_srcid", agentLinkId: this.linkb.agentLinkId, sessionId: sid, items });
      }
      if (hasWm && channelUsers.length && this.linkb.isReady) {
        // #244 渠道側 user 行補投(帶 __openclaw.id 作 srcId,重試撞唯一索引不雙投)
        this.linkb.send({
          t: "mirror_append",
          agentLinkId: this.linkb.agentLinkId,
          sessions: [
            {
              hermesSessionId: sid,
              source: "openclaw",
              messages: channelUsers.map((r) => ({ role: "user", text: r.text, srcId: r.id })),
            },
          ],
        });
        console.log(`· #244 渠道側 user 行補投 ${channelUsers.length} 條(${key})`);
      }
      this.wmByKey[key] = Math.max(...fresh.map((r) => r.seq));
      this.saveDriveState();
    } catch (e) {
      this.counters.driveErrors += 1; // #10
      console.error(`[#202 turn-end reconcile failed ${key}] ${(e as Error).message}`);
    }
  }

  /**
   * 對賬一個 driven key:seq>水位線的行 = live 沒投過(或投了但回填/推水位前死了)→
   * mirror_append + srcId 補投;已投+已回填的撞唯一索引被 server 吃掉。E2E 會話跳過。
   * Link B 未 ready 時整體跳過不推水位(mirror_append 不入斷線緩衝,發了即丟)。
   */
  async reconcileKey(key: string, sid: string): Promise<number> {
    if (this.e2e?.isE2E(sid)) return 0;
    if (!this.linkb.isReady) return 0;
    const rows = await this.historyRows(key);
    const fresh = rows.filter((r) => r.seq > (this.wmByKey[key] ?? 0) && r.text.trim());
    if (fresh.length) {
      this.linkb.send({
        t: "mirror_append",
        agentLinkId: this.linkb.agentLinkId,
        sessions: [
          {
            hermesSessionId: sid,
            source: "openclaw",
            messages: fresh.map((r) => ({ role: r.role === "assistant" ? "agent" : "user", text: r.text, srcId: r.id })),
          },
        ],
      });
      console.log(`· #202 對賬 ${key}:補投 ${fresh.length} 行(seq>${this.wmByKey[key] ?? 0})`);
    }
    if (rows.length) {
      this.wmByKey[key] = Math.max(this.wmByKey[key] ?? 0, ...rows.map((r) => r.seq));
      this.saveDriveState();
    }
    return fresh.length;
  }

  /** 對賬全部 driven key(啟動時 index.ts 調 + gateway 重連時 wire 的 onConnected 調)。 */
  async reconcileAll(reason: string): Promise<void> {
    const entries = Object.entries(this.drivenPersist);
    if (!entries.length) return;
    if (!this.linkb.isReady) return; // 下次觸發再補(水位線沒動,不丟)
    let delivered = 0;
    for (const [key, sid] of entries) {
      try {
        delivered += await this.reconcileKey(key, sid);
      } catch (e) {
        this.counters.driveErrors += 1;
        console.error(`[#202 reconcile failed ${key}] ${(e as Error).message}`);
      }
    }
    if (delivered) console.log(`· #202 對賬(${reason}):共補投 ${delivered} 行`);
  }
}
