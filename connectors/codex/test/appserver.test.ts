import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/** #132 AppServerClient 可靠性層:握手/請求配對/反向分發/死亡重啟。mock spawn。 */
const procs: FakeProc[] = [];
class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: (s: string) => (this.written.push(JSON.parse(s)), true), destroyed: false };
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
});
