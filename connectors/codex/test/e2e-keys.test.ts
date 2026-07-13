import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2EKeyStore } from "../src/e2e/keys";
import * as ec from "../src/e2e/crypto";

describe("E2EKeyStore（持鑰/封裝/加解密/持久化）", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "occ-e2e-"));
    path = join(dir, "e2e.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("開啟 + isE2E + 同會話同一把", () => {
    const s = new E2EKeyStore(path);
    expect(s.isE2E("d1")).toBe(false);
    const k = s.getOrCreateKey("d1");
    expect(k.length).toBe(32);
    expect(s.isE2E("d1")).toBe(true);
    expect(s.getOrCreateKey("d1").equals(k)).toBe(true);
  });

  it("封裝給兩台設備 → 各自解出同一把 K_S；壞公鑰跳過", () => {
    const s = new E2EKeyStore(path);
    const a = ec.genDeviceKeypair();
    const b = ec.genDeviceKeypair();
    const wrapped = s.wrapForDevices("d1", [
      { deviceId: "A", pubKey: a.pubB64 },
      { deviceId: "B", pubKey: b.pubB64 },
      { deviceId: "C", pubKey: "!!bad" },
    ]);
    expect(wrapped.map((w) => w.deviceId)).toEqual(["A", "B"]);
    const k = s.getOrCreateKey("d1");
    expect(ec.unwrapKey(wrapped[0].sealed, a.priv).equals(k)).toBe(true);
    expect(ec.unwrapKey(wrapped[1].sealed, b.priv).equals(k)).toBe(true);
  });

  it("內容/文本往返 + 無鑰報錯", () => {
    const s = new E2EKeyStore(path);
    const obj = { text: "祕密", reasoning: "想" };
    expect(s.decryptContent("d1", s.encryptContent("d1", obj))).toEqual(obj);
    expect(s.decryptText("d1", s.encryptText("d1", "hi"))).toBe("hi");
    expect(() => s.decryptText("nope", "x")).toThrow();
  });

  it("持久化 0600 + 重載同鑰", () => {
    const s = new E2EKeyStore(path);
    const k = s.getOrCreateKey("d1");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const s2 = new E2EKeyStore(path);
    expect(s2.isE2E("d1")).toBe(true);
    expect(s2.getOrCreateKey("d1").equals(k)).toBe(true);
  });
});

describe("#144 keystore 路徑隔離(fork 殘留回歸)", () => {
  it("默認路徑是 codex 專屬,絕不與 CC 共用(兩常駐進程整檔重寫會互相覆蓋 K_S)", async () => {
    const prev = process.env.MACCHIATO_CODEX_E2E_STORE;
    delete process.env.MACCHIATO_CODEX_E2E_STORE;
    const { e2eStorePath } = await import("../src/e2e/keys");
    expect(e2eStorePath()).toContain("codex-e2e.json");
    expect(e2eStorePath()).not.toContain("claude-code-e2e.json");
    // env 覆蓋走 codex 專屬變量
    process.env.MACCHIATO_CODEX_E2E_STORE = "/x/custom.json";
    expect(e2eStorePath()).toBe("/x/custom.json");
    if (prev === undefined) delete process.env.MACCHIATO_CODEX_E2E_STORE;
    else process.env.MACCHIATO_CODEX_E2E_STORE = prev;
  });
});
