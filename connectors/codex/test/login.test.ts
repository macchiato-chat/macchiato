import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// #313 假 spawn:codex login --device-auth 的 stdout 形狀(對 0.144.1 device 流實測校準)。
let fakeProc: any;
vi.mock("node:child_process", () => ({
  spawn: () => fakeProc,
}));
vi.mock("../src/codex/codex-bin", () => ({ resolveCodexBin: () => "codex" }));

import { LoginFlow } from "../src/codex/login";

function makeProc() {
  const p: any = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = vi.fn();
  return p;
}

describe("#313 codex device-auth 登錄流", () => {
  beforeEach(() => {
    fakeProc = makeProc();
  });
  afterEach(() => vi.restoreAllMocks());

  it("從 stdout 抽出授權 URL + 一次性碼(needsCode 由調用方傳 false),exit 0 → onResult(true)", async () => {
    const login = new LoginFlow();
    let url: string | undefined;
    let code: string | undefined;
    let result: { ok: boolean; error?: string } | undefined;
    login.start({ onUrl: (u, c) => { url = u; code = c; }, onResult: (ok, error) => { result = { ok, error }; } });
    // 實測輸出(帶 ANSI 色碼,應被剝掉)
    fakeProc.stdout.emit("data", Buffer.from(
      "Follow these steps to sign in with ChatGPT using device code authorization:\n\n" +
      "1. Open this link\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n" +
      "2. Enter this one-time code\n   \x1b[94mKH16-PSI71\x1b[0m\n",
    ));
    expect(url).toBe("https://auth.openai.com/codex/device");
    expect(code).toBe("KH16-PSI71");
    fakeProc.emit("exit", 0);
    expect(result).toEqual({ ok: true, error: undefined });
  });

  it("exit 非 0 → onResult(false, 帶尾部輸出)", async () => {
    const login = new LoginFlow();
    let result: { ok: boolean; error?: string } | undefined;
    login.start({ onUrl: () => {}, onResult: (ok, error) => { result = { ok, error }; } });
    fakeProc.stderr.emit("data", Buffer.from("device code expired"));
    fakeProc.emit("exit", 1);
    expect(result!.ok).toBe(false);
    expect(result!.error).toContain("device code expired");
  });

  it("URL/碼未齊不誤發(只有 URL 沒碼 → 不觸發 onUrl)", () => {
    const login = new LoginFlow();
    const onUrl = vi.fn();
    login.start({ onUrl, onResult: () => {} });
    fakeProc.stdout.emit("data", Buffer.from("visit https://auth.openai.com/codex/device now"));
    expect(onUrl).not.toHaveBeenCalled(); // 缺一次性碼
  });
});
