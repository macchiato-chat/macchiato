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
  private readonly handlers = new Set<FrameHandler>();
  private firstReady: (() => void) | null = null;
  private readonly readyOnce: Promise<void>;

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

  /** 連接 + hello + 等首次 ready。 */
  async start(): Promise<void> {
    this.connect();
    await this.readyOnce;
  }

  private connect(): void {
    const ws = new WebSocket(this.creds.serverUrl, { handshakeTimeout: 20000 });
    this.ws = ws;
    ws.on("open", () => {
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
        if (this.firstReady) {
          this.firstReady();
          this.firstReady = null;
        }
        console.log("✓ Link B ready — connected to Macchiato");
        return;
      case "auth_error":
        console.error(`Link B auth_error: ${msg.reason} (credentials revoked? re-pair needed)`);
        this.close();
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

  /** 發一個 Link B 幀；未連接則丟棄（鏡像有自己的水位線/nack 回退, 不在此緩存）。 */
  send(msg: Record<string, unknown>): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private onClose(): void {
    this.ready = false;
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
