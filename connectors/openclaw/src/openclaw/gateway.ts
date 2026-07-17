/**
 * OpenClaw gateway WebSocket 客戶端（協議 v4, backend 免配對路徑）。
 * 握手/方法/事件均以 scripts/probe-gateway.ts 的活測為準, 見 docs/ARCHITECTURE.md「活測確認的協議」。
 */
import WebSocket from "ws";
import { backoffMs, shouldAlert } from "../backoff";
import { resolveGatewayConfig, type GatewayConfig } from "./config";

export interface GatewayEvent {
  event: string;
  payload?: unknown;
  seq?: number;
}
export type EventHandler = (evt: GatewayEvent) => void;

const REQ_TIMEOUT_MS = 15000;
const CHALLENGE_WAIT_MS = 200;

interface Pending {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OpenClawGateway {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly handlers = new Set<EventHandler>();
  private closed = false;
  private firstConnect: (() => void) | null = null;
  private readonly connectedOnce: Promise<void>;
  /** 最近一次握手的 hello-ok（protocol / features.methods / features.events …）。 */
  helloOk: any = null;
  private connected = false;
  /** #3 連續重連失敗計數(握手成功歸零)——health 據此上浮「gateway 連不上 + 次數」。 */
  reconnectFailures = 0;
  /** #210 殭屍 gateway 標記:RPC 曾回 ERR_MODULE_NOT_FOUND(自動更新後未重啟);重連成功即清。 */
  staleInstall = false;

  get isConnected(): boolean {
    return this.connected;
  }

  constructor(private readonly cfg: GatewayConfig = resolveGatewayConfig()) {
    this.connectedOnce = new Promise((r) => (this.firstConnect = r));
  }

  /** 註冊事件監聽（agent / session.message / sessions.changed …）。返回取消函數。 */
  onEvent(h: EventHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  /** #202 每次握手成功後回調(含重連)。斷連窗內的廣播已丟——訂閱方據此觸發對賬補齊。 */
  private readonly connectedHandlers = new Set<() => void>();
  onConnected(h: () => void): () => void {
    this.connectedHandlers.add(h);
    return () => this.connectedHandlers.delete(h);
  }

  /** 連接並完成首次握手。 */
  async start(): Promise<void> {
    this.connect();
    await this.connectedOnce;
  }

  private connect(): void {
    const ws = new WebSocket(this.cfg.url);
    this.ws = ws;
    // #252 握手失敗(token 錯/拒絕/15s 超時)此前是 `void handshake()` 的 unhandled rejection——
    // index.ts 無兜底,Node 默認可崩進程。收斂:catch → 關 socket 交給 onClose 走既有退避重連。
    ws.on("open", () => {
      this.handshake().catch((e) => {
        console.error(`[gateway 握手失敗 → 退避重連] ${(e as Error).message}`);
        try {
          ws.close();
        } catch {
          /* 已斷 */
        }
      });
    });
    ws.on("message", (d) => this.onMessage(d));
    ws.on("close", () => this.onClose());
    ws.on("error", () => {
      /* 'close' 隨後觸發, 統一在 onClose 重連 */
    });
  }

  private async handshake(): Promise<void> {
    await new Promise((r) => setTimeout(r, CHALLENGE_WAIT_MS)); // 等 connect.challenge
    this.helloOk = await this.request("connect", {
      minProtocol: 3,
      maxProtocol: 4,
      client: { id: "gateway-client", version: "0.1.0", platform: process.platform, mode: "backend" },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      caps: [],
      commands: [],
      permissions: {},
      auth: { token: this.cfg.token },
      userAgent: "macchiato-openclaw-connector/0.1",
    });
    this.connected = true;
    this.reconnectFailures = 0; // #3 連上歸零
    this.staleInstall = false; // #210 重連成功 = gateway 已重啟(新進程),殭屍標記清除
    if (this.firstConnect) {
      this.firstConnect();
      this.firstConnect = null;
    }
    for (const h of this.connectedHandlers) {
      try {
        h();
      } catch {
        /* 訂閱方自負其責 */
      }
    }
  }

  private onMessage(data: WebSocket.RawData): void {
    let f: { type?: string; id?: string; ok?: boolean; payload?: unknown; error?: unknown; event?: string; seq?: number };
    try {
      f = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (f.type === "res" && f.id) {
      const p = this.pending.get(f.id);
      if (!p) return;
      this.pending.delete(f.id);
      clearTimeout(p.timer);
      if (f.ok) p.resolve(f.payload);
      else {
        const msg = JSON.stringify(f.error);
        // #210 殭屍 gateway 特徵:OpenClaw 每日自動更新換掉 dist(哈希文件名),在跑進程
        // lazy-load 新模塊即 ERR_MODULE_NOT_FOUND——標記上浮 health,app 端一眼看懂要重啟。
        if (msg.includes("ERR_MODULE_NOT_FOUND")) {
          this.staleInstall = true;
          console.error("⚠️ #210 偵測到 gateway 殭屍特徵(ERR_MODULE_NOT_FOUND)——OpenClaw 已自動更新,gateway 需重啟");
        }
        p.reject(new Error(`gateway error: ${msg}`));
      }
    } else if (f.type === "event" && f.event) {
      const evt: GatewayEvent = { event: f.event, payload: f.payload, seq: f.seq };
      for (const h of this.handlers) {
        try {
          h(evt);
        } catch {
          /* 監聽器自負其責 */
        }
      }
    }
  }

  /** 發一個 RPC, resolve 為 `payload`（ok=false → reject）。 */
  request<T = any>(method: string, params: unknown = {}): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway timeout: ${method}`));
      }, REQ_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (p: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  private onClose(): void {
    this.connected = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("gateway connection lost"));
    }
    this.pending.clear();
    if (this.closed) return;
    // #3 指數退避(3s→60s+抖動);連續失敗每 5 次吼一聲,並經 reconnectFailures 上浮 health。
    this.reconnectFailures += 1;
    if (shouldAlert(this.reconnectFailures)) {
      console.error(`⚠️ OpenClaw gateway 連續 ${this.reconnectFailures} 次重連失敗(gateway 沒在跑?),繼續退避重試…`);
    }
    setTimeout(() => {
      if (!this.closed) this.connect();
    }, backoffMs(this.reconnectFailures - 1));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  // —— 便捷方法（已活測確認）——
  sessionsList(params: Record<string, unknown> = {}): Promise<any> {
    return this.request("sessions.list", params);
  }
  /** 注意：參數是複數 `keys` 數組。 */
  sessionsPreview(keys: string[]): Promise<any> {
    return this.request("sessions.preview", { keys });
  }
  subscribeMessages(sessionKey: string): Promise<any> {
    return this.request("sessions.messages.subscribe", { sessionKey });
  }

  // —— 驅動相關（drive 階段對真 gateway 核對參數名後再用）——
  sessionsSend(key: string, message: string): Promise<any> {
    return this.request("sessions.send", { key, message });
  }
  sessionsAbort(key: string): Promise<any> {
    return this.request("sessions.abort", { key });
  }
}
