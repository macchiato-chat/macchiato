import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCreds, saveCreds, type Creds } from "../src/_core/linkb/creds";
import { credPath } from "../src/_core/identity";
const KIND = "codex" as const;

describe("Link B 憑證 load/save", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "occ-creds-"));
    process.env.MACCHIATO_CODEX_CRED = join(dir, "creds.json");
    delete process.env.MACCHIATO_SERVER_URL;
  });
  afterEach(() => {
    delete process.env.MACCHIATO_CODEX_CRED;
    delete process.env.MACCHIATO_SERVER_URL;
    rmSync(dir, { recursive: true, force: true });
  });

  it("未配對返回 null", () => {
    expect(loadCreds(KIND)).toBeNull();
  });

  it("存→讀 round-trip + 0600 權限", () => {
    const c: Creds = { serverUrl: "wss://x/connector", connectorToken: "tok123", agentLinkId: "al1", label: "pi" };
    saveCreds(KIND, c);
    expect(statSync(credPath(KIND)).mode & 0o777).toBe(0o600);
    const loaded = loadCreds(KIND);
    expect(loaded?.connectorToken).toBe("tok123");
    expect(loaded?.agentLinkId).toBe("al1");
    expect(loaded?.serverUrl).toBe("wss://x/connector");
  });

  it("env MACCHIATO_SERVER_URL 覆蓋文件的 serverUrl", () => {
    saveCreds(KIND, { serverUrl: "wss://file/connector", connectorToken: "t", agentLinkId: "a" });
    process.env.MACCHIATO_SERVER_URL = "wss://env/connector";
    expect(loadCreds(KIND)?.serverUrl).toBe("wss://env/connector");
  });

  it("缺 token/agentLinkId 視為未配對", () => {
    saveCreds(KIND, { serverUrl: "wss://x", connectorToken: "", agentLinkId: "" } as Creds);
    expect(loadCreds(KIND)).toBeNull();
  });
});
