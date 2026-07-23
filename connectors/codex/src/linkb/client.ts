/**
 * Link B 客戶端：用憑證連 Macchiato server。
 *   開 WSS → hello{connectorToken, agentLinkId, proto} → 等 ready → 收發幀（mirror_append / tui / e2e …）。
 * 自動重連；響應 server 的 ping/pong；auth_error 視為憑證失效（停連, 需重新配對）。
 */
import WebSocket from "ws";
import { LINK_B_PROTO } from "./proto";
import { backoffMs, shouldAlert } from "../backoff";
import type { Creds } from "./creds";

export type FrameHandler = (msg: Record<string, unknown>) => void;
export type E2EStateApplier = (state: unknown) => readonly string[];
export type E2EProtectionCheck = (sid: string) => boolean;

export class LinkBClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private ready = false;
  /** #3 連續重連失敗計數(ready 歸零;指數退避 + 每 5 次告警)。 */
  private failures = 0;
  /** 斷線期間的出站幀緩衝(重連 ready 後 flush)——server 部署重啟撞上進行中回合時,
   * 回覆/標題曾被 send() 靜默丟掉(2026-07-12 影子會話實測)。有界:滿了丟最舊。 */
  private readonly pending: string[] = [];
  private blockedSessionIds = new Set<string>();
  private static readonly PENDING_MAX = 500;
  private readonly handlers = new Set<FrameHandler>();
  private readonly readyHandlers = new Set<() => void>(); // #231
  private firstReady: (() => void) | null = null;
  private readonly readyOnce: Promise<void>;

  /** #246 auth_error(憑證吊銷/proto 不符,非瞬時)= 終端態:退出非零讓 supervisor(systemd)
   * 接手——重試/最終 stop,消滅「進程活著但不連、不重連、與離線不可區分」的殭屍。測試可覆蓋。 */
  onFatal: () => void = () => process.exit(1);

  /** #247 半開連接偵測:server 每 30s WS-ping,連續 LIVENESS_MS 無任何入站(含 ping)= 對端已亡
   * (readyState 恒 OPEN、發幀進黑洞)→ terminate 觸發 onClose 重連。收每幀/每 ping 續期。 */
  private livenessTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly creds: Creds,
    private readonly applyE2EState?: E2EStateApplier,
    private readonly socketFactory: (url: string) => WebSocket = (url) =>
      new WebSocket(url, { handshakeTimeout: 20000 }),
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

  /** pending-enable 只有在 server 成功 ACK 后才解除本连接的 per-session 出站隔离。 */
  unblockSession(sid: string): void {
    this.blockedSessionIds.delete(sid);
  }

  /** 監聽 server → 連接器的幀（tui / mirror_nack / e2e_wrap_request …；ready/auth_error/ping 已內部處理）。 */
  onFrame(h: FrameHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  /** #231 每次 ready(含重連)回調。 */
  onReady(h: () => void): () => void {
    this.readyHandlers.add(h);
    return () => this.readyHandlers.delete(h);
  }

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
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.t) {
      case "ready": {
        try {
          if (this.applyE2EState) {
            // #347 新 connector 不接受舊 server 的 bare ready。必須先套用 E2E protection floor，
            // 再丟棄 pending-enable 的首連前明文，最後才可宣告 ready / flush。
            if (!Object.prototype.hasOwnProperty.call(msg, "e2eState")) {
              throw new Error("ready missing e2eState");
            }
            const blocked = new Set(this.applyE2EState(msg.e2eState));
            this.blockedSessionIds = blocked;
            this.dropPendingPlaintext(blocked);
          }
        } catch (error) {
          console.error(`Link B E2E state rejected — ${(error as Error).message}`);
          this.close();
          this.onFatal();
          return;
        }
        this.ready = true;
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
        // ⚠️ 回歸契約:scripts/regression/run-codex-regression.mjs 斷言「Link B ready」,改動需同步
        console.log("✓ Link B ready — connected to Macchiato");
        return;
      }
      case "auth_error":
        console.error(`Link B auth_error: ${msg.reason} — 憑證吊銷或 proto 不符,需重新配對/升級`);
        this.close();
        this.onFatal(); // #246 退出交 supervisor,不再靜默殭屍空轉
        return;
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
   * server pending-enable 但本地尚無 K_S：首連前按舊狀態積壓的單會話幀 / 歷史批可能含明文。
   * 單會話幀整個丟；批次逐 session 過濾，空批整幀丟，避免 ready flush 反向洩漏。
   */
  private dropPendingPlaintext(sessionIds: Set<string>): void {
    if (!sessionIds.size || !this.pending.length) return;
    const kept: string[] = [];
    let droppedFrames = 0;
    let droppedSessions = 0;
    for (const raw of this.pending) {
      try {
        const msg = JSON.parse(raw) as Record<string, any>;
        const sid =
          msg.t === "connector_push"
            ? msg.chatId
            : msg.sessionId ?? msg.frame?.params?.session_id;
        if (typeof sid === "string" && sessionIds.has(sid)) {
          droppedFrames++;
          continue;
        }
        if ((msg.t === "import_batch" || msg.t === "mirror_append") && Array.isArray(msg.sessions)) {
          const sessions = msg.sessions.filter(
            (session: unknown) =>
              !(
                session !== null &&
                typeof session === "object" &&
                typeof (session as { hermesSessionId?: unknown }).hermesSessionId === "string" &&
                sessionIds.has((session as { hermesSessionId: string }).hermesSessionId)
              ),
          );
          const removed = msg.sessions.length - sessions.length;
          if (removed) {
            droppedSessions += removed;
            if (!sessions.length) {
              if (msg.t === "import_batch" && msg.done === true) {
                kept.push(JSON.stringify({ ...msg, sessions: [] }));
                continue;
              }
              droppedFrames++;
              continue;
            }
            kept.push(JSON.stringify({ ...msg, sessions }));
            continue;
          }
        }
      } catch {
        // pending 只含 send() 自己 JSON.stringify 的幀；若仍解析失敗，沿用原 flush 行為。
      }
      kept.push(raw);
    }
    if (droppedFrames || droppedSessions) {
      this.pending.splice(0, this.pending.length, ...kept);
      console.error(
        `⚠️ E2E ready 對賬清除首連前明文：${droppedFrames} 幀、${droppedSessions} 個批次 session（請重試相關消息）`,
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
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const session = value as Record<string, unknown>;
    if (
      !LinkBClient.onlyKeys(session, [
        "hermesSessionId", "title", "source", "startedAt", "archived", "e2e", "messages",
      ]) ||
      typeof session.hermesSessionId !== "string" ||
      !session.hermesSessionId ||
      session.e2e !== true ||
      (session.title !== undefined && !LinkBClient.looksLikeCiphertext(session.title)) ||
      !Array.isArray(session.messages)
    ) return false;
    return session.messages.every((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      const message = value as Record<string, unknown>;
      return (
        LinkBClient.onlyKeys(message, [
          "role", "text", "reasoning", "tools", "createdAt", "srcId", "enc",
        ]) &&
        (message.role === "user" || message.role === "agent" || message.role === "system") &&
        LinkBClient.looksLikeCiphertext(message.enc) &&
        (message.text === undefined || message.text === "") &&
        (message.reasoning === undefined || message.reasoning === "") &&
        (message.tools === undefined || (Array.isArray(message.tools) && message.tools.length === 0))
      );
    });
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
    if (params.type !== "approval.request") return false;
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
      // 结果帧本身是 E2E 路由信息；必须在 session floor 判定前全局验 strict shape，
      // 否则伪造/空 sid 可绕开 protectedFrame，并把任意 error 文本当侧信道送出。
      if (raw.t === "e2e_control_result") {
        return this.safeE2EControlResult(raw) ? msg : null;
      }
      if ((raw.t === "import_batch" || raw.t === "mirror_append") && Array.isArray(raw.sessions)) {
        const sessions = raw.sessions.filter((session: unknown) => {
          const sid =
            session !== null && typeof session === "object"
              ? (session as { hermesSessionId?: unknown }).hermesSessionId
              : undefined;
          if (typeof sid === "string" && this.blockedSessionIds.has(sid)) return false;
          if (!this.sessionIsProtected(sid)) return true;
          return raw.t === "mirror_append" && LinkBClient.safeEncryptedSession(session);
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
      console.error(`[E2E outbound dropped] protected session frame ${String(raw.t)}`);
      return null;
    } catch (error) {
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
      // E2E live 回合不是水位線驅動，斷線丟掉就是永久缺失；只有含 E2E session 的 mirror 批可緩衝。
      const sessions = (msg as { sessions?: Array<{ e2e?: boolean }> }).sessions;
      const hasE2E = msg.t === "mirror_append" && Array.isArray(sessions) && sessions.some((s) => s?.e2e === true);
      if (!hasE2E) return;
    }
    if (this.pending.length >= LinkBClient.PENDING_MAX) this.pending.shift(); // 有界:丟最舊
    this.pending.push(JSON.stringify(msg));
  }

  /** ready 後把斷線期間積壓的幀按序補發。 */
  private flushPending(): void {
    if (!this.pending.length) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    console.log(`· Link B 重連 → 補發斷線期間積壓的 ${this.pending.length} 幀`);
    for (const pending of this.pending.splice(0)) {
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
