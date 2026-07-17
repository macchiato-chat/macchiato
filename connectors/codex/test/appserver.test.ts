import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/** #132 AppServerClient 可靠性層:握手/請求配對/反向分發/死亡重啟。mock spawn。 */
const procs: FakeProc[] = [];
class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: (s: string) => (this.written.push(JSON.parse(s)), true), destroyed: false, writable: true };
  written: any[] = [];
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
  // 測試助手:回一條 JSON-RPC
  reply(obj: any) {
    this.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  }
  /** 自動應答 initialize(握手)。 */
  autoInit() {
    const init = this.written.find((w) => w.method === "initialize");
    if (init) this.reply({ jsonrpc: "2.0", id: init.id, result: {} });
  }
}
vi.mock("node:child_process", () => ({
  spawn: () => {
    const p = new FakeProc();
    procs.push(p);
    return p;
  },
}));
vi.mock("../src/backoff", () => ({ backoffMs: () => 1, shouldAlert: () => false }));

import { AppServerClient, AppServerDied } from "../src/codex/appserver";

const tick = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  procs.length = 0;
});

describe("#132 AppServerClient", () => {
  it("握手:initialize → resolve → notify initialized;請求按 id 配對,error 拒絕", async () => {
    const c = new AppServerClient();
    const startP = c.start();
    await tick();
    procs[0]!.autoInit();
    await startP;
    expect(c.isReady).toBe(true);
    expect(procs[0]!.written.map((w) => w.method)).toEqual(["initialize", "initialized"]);
    const p1 = c.request("thread/start", { cwd: "/x" });
    const p2 = c.request("turn/start", {});
    const [r1, r2] = procs[0]!.written.slice(-2);
    procs[0]!.reply({ jsonrpc: "2.0", id: r2.id, result: { ok: 2 } });
    procs[0]!.reply({ jsonrpc: "2.0", id: r1.id, error: { code: 1, message: "bad" } });
    expect(await p2).toEqual({ ok: 2 });
    await expect(p1).rejects.toThrow("app-server error");
    c.close();
  });

  it("反向請求 → 註冊處理器 → 回 result;未註冊回空對象兜底", async () => {
    const c = new AppServerClient();
    const startP = c.start();
    await tick();
    procs[0]!.autoInit();
    await startP;
    c.onReverseRequest("item/commandExecution/requestApproval", async (p) => ({ decision: "accept", got: p.command }));
    procs[0]!.reply({ jsonrpc: "2.0", id: 991, method: "item/commandExecution/requestApproval", params: { command: "ls" } });
    procs[0]!.reply({ jsonrpc: "2.0", id: 992, method: "unknown/reverse", params: {} });
    await tick();
    const replies = procs[0]!.written.filter((w) => w.id === 991 || w.id === 992);
    expect(replies.find((r) => r.id === 991)!.result).toEqual({ decision: "accept", got: "ls" });
    expect(replies.find((r) => r.id === 992)!.result).toEqual({});
    c.close();
  });

  it("進程死亡 → 在途請求拒 AppServerDied;supervise 重啟+重握手 → onRestart,failures 歸零", async () => {
    const c = new AppServerClient();
    const startP = c.start();
    await tick();
    procs[0]!.autoInit();
    await startP;
    const restarts: number[] = [];
    c.onRestart = () => restarts.push(1);
    const inflight = c.request("turn/start", {});
    procs[0]!.emit("close", 1); // 進程死
    await expect(inflight).rejects.toThrow(AppServerDied);
    await tick();
    expect(procs.length).toBe(2); // 重啟 spawn
    procs[1]!.autoInit();
    await tick();
    expect(restarts).toEqual([1]);
    expect(c.restartFailures).toBe(0);
    expect(c.isReady).toBe(true);
    c.close();
  });

  it("握手期進程即退 → start() 快速拒(index 據此回退 exec v1)", async () => {
    const c = new AppServerClient();
    const startP = c.start();
    await tick();
    procs[0]!.emit("close", 2); // 老 codex 無 app-server 子命令
    await expect(startP).rejects.toThrow("exited during handshake");
    c.close();
  });

  it("通知分發給監聽器", async () => {
    const c = new AppServerClient();
    const startP = c.start();
    await tick();
    procs[0]!.autoInit();
    await startP;
    const got: Array<[string, any]> = [];
    c.onNotification((m, p) => got.push([m, p]));
    procs[0]!.reply({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "hi" } });
    expect(got).toEqual([["item/agentMessage/delta", { delta: "hi" }]]);
    c.close();
  });

  it("#250 握手超時 → 殺舊進程 + 摘 stdout 監聽(孤兒不再喂緩衝)", async () => {
    vi.useFakeTimers();
    const c = new AppServerClient();
    const startP = c.start().catch((e) => e);
    await vi.advanceTimersByTimeAsync(1); // 讓 spawn/監聽掛上
    procs[0]!.emit("error", new Error("ignored")); // 空 no-op 改為記錄,不崩
    await vi.advanceTimersByTimeAsync(15_000); // 握手 15s 超時
    const err = await startP;
    expect(String(err)).toContain("handshake timeout");
    expect(procs[0]!.killed).toBe(true); // 舊進程被殺
    expect(procs[0]!.stdout.listenerCount("data")).toBe(0); // stdout 監聽已摘,孤兒不喂緩衝
    vi.useRealTimers();
    c.close();
  });

  it("#250 死亡窗口 respondError 不崩:stdin 不可寫時反向請求 catch 靜默跳過", async () => {
    const c = new AppServerClient();
    const startP = c.start();
    await tick();
    procs[0]!.autoInit();
    await startP;
    c.onReverseRequest("x/req", async () => {
      throw new Error("handler boom");
    });
    procs[0]!.stdin.writable = false; // 模擬死亡窗口:流不可寫
    // 反向請求 → handler 拋 → respondError(safeWrite 見不可寫 → 跳過,不拋 unhandled rejection)
    expect(() => procs[0]!.reply({ jsonrpc: "2.0", id: 5, method: "x/req", params: {} })).not.toThrow();
    await tick();
    c.close();
  });

  it("#250 重啟連續失敗:STUCK 閾值清懸空回合(onRestart),FATAL 閾值上浮 onFatal", async () => {
    // spawn 出的進程一創建就 emit close(握手期即退)→ 每輪重啟都失敗
    const c = new AppServerClient();
    const restarts: number[] = [];
    const fatals: number[] = [];
    c.onRestart = () => restarts.push(1);
    c.onFatal = (n) => fatals.push(n);
    const startP = c.start().catch(() => {}); // 首啟即失敗(index 據此回退,這裡只測 supervise)
    // 首啟失敗後 supervise 不會跑(start 拋);直接測 supervise 需先握手成功再讓它死。改法:
    // 先握手成功,再讓進程反覆死。
    await tick();
    procs[0]!.autoInit();
    await startP;
    // 之後每個新 spawn 的進程立即 close(重啟必失敗)
    const origLen = procs.length;
    procs[origLen - 1]!.emit("close", 1); // 觸發 supervise 重啟循環
    // 讓後續 spawn 的進程都立即退出
    for (let i = 0; i < 15; i++) {
      await tick();
      const p = procs[procs.length - 1];
      if (p && !p.killed && p.listenerCount("close") >= 0) p.emit("close", 1);
    }
    await tick();
    expect(restarts.length).toBeGreaterThanOrEqual(1); // STUCK:清了懸空回合
    expect(fatals.length).toBeGreaterThanOrEqual(1); // FATAL:上浮退出
    c.close();
  });
});
