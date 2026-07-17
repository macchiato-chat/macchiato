/**
 * #132 v2:常駐 `codex app-server` 子進程的 JSON-RPC(over stdio,行分隔)客戶端。
 * 對齊 hermes GatewayClient 的可靠性語義:
 *   - request/notify + 反向請求(approval 等)註冊分發;
 *   - 進程死亡 → 在途請求全拒(AppServerDied)+ supervise 指數退避重啟 + onRestart 通知
 *     (drive 據此清活躍回合、對用戶明說),重啟成功 failures 歸零;
 *   - initialize 握手(clientInfo → notify initialized)在每次 spawn 後自動走。
 * 協議 schema 釘死於 codex-cli 0.144.1(generate-json-schema,2026-07-12/14 兩輪探針)。
 * app-server 標 experimental——漂移時 index.ts 的啟動探活會回退 exec v1(見 compat)。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { resolveCodexBin } from "./codex-bin";
import { backoffMs, shouldAlert } from "../backoff";

export class AppServerDied extends Error {
  constructor(msg = "codex app-server died") {
    super(msg);
    this.name = "AppServerDied";
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
/** 反向請求處理器:返回 result(同步/異步皆可);拋錯 → 回 JSON-RPC error。 */
export type ReverseHandler = (params: any) => Promise<Record<string, unknown>> | Record<string, unknown>;

const REQUEST_TIMEOUT_MS = Number(process.env.MACCHIATO_CODEX_RPC_TIMEOUT_S ?? 120) * 1000;
/** #250 重啟失敗閾值:到 STUCK 次先清懸空回合(免 app 永久轉圈)、到 FATAL 次上浮 onFatal
 * (index.ts 優雅退出 → systemd 重啟重走啟動探活 → app-server 仍壞則降級 exec v1)。 */
const RESTART_STUCK_AT = Number(process.env.MACCHIATO_CODEX_RESTART_STUCK ?? 3);
const RESTART_FATAL_AT = Number(process.env.MACCHIATO_CODEX_RESTART_FATAL ?? 10);

export class AppServerClient {
  private proc: ChildProcess | null = null;
  private closed = false;
  private ready = false;
  private nextId = 1;
  private stdoutBuf = "";
  private readonly pending = new Map<number, Pending>();
  private readonly reverse = new Map<string, ReverseHandler>();
  private readonly notificationHandlers = new Set<(method: string, params: any) => void>();
  /** 連續重啟失敗計數(成功歸零;上浮 health 告警)。 */
  restartFailures = 0;
  /** (重)啟動握手成功後 **或** 重啟連續失敗到 STUCK 閾值時回調——drive 據此清活躍回合/通知用戶
   * (免 app-server 永遠起不來時活躍回合永久懸空、app 轉圈到死)。 */
  onRestart: (() => void) | null = null;
  /** #250 重啟連續失敗到 FATAL 閾值——index.ts 據此優雅退出讓 systemd 重啟(重走啟動探活/降級 exec)。 */
  onFatal: ((failures: number) => void) | null = null;

  get isReady(): boolean {
    return this.ready;
  }

  /** 監聽 server → client 通知(item/agentMessage/delta 等)。 */
  onNotification(h: (method: string, params: any) => void): () => void {
    this.notificationHandlers.add(h);
    return () => this.notificationHandlers.delete(h);
  }

  /** 註冊反向請求處理器(如 item/commandExecution/requestApproval)。 */
  onReverseRequest(method: string, h: ReverseHandler): void {
    this.reverse.set(method, h);
  }

  /** 首次啟動:spawn + initialize 握手;失敗直接拋(index.ts 據此回退 exec v1)。 */
  async start(): Promise<void> {
    await this.spawnAndInit();
    void this.supervise();
  }

  private async spawnAndInit(): Promise<void> {
    const proc = spawn(resolveCodexBin(), ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.proc = proc;
    this.stdoutBuf = "";
    // #250 只處理**當前** proc 的 stdout——握手超時等場景舊進程未被殺仍活著,若也喂同一 stdoutBuf
    // 會與新進程行緩衝交錯、遲到響應錯配新請求 id。捕獲 proc 到閉包,非當前即忽略。
    proc.stdout!.on("data", (c: Buffer) => {
      if (this.proc === proc) this.onData(c);
    });
    let stderrTail = "";
    proc.stderr!.on("data", (c: Buffer) => {
      stderrTail = (stderrTail + c.toString("utf8")).slice(-2000);
    });
    proc.on("error", (e) => {
      // spawn/管道錯誤(EPIPE/ENOENT 等):記錄(此前空 no-op);close 隨後觸發,統一在 supervise 重啟。
      console.error(`[appserver proc error] ${(e as Error).message}`);
    });
    this.ready = false;
    let timer: NodeJS.Timeout | undefined;
    // 握手要快速失敗:老 codex 無 app-server 子命令會直接退出——race 進程退出/15s,
    // 別等 REQUEST_TIMEOUT(index.ts 靠這個拋錯回退 exec v1)。
    const closed = new Promise<never>((_, rej) =>
      proc.once("close", (code) => rej(new AppServerDied(`app-server exited during handshake (code ${code}) ${stderrTail.slice(-300)}`))),
    );
    const handshakeTimeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new AppServerDied("initialize handshake timeout (15s)")), 15_000);
    });
    try {
      await Promise.race([
        this.request("initialize", {
          clientInfo: { name: "macchiato-codex-connector", version: process.env.npm_package_version ?? "0" },
        }),
        closed,
        handshakeTimeout,
      ]);
    } catch (e) {
      // #250 握手失敗(超時/退出)→ 殺掉這個進程並摘監聽,否則孤兒進程繼續喂 stdoutBuf、下輪
      // spawn 的新進程與它交錯。SIGKILL 確保死透。
      clearTimeout(timer);
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      try {
        proc.kill("SIGKILL");
      } catch {
        /* 已死 */
      }
      throw e;
    }
    clearTimeout(timer);
    this.notify("initialized");
    this.ready = true;
  }

  /** 進程死亡 → 拒在途 + 退避重啟;成功 → onRestart(活躍回合已隨進程死,drive 清盤)。 */
  private async supervise(): Promise<void> {
    for (;;) {
      const proc = this.proc;
      if (!proc || this.closed) return;
      await new Promise<void>((r) => proc.once("close", () => r()));
      if (this.closed) return;
      this.ready = false;
      this.failAll(new AppServerDied());
      console.error("⚠️ codex app-server 進程退出——重啟中(在途請求已拒)…");
      for (;;) {
        if (this.closed) return;
        try {
          await this.spawnAndInit();
          this.restartFailures = 0;
          console.log("· codex app-server 已重啟(握手成功)");
          try {
            this.onRestart?.();
          } catch {
            /* 回調自負其責 */
          }
          break;
        } catch (e) {
          this.restartFailures += 1;
          if (shouldAlert(this.restartFailures)) {
            console.error(`⚠️ codex app-server 連續 ${this.restartFailures} 次重啟失敗:${(e as Error).message.slice(0, 200)}`);
          }
          // #250 到 STUCK 閾值:清懸空回合(app-server 起不來時 onRestart 永不觸發 → 活躍回合永久
          // 懸空、app 轉圈到死)。只在剛跨過閾值那次調一次,免刷屏。
          if (this.restartFailures === RESTART_STUCK_AT) {
            console.error(`⚠️ codex app-server 重啟受阻(${this.restartFailures} 次)→ 清活躍回合,通知用戶`);
            try {
              this.onRestart?.();
            } catch {
              /* 回調自負其責 */
            }
          }
          // #250 到 FATAL 閾值:上浮 index.ts 優雅退出,交 systemd 重啟(重走啟動探活 → 降級 exec v1)。
          if (this.restartFailures >= RESTART_FATAL_AT) {
            console.error(`⚠️ codex app-server 連續 ${this.restartFailures} 次重啟失敗 → 退出交 systemd 重啟(將重走啟動探活/降級 exec)`);
            this.onFatal?.(this.restartFailures);
            return;
          }
          await new Promise((r) => setTimeout(r, backoffMs(this.restartFailures - 1)));
        }
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 非 JSON 行忽略
    }
    // 響應(我們發出的請求)
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`app-server error: ${JSON.stringify(msg.error).slice(0, 500)}`));
      else p.resolve(msg.result);
      return;
    }
    // 反向請求(server → client,帶 id 要回話)
    if (msg.id !== undefined && typeof msg.method === "string") {
      const h = this.reverse.get(msg.method);
      void (async () => {
        try {
          const result = h ? await h(msg.params) : {};
          if (!h) console.error(`[appserver] 未註冊的反向請求 ${msg.method}(回空對象兜底)`);
          this.respond(msg.id, result);
        } catch (e) {
          this.respondError(msg.id, (e as Error).message);
        }
      })();
      return;
    }
    // 通知
    if (typeof msg.method === "string") {
      for (const h of this.notificationHandlers) {
        try {
          h(msg.method, msg.params ?? {});
        } catch {
          /* 監聽器自負其責 */
        }
      }
    }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    if (!this.safeWrite({ jsonrpc: "2.0", id, method, params })) {
      return Promise.reject(new AppServerDied("not running"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`app-server request timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  /** #250 安全寫:stdin 已毀/不可寫時直接跳過並 try/catch——死亡窗口往死流 write 會拋,
   * 反向請求 catch 裡的 respondError 若同步拋更會冒成 unhandled rejection(void async)。 */
  private safeWrite(obj: Record<string, unknown>): boolean {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    try {
      stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch (e) {
      console.error(`[appserver write failed] ${(e as Error).message}`);
      return false;
    }
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.safeWrite({ jsonrpc: "2.0", method, params });
  }

  private respond(id: unknown, result: Record<string, unknown>): void {
    this.safeWrite({ jsonrpc: "2.0", id, result });
  }
  private respondError(id: unknown, message: string): void {
    this.safeWrite({ jsonrpc: "2.0", id, error: { code: -32000, message } });
  }

  close(): void {
    this.closed = true;
    this.failAll(new AppServerDied("client closed"));
    this.proc?.kill("SIGTERM");
  }
}
