import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credPath, loadCreds, saveCreds, type Creds } from "../src/linkb/creds";

describe("Link B 憑證 load/save", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "occ-creds-"));
    process.env.MACCHIATO_CLAUDE_CODE_CRED = join(dir, "creds.json");
    delete process.env.MACCHIATO_SERVER_URL;
  });
  afterEach(() => {
    delete process.env.MACCHIATO_CLAUDE_CODE_CRED;
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

  it("#248 憑證文件損壞 → 返回 null(引導重配),不拋崩潰循環", () => {
    writeFileSync(credPath(), "{壞 json");
    expect(() => loadCreds()).not.toThrow(); // 此前裸 JSON.parse 拋到 main → systemd 崩潰循環
    expect(loadCreds()).toBeNull();
  });

  it("#248 原子寫:重寫保持 0600、無 .tmp 殘留", () => {
    saveCreds({ serverUrl: "wss://x", connectorToken: "a", agentLinkId: "al" });
    saveCreds({ serverUrl: "wss://x", connectorToken: "b", agentLinkId: "al" });
    expect(statSync(credPath()).mode & 0o777).toBe(0o600);
    expect(existsSync(credPath() + ".tmp")).toBe(false);
    expect(loadCreds()?.connectorToken).toBe("b");
  });
});
