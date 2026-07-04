import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credPath, loadCreds, saveCreds, type Creds } from "../src/linkb/creds";

describe("Link B 憑證 load/save", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "occ-creds-"));
    process.env.MACCHIATO_OPENCLAW_CRED = join(dir, "creds.json");
    delete process.env.MACCHIATO_SERVER_URL;
  });
  afterEach(() => {
    delete process.env.MACCHIATO_OPENCLAW_CRED;
    delete process.env.MACCHIATO_SERVER_URL;
    rmSync(dir, { recursive: true, force: true });
  });

  it("未配對返回 null", () => {
    expect(loadCreds()).toBeNull();
  });

  it("存→讀 round-trip + 0600 權限", () => {
    const c: Creds = { serverUrl: "wss://x/connector", connectorToken: "tok123", agentLinkId: "al1", label: "pi" };
    saveCreds(c);
    expect(statSync(credPath()).mode & 0o777).toBe(0o600);
    const loaded = loadCreds();
    expect(loaded?.connectorToken).toBe("tok123");
    expect(loaded?.agentLinkId).toBe("al1");
    expect(loaded?.serverUrl).toBe("wss://x/connector");
  });

  it("env MACCHIATO_SERVER_URL 覆蓋文件的 serverUrl", () => {
    saveCreds({ serverUrl: "wss://file/connector", connectorToken: "t", agentLinkId: "a" });
    process.env.MACCHIATO_SERVER_URL = "wss://env/connector";
    expect(loadCreds()?.serverUrl).toBe("wss://env/connector");
  });

  it("缺 token/agentLinkId 視為未配對", () => {
    saveCreds({ serverUrl: "wss://x", connectorToken: "", agentLinkId: "" } as Creds);
    expect(loadCreds()).toBeNull();
  });
});
