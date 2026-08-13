/**
 * #893 `LoginFlow.submitCode` 絕不能因為往死掉的 stdin 寫而崩進程。
 *
 * 真實窗口：授權碼是用戶在手機上點完隔幾十秒到幾分鐘才回傳的，而 server 的
 * `connector.login.code` 不檢查本地還有沒有活躍登錄流（點兩次、app 重試都會撞上）。
 * 往銷毀的 writable 寫，Node 經 `process.nextTick` **異步**發 `'error'`——幀處理器和
 * LinkBClient 的兩層 try/catch 都抓不到，直接落成 uncaught。
 */
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { LoginFlow } from "../src/cc/login";

/** 造一個「進程還在、stdin 已銷毀」的假 child。 */
function flowWith(proc: Record<string, unknown>): LoginFlow {
  const flow = new LoginFlow();
  (flow as unknown as { proc: unknown }).proc = proc;
  return flow;
}

/** 等一輪 microtask + nextTick：異步 'error' 若沒被監聽就會在這個窗口冒出來。 */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("#893 submitCode 不因死 stdin 崩進程", () => {
  it("stdin 已銷毀 → 直接跳過，不寫、不拋、不留未處理的 'error'", async () => {
    const stdin = new PassThrough();
    stdin.destroy();
    const flow = flowWith({ stdin, exitCode: null, signalCode: null });

    expect(() => flow.submitCode("123456")).not.toThrow();
    await settle(); // 若走到了 write，這裡會炸成 unhandled 'error'
  });

  it("進程已退出（exitCode 非 null）→ 不寫", async () => {
    const writes: string[] = [];
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        writes.push(String(chunk));
        cb();
      },
    });
    const flow = flowWith({ stdin, exitCode: 1, signalCode: null });

    flow.submitCode("123456");
    await settle();
    expect(writes).toEqual([]);
  });

  it("被信號殺掉（signalCode 非 null）→ 不寫", async () => {
    const writes: string[] = [];
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        writes.push(String(chunk));
        cb();
      },
    });
    const flow = flowWith({ stdin, exitCode: null, signalCode: "SIGKILL" });

    flow.submitCode("123456");
    await settle();
    expect(writes).toEqual([]);
  });

  it("流在 write 過程中報錯（EPIPE：進程剛死、exit 還沒投遞）→ 吞掉，不冒 uncaught", async () => {
    const stdin = new Writable({
      write(_chunk, _enc, cb) {
        cb(new Error("EPIPE")); // 模擬管道另一端已關
      },
    });
    const flow = flowWith({ stdin, exitCode: null, signalCode: null });

    expect(() => flow.submitCode("123456")).not.toThrow();
    await settle();
  });

  it("正常活著 → 照常把碼 + 換行寫進去（別為了安全把功能改壞）", async () => {
    const writes: string[] = [];
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        writes.push(String(chunk));
        cb();
      },
    });
    const flow = flowWith({ stdin, exitCode: null, signalCode: null });

    flow.submitCode("  123456  ");
    await settle();
    expect(writes).toEqual(["123456\n"]);
  });

  it("沒有進行中的登錄流（proc 為 null）→ no-op", async () => {
    const flow = new LoginFlow();
    expect(() => flow.submitCode("123456")).not.toThrow();
    await settle();
  });
});
