/**
 * Link B 客戶端：用憑證連 Macchiato server。
 *   開 WSS → hello{connectorToken, agentLinkId, proto} → 等 ready → 收發幀（mirror_append / tui / e2e …）。
 * 自動重連；響應 server 的 ping/pong；auth_error 視為憑證失效（停連, 需重新配對）。
 */
import WebSocket from "ws";
import { LINK_B_PROTO } from "../../linkb/proto";
import { backoffMs, shouldAlert } from "../backoff";
import type { Creds } from "./creds";

export type FrameHandler = (msg: Record<string, unknown>) => void;
export type E2EStateApplier = (state: unknown) => readonly string[];
export type E2EProtectionCheck = (sid: string) => boolean;

// ── E2E 鏡像批次的出站形狀（#983 起是**單一真源**）────────────────────────────────
// 這張表是「加密會話允許出門的字段」的唯一定義：`filterBlockedOutbound` 用它把關，各連接器
// 的單測也拿**自己真造出來的條目**對着它跑（`cc/mirror` 的 `entry()`、openclaw 的實時條目）。
// 兩邊共用一份，是因為分開維護已經出過一次事故：
//
// 🩸 #983：`entry()` 在 #659（2026-08-01 加 `cwd`）和 #973/#968（2026-08-14 加 `origin`）先後
//    多帶了兩個字段，這張表沒跟上 → 每一幀加密實時鏡像都被整幀丟掉、**而且那條分支當時不打
//    日誌**。表現是「開了 E2E 之後發出去的消息永遠沒有回覆」：加密回合其實跑完了（agent 收到
//    解密明文、也回了），只是正文回不來——`sendE2ETurn` 早在 #348 就改成只走鏡像 WAL，鏡像一
//    斷，加密會話就完全啞了。CC 用戶自 2026-08-01 起、openclaw 自 2026-08-14 起都在裸奔，
//    整整兩週沒人看得出來，因為日誌裡它和「agent 沒回」完全同形。
//
// 所以這裡有兩條硬規矩，別再違反：
//   ① **加字段先加這張表**（連接器單測會替你紅，見各家 `*-e2e-wire.test.ts`）；
//   ② **丟幀必須說得出丟的是哪一種**——所以判定函數回的是「原因字符串」而不是 boolean。
const E2E_SESSION_KEYS = [
  "hermesSessionId", "title", "source", "startedAt", "archived", "e2e", "messages",
  // #659 會話工作目錄：**刻意明文**的元數據（server 用靜態層 KEK 加密落庫），否則加密會話
  // 永遠沒有文件夾。與 `source`/`archived` 同性質。
  "cwd",
  // #950/#967 血緣：元數據不是正文。E2E 下 server 看不見密文，這是唯一還能做歸屬判定的憑據。
  "origin",
] as const;
// `origin` 裡唯一的自由文本是 `label`（子 agent 名 / 路徑，#952 的父會話卡片用）。加密會話上
// **不放行**：其餘字段都是 id / 枚舉 / 數字，`label` 是唯一能把人話明文帶出去的口子。生產者
// 自己在 E2E 分支省掉它（見 openclaw mirror），這裡是兜底。
const E2E_ORIGIN_KEYS = [
  "threadId", "conversationId", "kind", "parentThreadId", "depth", "evidence",
] as const;
const E2E_MESSAGE_KEYS = ["role", "text", "reasoning", "tools", "createdAt", "srcId", "enc"] as const;

function extraKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function isCiphertext(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 40 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  );
}

function originIssue(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "origin 不是對象";
  const origin = value as Record<string, unknown>;
  const extra = extraKeys(origin, E2E_ORIGIN_KEYS);
  if (extra.length) {
    // label 走到這裡 = 生產者忘了在 E2E 分支省掉它，說清楚別讓人以為是形狀壞了。
    return extra.includes("label")
      ? "origin.label 是自由文本，加密會話不得明文帶出（生產者應在 E2E 分支省掉）"
      : `origin 多了字段 ${extra.join(",")}`;
  }
  for (const key of ["threadId", "conversationId", "kind", "evidence"] as const) {
    if (typeof origin[key] !== "string" || !origin[key]) return `origin.${key} 缺失或非字符串`;
  }
  if (origin.parentThreadId !== undefined && typeof origin.parentThreadId !== "string") {
    return "origin.parentThreadId 非字符串";
  }
  if (origin.depth !== undefined && typeof origin.depth !== "number") return "origin.depth 非數字";
  return null;
}

/**
 * 一條 `mirror_append` 會話條目能不能在**加密會話**上出門：`null` ＝ 可以，否則是人話原因。
 *
 * 回原因而不是 boolean 是刻意的（#983 的教訓）：丟幀時日誌要說得出丟的是哪一種，否則
 * 「發了消息但永遠沒有回覆」在日誌裡和「agent 沒回」完全同形，只能靠人一行行讀源碼去撞。
 */
export function encryptedMirrorSessionIssue(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "session 不是對象";
  const session = value as Record<string, unknown>;
  const extra = extraKeys(session, E2E_SESSION_KEYS);
  if (extra.length) return `多了未經審核的字段 ${extra.join(",")}（加字段要先進 E2E_SESSION_KEYS）`;
  if (typeof session.hermesSessionId !== "string" || !session.hermesSessionId) {
    return "hermesSessionId 缺失";
  }
  if (session.e2e !== true) return "e2e 標記不是 true";
  if (session.title !== undefined && !isCiphertext(session.title)) return "title 不是密文";
  if (session.cwd !== undefined && typeof session.cwd !== "string") return "cwd 非字符串";
  if (session.source !== undefined && typeof session.source !== "string") return "source 非字符串";
  if (session.origin !== undefined) {
    const issue = originIssue(session.origin);
    if (issue) return issue;
  }
  if (!Array.isArray(session.messages)) return "messages 不是數組";
  for (const [i, value] of session.messages.entries()) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return `messages[${i}] 不是對象`;
    }
    const message = value as Record<string, unknown>;
    const extraMsg = extraKeys(message, E2E_MESSAGE_KEYS);
    if (extraMsg.length) return `messages[${i}] 多了字段 ${extraMsg.join(",")}`;
    if (message.role !== "user" && message.role !== "agent" && message.role !== "system") {
      return `messages[${i}].role 非法`;
    }
    if (!isCiphertext(message.enc)) return `messages[${i}].enc 不是密文`;
    if (message.text !== undefined && message.text !== "") return `messages[${i}] 帶明文 text`;
    if (message.reasoning !== undefined && message.reasoning !== "") {
      return `messages[${i}] 帶明文 reasoning`;
    }
    if (message.tools !== undefined && !(Array.isArray(message.tools) && !message.tools.length)) {
      return `messages[${i}] 帶明文 tools`;
    }
  }
  return null;
}

export class LinkBClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private ready = false;
  /** #669 最近一次 ready 的時刻(epoch ms);從未連上 → null。心跳的 lastConnectedAt 來源。 */
  private lastReadyAtMs: number | null = null;
  /** #3 連續重連失敗計數(ready 歸零;指數退避 + 每 5 次告警)。 */
  private failures = 0;
  /** 斷線期間的出站幀緩衝(重連 ready 後 flush)——server 部署重啟撞上進行中回合時,
   * 回覆/標題曾被 send() 靜默丟掉(2026-07-12 影子會話實測)。有界:滿了丟最舊。 */
  private readonly pending: string[] = [];
  /** #380 與 PENDING_MAX 雙限：幀數 + 總字節，防 500 條大幀撐爆內存。 */
  private pendingBytes = 0;
  private blockedSessionIds = new Set<string>();
  /** #380 對齊 server connectorWss maxPayload（services/server/src/server.ts）。 */
  static readonly MAX_FRAME_BYTES = 8 * 1024 * 1024;
  static readonly PENDING_MAX = 500;
  static readonly PENDING_MAX_BYTES = 16 * 1024 * 1024;
  private static readonly MAX_TOP_LEVEL_KEYS = 64;
  private static readonly MAX_JSON_DEPTH = 32;
  private static readonly MAX_SESSION_ID_LEN = 256;
  private static readonly MAX_TYPE_LEN = 64;
  private static readonly MAX_BULK_ARRAY_LEN = 10_000;
  private readonly handlers = new Set<FrameHandler>();
  /** #199 每次 ready(含重連)都觸發——server 重啟丟內存緩存的上報(如 commands 清單)靠它重發。 */
  private readonly readyHandlers = new Set<() => void>();
  private firstReady: (() => void) | null = null;
  private readonly readyOnce: Promise<void>;

  /** #246 auth_error(憑證吊銷/proto 不符,非瞬時)= 終端態:退出非零讓 supervisor(systemd)
   * 接手——重試/最終 stop,消滅「進程活著但不連、不重連、與離線不可區分」的殭屍。測試可覆蓋。
   * #387 kind="revoked"(app 解綁/token 已作廢)= 永久終端態:調用方應隔離本地憑證後以
   * 特殊碼退出(78,新版 unit RestartPreventExitStatus=78 不再拉起;舊 unit 重啟後因無憑證
   * 進入等待配對,不再用死 token 空轉)。 */
  onFatal: (kind?: "revoked") => void = () => process.exit(1);

  /** #247 半開連接偵測:server 每 30s WS-ping,連續 LIVENESS_MS 無任何入站(含 ping)= 對端已亡
   * (readyState 恒 OPEN、發幀進黑洞)→ terminate 觸發 onClose 重連。收每幀/每 ping 續期。 */
  private livenessTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly creds: Creds,
    private readonly applyE2EState?: E2EStateApplier,
    private readonly socketFactory: (url: string) => WebSocket = (url) =>
      new WebSocket(url, { handshakeTimeout: 20000, maxPayload: LinkBClient.MAX_FRAME_BYTES }),
    private readonly isProtected?: E2EProtectionCheck,
  ) {
    this.readyOnce = new Promise((r) => (this.firstReady = r));
  }

  get agentLinkId(): string {
    return this.creds.agentLinkId;
  }
  get isReady(): boolean {
    return this.ready;
  }
  /** #669 最近一次連上 server 的時刻(epoch ms);從未連上 → null。斷線後**不清零**——
   * 「上次還連著是什麼時候」正是 supervisor 判「活著但連不上」要看的東西。 */
  get lastConnectedAtMs(): number | null {
    return this.lastReadyAtMs;
  }

  /** pending-enable 只有在 server 成功 ACK 后才解除本连接的 per-session 出站隔离。 */
  unblockSession(sid: string): void {
    this.blockedSessionIds.delete(sid);
  }

  /** 監聽 server → 連接器的幀（tui / mirror_nack / e2e_wrap_request …；ready/auth_error/ping 已內部處理）。 */
  onFrame(h: FrameHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  /** #199 每次 ready(含重連)回調。 */
  onReady(h: () => void): () => void {
    this.readyHandlers.add(h);
    return () => this.readyHandlers.delete(h);
  }

  // 能力宣告(hello 時注入)。**start() 前由各家 index.ts 設定**;抽進 core 前 CC 是寫死全開、
  // Codex 是引擎選型後才設,合併成注入位以免任何一家被另一家的默認值代表。
  //   - claude-code:SDK 固定具備 → 三個全開;
  //   - codex:**引擎級**能力(app-server 有 thread/fork、turn/steer、turn/interrupt;exec v1 沒有)
  //     → initialize 探活成功才設,exec 回退不宣告(且從不宣告 fork);
  //   - openclaw:都不宣告,只有 mirrorDurable。
  /** #473 SDK forkSession 按點分叉後重指(原 transcript 不動)。 */
  declareRewind = false;
  /** #223 同一 SDK 能力的非破壞性版:分叉新會話,老會話不動。 */
  declareFork = false;
  /** #552 回合中發送三模式:inject / queue / interrupt。 */
  declarePromptModes = false;

  /** 連接 + hello + 等首次 ready。 */
  async start(): Promise<void> {
    this.connect();
    await this.readyOnce;
  }

  private connect(): void {
    const ws = this.socketFactory(this.creds.serverUrl);
    this.ws = ws;
    ws.on("ping", () => {
      if (this.ws !== ws) return;
      this.bumpLiveness();
    }); // #247 server WS-ping 續期 liveness
    ws.on("open", () => {
      if (this.ws !== ws) {
        ws.close();
        return;
      }
      this.bumpLiveness();
      ws.send(
        JSON.stringify({
          t: "hello",
          connectorToken: this.creds.connectorToken,
          agentLinkId: this.creds.agentLinkId,
          proto: LINK_B_PROTO,
          e2eFailClosed: 1,
          e2eControlAuth: 1,
          e2eKeyVersionBinding: 1,
          // #731：本連接器支援配對 secret + wrap 時校驗 authProof（有 secret 才真正 enforce）。
          e2eDeviceAuth: 1,
          e2eQuiesce: 1,
          mirrorDurable: 1, // #348 durable outbox + 懂 mirror_nack.code 終態語義
          // 能力位按 connector/引擎注入:**沒有的能力就不宣告**,於是 server 409、UI 根本不出
          // 入口,而不是讓用戶下達後等 30s 超時(F-13 能力誠實原則)。
          ...(this.declareRewind ? { rewind: 1 } : {}),
          ...(this.declareFork ? { fork: 1 } : {}),
          // #552 inject=推進 streaming input(CLI 原生排隊注入)、queue=連接器側排隊回合末投遞、
          // interrupt=打斷接管(歷史默認)。
          ...(this.declarePromptModes ? { promptModes: ["inject", "queue", "interrupt"] } : {}),
        }),
      );
    });
    ws.on("message", (raw) => {
      if (this.ws !== ws) return; // superseded socket 的迟到 ACK/ready 绝不能改当前状态
      this.handleFrame(raw);
    });
    ws.on("close", () => {
      if (this.ws !== ws) return; // 旧 socket close 不能把新连接打回 offline/触发第二条重连
      this.onClose();
    });
    ws.on("error", () => {
      if (this.ws !== ws) return;
      /* 'close' 隨後觸發, 統一在 onClose 重連 */
    });
  }

  private handleFrame(raw: WebSocket.RawData): void {
    this.bumpLiveness(); // #247 任何入站幀續期
    const nbytes = LinkBClient.rawByteLength(raw);
    if (nbytes > LinkBClient.MAX_FRAME_BYTES) {
      console.error(`Link B inbound frame dropped: ${nbytes} bytes > maxPayload`);
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.error("Link B inbound frame dropped: invalid JSON");
      return;
    }
    if (!LinkBClient.isSaneInbound(msg)) {
      console.error(
        `Link B inbound frame dropped: schema/size bounds (t=${String((msg as { t?: unknown })?.t)})`,
      );
      return;
    }
    switch (msg.t) {
      case "ready": {
        try {
          // #347 server E2E 快照必须先于 ready/flush。bare ready 无法区分“零 E2E”
          // 与旧 server 不支持对账；runtime 必传 applier，故 bare ready fail closed。未传 callback
          // 的纯 client/legacy 测试保持旧行为，不参与 E2E 状态判定。
          if (this.applyE2EState) {
            if (!Object.prototype.hasOwnProperty.call(msg, "e2eState")) {
              throw new Error("missing required e2eState");
            }
            const missingPendingEnable = this.applyE2EState(msg.e2eState);
            if (
              !Array.isArray(missingPendingEnable) ||
              missingPendingEnable.some((sid) => typeof sid !== "string" || !sid)
            ) {
              throw new Error("E2E state applier returned invalid pending-enable sessions");
            }
            const blocked = new Set(missingPendingEnable);
            this.blockedSessionIds = blocked;
            this.filterPendingPlaintext(blocked);
          }
        } catch (error) {
          console.error(`Link B E2E state rejected — ${error instanceof Error ? error.message : String(error)}`);
          this.ready = false;
          this.close();
          this.onFatal();
          return;
        }
        this.ready = true;
        this.lastReadyAtMs = Date.now(); // #669 心跳的 lastConnectedAt
        this.failures = 0; // #3 連上歸零
        this.flushPending();
        if (this.firstReady) {
          this.firstReady();
          this.firstReady = null;
        }
        for (const h of this.readyHandlers) {
          try {
            h();
          } catch {
            /* 監聽器自負其責 */
          }
        }
        // ⚠️ 回歸契約:scripts/regression/run-cc-regression.mjs、run-codex-regression.mjs、run-regression.mjs、run-folders-e2e.mjs 斷言「Link B ready」,改動需同步
        console.log("✓ Link B ready — connected to Macchiato");
        return;
      }
      case "auth_error": {
        // #387 區分「永久吊銷」與其他終端態:server 撤銷綁定時 kick 帶 reason="revoked";
        // 踢時本機離線的,重連 hello 撞 "invalid connector token"(token hash 已置空)——同義。
        const reason = typeof msg.reason === "string" ? msg.reason : "";
        const revoked = reason === "revoked" || reason.includes("invalid connector token");
        console.error(`Link B auth_error: ${msg.reason} — 憑證吊銷或 proto 不符,需重新配對/升級`);
        this.close();
        this.onFatal(revoked ? "revoked" : undefined); // #246 退出交 supervisor,不再靜默殭屍空轉
        return;
      }
      case "ping":
        this.send({ t: "pong" });
        return;
      default: {
        // hello→ready 之间尚未套用权威 E2E floor；任何业务帧都可能穿过 legacy/plaintext 路径。
        if (!this.ready) {
          console.error(`Link B pre-ready frame rejected: ${String(msg.t)}`);
          return;
        }
        // 入站幀可觀測（排障關鍵：能一眼看出 server 到底發沒發、發了什麼）
        const method = (msg.frame as { method?: string } | undefined)?.method;
        console.log(`← linkB ${String(msg.t)}${method ? ` ${method}` : ""}${msg.sessionId ? ` sid=${String(msg.sessionId).slice(0, 40)}` : ""}`);
        for (const h of this.handlers) {
          try {
            h(msg);
          } catch {
            /* 監聽器自負其責 */
          }
        }
      }
    }
  }

  /**
   * pending-enable 尚未建 K_S：首连前按旧状态积压的对应 TUI / import / mirror 内容必定是明文。
   * 单会话帧整帧丢弃；批次按 session 过滤，过滤后空批整帧丢弃。
   *
   * ⚠️ 单会话帧这一侧**不按 `t` 白名单**（合并 #572 时曾短暂收窄成
   * tui/voice_transcript/connector_push——Codex 原实现没有这层门，是三家里最严的那份）。
   * 理由：这里是「宁可多丢一帧、也不让首连前的旧明文借 ready flush 出去」，而 `t` 的集合
   * 会随产品长出新帧型；白名单漏一个就是漏一条明文路径。丢错的代价只是让用户重发，
   * 而这些帧本来就属于 server 认为该加密、本地却还没有 K_S 的会话。
   *
   * 两类例外，都不是「内容帧」：
   *  - 批次帧（import_batch / mirror_append）按 session 过滤而非整帧丢：混合批要保住其它会话；
   *  - **协议答复**（e2e_control_result）：严格 shape、error 只能是两个字面量，携带不了内容；
   *    最终 wire gate 对受保护会话也**明确放行**它（见 filterBlockedOutbound）。在这里丢掉
   *    只会让 device 等一个永远不来的答复而超时，安全上一无所获。
   *    e2e_key / e2e_backfill 出站只带 hermesSessionId，天然不在下面的判定字段里。
   */
  private filterPendingPlaintext(sessionIds: Set<string>): void {
    if (!sessionIds.size || !this.pending.length) return;
    const kept: string[] = [];
    let droppedFrames = 0;
    let filteredSessions = 0;
    let changed = false;
    for (const raw of this.pending) {
      try {
        const msg = JSON.parse(raw) as Record<string, any>;
        const isBatch =
          (msg.t === "import_batch" || msg.t === "mirror_append") && Array.isArray(msg.sessions);
        const isProtocolAnswer = msg.t === "e2e_control_result";
        // 只看三家原实现看过的字段。**不**含 hermesSessionId：e2e_key / e2e_backfill 用它，
        // 而它们是必须送达的协议帧（见上）。
        const candidateSids = [
          msg.sessionId,
          msg.frame?.params?.session_id,
          msg.t === "connector_push" ? msg.chatId : undefined,
        ];
        if (
          !isBatch &&
          !isProtocolAnswer &&
          candidateSids.some((sid) => typeof sid === "string" && sessionIds.has(sid))
        ) {
          droppedFrames++;
          changed = true;
          continue;
        }
        if (isBatch) {
          const sessions = msg.sessions as Array<Record<string, unknown>>;
          const filtered = sessions.filter(
            (session) =>
              !(
                session !== null &&
                typeof session === "object" &&
                typeof session.hermesSessionId === "string" &&
                sessionIds.has(session.hermesSessionId)
              ),
          );
          const removed = sessions.length - filtered.length;
          if (removed) {
            filteredSessions += removed;
            changed = true;
            if (!filtered.length) {
              if (msg.t === "import_batch" && msg.done === true) {
                msg.sessions = [];
                kept.push(JSON.stringify(msg));
                continue;
              }
              droppedFrames++;
              continue;
            }
            msg.sessions = filtered;
            kept.push(JSON.stringify(msg));
            continue;
          }
        }
      } catch {
        // pending 只来自本类 JSON.stringify；异常条目沿用既有 flush 行为。
      }
      kept.push(raw);
    }
    if (changed) {
      this.replacePending(kept);
      console.error(
        `⚠️ E2E ready 对账清理首连前明文：丢弃 ${droppedFrames} 帧、` +
          `过滤 ${filteredSessions} 个 import/mirror session（请重试相关消息）`,
      );
    }
  }

  /**
   * 發一個 Link B 幀;斷線期間**緩衝**、ready 後按序 flush(此前直接丟——server 每次部署
   * 重啟都會把撞上的回合尾巴丟掉,會話卡成「影子」)。鏡像幀例外:有自己的水位線/nack
   * 回退,緩衝反而會與重發重複 → 照舊丟棄。
   */
  private sessionIsProtected(sid: unknown): boolean {
    if (typeof sid !== "string" || !sid) return false;
    return this.blockedSessionIds.has(sid) || (this.isProtected?.(sid) ?? false);
  }

  /** #380 入站 raw 字節長度（ws 可能給 Buffer / ArrayBuffer / Buffer[]）。 */
  static rawByteLength(raw: WebSocket.RawData): number {
    // 用 unknown 走這幾道判斷:RawData 的宣告只有 Buffer/ArrayBuffer/Buffer[],逐個排除後
    // 會窄化成 never,而 ws 實際可能給 TypedArray/DataView,分支必須留著。
    const r: unknown = raw;
    if (Buffer.isBuffer(r)) return r.length;
    if (Array.isArray(r)) return r.reduce((n: number, b: Buffer) => n + b.length, 0);
    if (r instanceof ArrayBuffer) return r.byteLength;
    if (ArrayBuffer.isView(r)) return r.byteLength;
    return Buffer.byteLength(String(r), "utf8");
  }

  private static jsonDepthOk(value: unknown, maxDepth: number, depth = 0): boolean {
    if (depth > maxDepth) return false;
    if (value === null || typeof value !== "object") return true;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!LinkBClient.jsonDepthOk(item, maxDepth, depth + 1)) return false;
      }
      return true;
    }
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (!LinkBClient.jsonDepthOk(v, maxDepth, depth + 1)) return false;
    }
    return true;
  }

  /**
   * #380 入站基本邊界：type / 頂層鍵數 / 嵌套深度 / 關鍵 id 長度 / 批次數組長度。
   * 未知 t 放行但受頂層約束（完整 zod 分型留後續）。
   */
  static isSaneInbound(msg: unknown): msg is Record<string, unknown> {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return false;
    const obj = msg as Record<string, unknown>;
    if (Object.keys(obj).length > LinkBClient.MAX_TOP_LEVEL_KEYS) return false;
    if (typeof obj.t !== "string" || !obj.t || obj.t.length > LinkBClient.MAX_TYPE_LEN) return false;
    if (!LinkBClient.jsonDepthOk(obj, LinkBClient.MAX_JSON_DEPTH)) return false;
    for (const key of ["sessionId", "hermesSessionId", "chatId", "agentLinkId"] as const) {
      const v = obj[key];
      if (v !== undefined && (typeof v !== "string" || v.length > LinkBClient.MAX_SESSION_ID_LEN)) {
        return false;
      }
    }
    const frame = obj.frame;
    if (frame !== undefined) {
      if (frame === null || typeof frame !== "object" || Array.isArray(frame)) return false;
      const params = (frame as { params?: unknown }).params;
      if (params !== undefined) {
        if (params === null || typeof params !== "object" || Array.isArray(params)) return false;
        const sid = (params as { session_id?: unknown }).session_id;
        if (
          sid !== undefined &&
          (typeof sid !== "string" || sid.length > LinkBClient.MAX_SESSION_ID_LEN)
        ) {
          return false;
        }
      }
    }
    for (const key of ["sessions", "items", "messages", "disabledReceipts"] as const) {
      const v = obj[key];
      if (Array.isArray(v) && v.length > LinkBClient.MAX_BULK_ARRAY_LEN) return false;
    }
    const e2e = obj.e2eState;
    if (e2e !== null && e2e !== undefined) {
      if (typeof e2e !== "object" || Array.isArray(e2e)) return false;
      const sessions = (e2e as { sessions?: unknown }).sessions;
      const receipts = (e2e as { disabledReceipts?: unknown }).disabledReceipts;
      if (Array.isArray(sessions) && sessions.length > LinkBClient.MAX_BULK_ARRAY_LEN) return false;
      if (Array.isArray(receipts) && receipts.length > LinkBClient.MAX_BULK_ARRAY_LEN) return false;
    }
    return true;
  }

  private replacePending(frames: string[]): void {
    this.pending.splice(0, this.pending.length, ...frames);
    this.pendingBytes = frames.reduce((n, f) => n + Buffer.byteLength(f, "utf8"), 0);
  }

  private enqueuePending(raw: string): void {
    const nbytes = Buffer.byteLength(raw, "utf8");
    if (nbytes > LinkBClient.MAX_FRAME_BYTES) {
      console.error(`Link B outbound frame dropped: ${nbytes} bytes > maxPayload`);
      return;
    }
    let dropped = 0;
    while (
      this.pending.length > 0 &&
      (this.pending.length >= LinkBClient.PENDING_MAX ||
        this.pendingBytes + nbytes > LinkBClient.PENDING_MAX_BYTES)
    ) {
      const old = this.pending.shift()!;
      this.pendingBytes -= Buffer.byteLength(old, "utf8");
      dropped++;
    }
    if (this.pendingBytes + nbytes > LinkBClient.PENDING_MAX_BYTES) {
      console.error(
        `Link B pending drop: frame ${nbytes} bytes exceeds remaining byte budget`,
      );
      return;
    }
    if (dropped) {
      console.error(`⚠️ Link B pending backpressure: dropped ${dropped} oldest frame(s)`);
    }
    this.pending.push(raw);
    this.pendingBytes += nbytes;
  }

  private static onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    return Object.keys(value).every((key) => allowed.includes(key));
  }

  private static looksLikeCiphertext(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length >= 40 &&
      value.length % 4 === 0 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    );
  }

  private static safeEncryptedSession(value: unknown): boolean {
    return encryptedMirrorSessionIssue(value) === null;
  }

  private static safeProtectedTui(raw: Record<string, any>): boolean {
    const frame = raw.frame;
    const params = frame?.params;
    if (
      frame === null ||
      typeof frame !== "object" ||
      Array.isArray(frame) ||
      params === null ||
      typeof params !== "object" ||
      Array.isArray(params) ||
      frame.method !== "event" ||
      !LinkBClient.onlyKeys(frame, ["jsonrpc", "method", "params"]) ||
      !LinkBClient.onlyKeys(params, ["type", "session_id", "payload"])
    ) return false;
    const payload = params.payload;
    if (params.type === "turn.usage") {
      return (
        payload !== null &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        LinkBClient.onlyKeys(payload, ["output_tokens"]) &&
        Number.isSafeInteger(payload.output_tokens) &&
        payload.output_tokens >= 0
      );
    }
    if (params.type === "approval.request") {
      return (
        payload !== null &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        LinkBClient.onlyKeys(payload, [
          "command", "pattern_key", "pattern_keys", "description", "enc", "request_id", "request_digest",
        ]) &&
        payload.command === "🔒 加密審批請求" &&
        (payload.description === "" || payload.description === undefined || payload.description === null) &&
        LinkBClient.looksLikeCiphertext(payload.enc) &&
        typeof payload.request_id === "string" &&
        !!payload.request_id &&
        typeof payload.request_digest === "string" &&
        !!payload.request_digest
      );
    }
    // #273 E2E clarify：問題/選項僅在 enc；wire 占位 + 空 choices。
    if (params.type === "clarify.request") {
      return (
        payload !== null &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        LinkBClient.onlyKeys(payload, [
          "question", "choices", "request_id", "request_digest", "enc",
        ]) &&
        payload.question === "🔒 Encrypted question" &&
        (payload.choices === undefined ||
          payload.choices === null ||
          (typeof payload.choices === "object" &&
            !Array.isArray(payload.choices) &&
            Object.keys(payload.choices as object).length === 0)) &&
        LinkBClient.looksLikeCiphertext(payload.enc) &&
        typeof payload.request_id === "string" &&
        !!payload.request_id &&
        typeof payload.request_digest === "string" &&
        !!payload.request_digest
      );
    }
    // #273 E2E secret：prompt/env 僅在 enc。
    if (params.type === "secret.request") {
      return (
        payload !== null &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        LinkBClient.onlyKeys(payload, [
          "prompt", "env_var", "request_id", "request_digest", "enc",
        ]) &&
        payload.prompt === "🔒 Encrypted secret request" &&
        (payload.env_var === "" || payload.env_var === undefined || payload.env_var === null) &&
        LinkBClient.looksLikeCiphertext(payload.enc) &&
        typeof payload.request_id === "string" &&
        !!payload.request_id &&
        typeof payload.request_digest === "string" &&
        !!payload.request_digest
      );
    }
    return false;
  }

  private safeE2EControlResult(raw: Record<string, unknown>): boolean {
    if (
      !LinkBClient.onlyKeys(raw, [
        "t",
        "agentLinkId",
        "sessionId",
        "hermesSessionId",
        "msgId",
        "ok",
        "error",
      ]) ||
      raw.t !== "e2e_control_result" ||
      raw.agentLinkId !== this.creds.agentLinkId ||
      typeof raw.sessionId !== "string" ||
      !raw.sessionId ||
      typeof raw.hermesSessionId !== "string" ||
      !raw.hermesSessionId ||
      typeof raw.msgId !== "string" ||
      !raw.msgId ||
      typeof raw.ok !== "boolean"
    ) return false;
    return raw.ok
      ? raw.error === undefined
      : raw.error === "control_rejected" || raw.error === "side_effect_failed";
  }

  /**
   * #634 / #368：`e2e_quiesce_result` 是 disable 屏障的唯一回執。
   * enable 時會話還不是 protected（先 quiesce 再 markSessionE2E），結果能出去；
   * disable 時會話已是 E2E → 若本閘不放行，server 永遠等不到 barrier、關密死鎖。
   * 嚴格 shape：無正文、error 僅兩個字面量。
   */
  private safeE2EQuiesceResult(raw: Record<string, unknown>): boolean {
    if (
      !LinkBClient.onlyKeys(raw, [
        "t",
        "agentLinkId",
        "hermesSessionId",
        "requestId",
        "mode",
        "ok",
        "error",
      ]) ||
      raw.t !== "e2e_quiesce_result" ||
      raw.agentLinkId !== this.creds.agentLinkId ||
      typeof raw.hermesSessionId !== "string" ||
      !raw.hermesSessionId ||
      typeof raw.requestId !== "string" ||
      !raw.requestId ||
      (raw.mode !== "enable" && raw.mode !== "disable") ||
      typeof raw.ok !== "boolean"
    ) return false;
    return raw.ok
      ? raw.error === undefined
      : raw.error === "busy_timeout" || raw.error === "quiesce_failed";
  }

  private static outboundSessionIds(raw: Record<string, any>): string[] {
    const ids = [raw.sessionId, raw.hermesSessionId, raw.chatId, raw.frame?.params?.session_id];
    if (Array.isArray(raw.sessions)) {
      for (const session of raw.sessions) ids.push(session?.hermesSessionId);
    }
    return [...new Set(ids.filter((sid): sid is string => typeof sid === "string" && !!sid))];
  }

  /** 最终 wire 闸门：producer 的旧明文任务即使在 live enable 后才结束，也不能越过这里。 */
  private filterBlockedOutbound(msg: Record<string, unknown>): Record<string, unknown> | null {
    const raw = msg as Record<string, any>;
    try {
      // 先于 floor/路由判断做全局 strict shape，避免空/伪造 sid 绕过保护，
      // 也不允许异常详情借 error 字段成为 server 可见侧信道。
      if (raw.t === "e2e_control_result") {
        return this.safeE2EControlResult(raw) ? msg : null;
      }
      // #634：disable 路徑上會話已是 protected；不放行 = 關密永遠卡在 quiesce。
      if (raw.t === "e2e_quiesce_result") {
        return this.safeE2EQuiesceResult(raw) ? msg : null;
      }
      if ((raw.t === "import_batch" || raw.t === "mirror_append") && Array.isArray(raw.sessions)) {
        const sessions = raw.sessions.filter((session: unknown) => {
          const sid =
            session !== null && typeof session === "object"
              ? (session as { hermesSessionId?: unknown }).hermesSessionId
              : undefined;
          if (typeof sid === "string" && this.blockedSessionIds.has(sid)) return false;
          if (!this.sessionIsProtected(sid)) return true;
          // #983 這條分支此前**一條日誌都不打**，於是「加密會話發了消息永遠沒回覆」在日誌裡
          // 和「agent 沒回」完全同形，白名單漏字段整整兩週沒人看得出來。丟就得說原因。
          if (raw.t !== "mirror_append") {
            console.error(`[E2E outbound dropped] ${String(raw.t)} 不得攜帶加密會話 ${String(sid)}`);
            return false;
          }
          const issue = encryptedMirrorSessionIssue(session);
          if (issue) {
            console.error(`[E2E outbound dropped] mirror_append ${String(sid)}：${issue}`);
            return false;
          }
          return true;
        });
        if (sessions.length !== raw.sessions.length) {
          if (!sessions.length && !(raw.t === "import_batch" && raw.done === true)) return null;
          if (raw.t === "mirror_append") return { ...raw, sessions };
          raw.sessions = sessions;
        }
        if (raw.t === "mirror_append") return msg;
      }

      const protectedFrame = LinkBClient.outboundSessionIds(raw).some((sid) =>
        this.sessionIsProtected(sid),
      );
      if (!protectedFrame) return msg;
      if (raw.t === "e2e_key") return msg;
      if (raw.t === "tui" && LinkBClient.safeProtectedTui(raw)) return msg;
      if (raw.t === "e2e_backfill") {
        if (
          typeof raw.hermesSessionId === "string" &&
          this.blockedSessionIds.has(raw.hermesSessionId) &&
          raw.mode === "disable"
        ) return null;
        if (raw.found === false && raw.session === undefined && raw.disableReceipt === undefined) return msg;
        if (
          raw.found === true &&
          raw.session?.hermesSessionId === raw.hermesSessionId &&
          ((raw.mode === "disable" &&
            raw.session.e2e !== true &&
            raw.disableReceipt !== null &&
            typeof raw.disableReceipt === "object") ||
            ((raw.mode === undefined || raw.mode === "enable") &&
              raw.disableReceipt === undefined &&
              LinkBClient.safeEncryptedSession(raw.session)))
        ) return msg;
      }
      // 丟幀必須說得出「丟的是哪一種」：只印 `t=tui` 時，加密會話裡「發了消息但永遠沒有回覆」
      // 這種症狀在日誌裡和「agent 沒回」完全同形，#971 就是這麼查了半天才定位到白名單。
      // tui 幀的判別信息在 `frame.params.type`，一併帶上（只帶類型名，不帶 payload）。
      const tuiType =
        raw.t === "tui" && raw.frame?.params && typeof raw.frame.params === "object"
          ? `:${String((raw.frame.params as { type?: unknown }).type)}`
          : "";
      console.error(`[E2E outbound dropped] protected session frame ${String(raw.t)}${tuiType}`);
      return null;
    } catch (error) {
      // keystore poison/并发不确定时，宁可停掉这一帧，也不能让内容路径降成明文。
      console.error(
        `[E2E outbound quarantined] ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  send(msg: Record<string, unknown>): void {
    const filtered = this.filterBlockedOutbound(msg);
    if (!filtered) return;
    msg = filtered;
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN && this.ready) {
      ws.send(JSON.stringify(msg));
      return;
    }
    if (msg.t === "mirror_append" || msg.t === "connector_health" || msg.t === "pong") {
      // #243 例外:E2E 加密批(sendE2ETurn)**不是**水位線驅動——鏡像走 transcript 對非 E2E
      // 自愈,E2E 批就是內容唯一一份,丟=整回合永久丟失 → 照常入緩衝。明文鏡像批照舊丟。
      const sessions = (msg as { sessions?: Array<{ e2e?: boolean }> }).sessions;
      const hasE2E = msg.t === "mirror_append" && Array.isArray(sessions) && sessions.some((s) => s?.e2e === true);
      if (!hasE2E) return;
    }
    this.enqueuePending(JSON.stringify(msg));
  }

  /** ready 後把斷線期間積壓的幀按序補發。 */
  private flushPending(): void {
    if (!this.pending.length) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    console.log(`· Link B 重連 → 補發斷線期間積壓的 ${this.pending.length} 幀`);
    const queued = this.pending.splice(0);
    this.pendingBytes = 0;
    for (const pending of queued) {
      try {
        const filtered = this.filterBlockedOutbound(JSON.parse(pending));
        if (filtered) ws.send(JSON.stringify(filtered));
      } catch {
        console.error("[E2E outbound quarantined] invalid pending Link B frame");
      }
    }
  }

  /** #247 續期半開偵測計時器;LIVENESS_MS 內無入站 → terminate 交 onClose 重連。 */
  private bumpLiveness(): void {
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    const ms = Number(process.env.MACCHIATO_LINKB_LIVENESS_MS) || 90_000;
    const ws = this.ws;
    this.livenessTimer = setTimeout(() => {
      if (this.ws !== ws) return; // superseded socket 的舊 timer 不得 terminate 新 generation。
      console.error(`⚠️ Link B ${ms / 1000}s 無任何入站(含 server WS-ping)→ 判半開,terminate 重連`);
      ws?.terminate();
    }, ms);
    this.livenessTimer.unref?.();
  }

  private onClose(): void {
    this.ready = false;
    if (this.livenessTimer) { clearTimeout(this.livenessTimer); this.livenessTimer = undefined; } // #247
    if (this.closed) return;
    // #3 指數退避(3s→60s+抖動),連續失敗每 5 次吼一聲——此前固定 3s 死磕,斷網一晚=上萬次重連。
    this.failures += 1;
    if (shouldAlert(this.failures)) {
      console.error(`⚠️ link B 連續 ${this.failures} 次重連失敗(server 不可達/憑證問題?),繼續退避重試…`);
    }
    setTimeout(() => {
      if (!this.closed) this.connect();
    }, backoffMs(this.failures - 1));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
