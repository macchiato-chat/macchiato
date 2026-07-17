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

export class LinkBClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private ready = false;
  /** #3 連續重連失敗計數(ready 歸零;指數退避 + 每 5 次告警)。 */
  private failures = 0;
  /** 斷線期間的出站幀緩衝(重連 ready 後 flush)——server 部署重啟撞上進行中回合時,
   * 回覆/標題曾被 send() 靜默丟掉(2026-07-12 影子會話實測)。有界:滿了丟最舊。 */
  private readonly pending: string[] = [];
  private static readonly PENDING_MAX = 500;
  private readonly handlers = new Set<FrameHandler>();
  /** #199 每次 ready(含重連)都觸發——server 重啟丟內存緩存的上報(如 commands 清單)靠它重發。 */
  private readonly readyHandlers = new Set<() => void>();
  private firstReady: (() => void) | null = null;
  private readonly readyOnce: Promise<void>;

  /** #246 auth_error(憑證吊銷/proto 不符,非瞬時)= 終端態:退出非零讓 supervisor(systemd)
   * 接手——重試/最終 stop,消滅「進程活著但不連、不重連、與離線不可區分」的殭屍。測試可覆蓋。 */
  onFatal: () => void = () => process.exit(1);

  /** #247 半開連接偵測:server 每 30s WS-ping,連續 LIVENESS_MS 無任何入站(含 ping)= 對端已亡
   * (readyState 恒 OPEN、發幀進黑洞)→ terminate 觸發 onClose 重連。收每幀/每 ping 續期。 */
  private livenessTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly creds: Creds) {
    this.readyOnce = new Promise((r) => (this.firstReady = r));
  }

  get agentLinkId(): string {
    return this.creds.agentLinkId;
  }
  get isReady(): boolean {
    return this.ready;
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

  /** 連接 + hello + 等首次 ready。 */
  async start(): Promise<void> {
    this.connect();
    await this.readyOnce;
  }

  private connect(): void {
    const ws = new WebSocket(this.creds.serverUrl, { handshakeTimeout: 20000 });
    this.ws = ws;
    ws.on("ping", () => this.bumpLiveness()); // #247 server WS-ping 續期 liveness
    ws.on("open", () => {
      this.bumpLiveness();
      ws.send(
        JSON.stringify({
          t: "hello",
          connectorToken: this.creds.connectorToken,
          agentLinkId: this.creds.agentLinkId,
          proto: LINK_B_PROTO,
        }),
      );
    });
    ws.on("message", (raw) => this.handleFrame(raw));
    ws.on("close", () => this.onClose());
    ws.on("error", () => {
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
      case "ready":
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
        console.log("✓ Link B ready — connected to Macchiato");
        return;
      case "auth_error":
        console.error(`Link B auth_error: ${msg.reason} — 憑證吊銷或 proto 不符,需重新配對/升級`);
        this.close();
        this.onFatal(); // #246 退出交 supervisor,不再靜默殭屍空轉
        return;
      case "ping":
        this.send({ t: "pong" });
        return;
      default: {
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
   * 發一個 Link B 幀;斷線期間**緩衝**、ready 後按序 flush(此前直接丟——server 每次部署
   * 重啟都會把撞上的回合尾巴丟掉,會話卡成「影子」)。鏡像幀例外:有自己的水位線/nack
   * 回退,緩衝反而會與重發重複 → 照舊丟棄。
   */
  send(msg: Record<string, unknown>): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN && this.ready) {
      ws.send(JSON.stringify(msg));
      return;
    }
    if (msg.t === "mirror_append" || msg.t === "connector_health" || msg.t === "pong") {
      // #243 例外:E2E 加密批**不是**水位線驅動——對賬/打撈都跳過 E2E 會話,這批就是內容
      // 的唯一一份,丟=整回合永久丟失 → 照常入緩衝。明文鏡像批有水位線/nack 自愈,照舊丟。
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
    for (const f of this.pending.splice(0)) ws.send(f);
  }

  /** #247 續期半開偵測計時器;LIVENESS_MS 內無入站 → terminate 交 onClose 重連。 */
  private bumpLiveness(): void {
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    const ms = Number(process.env.MACCHIATO_LINKB_LIVENESS_MS) || 90_000;
    this.livenessTimer = setTimeout(() => {
      console.error(`⚠️ Link B ${ms / 1000}s 無任何入站(含 server WS-ping)→ 判半開,terminate 重連`);
      this.ws?.terminate();
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
