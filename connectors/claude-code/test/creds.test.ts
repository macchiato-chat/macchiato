import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCreds, quarantineCreds, saveCreds, type Creds } from "../src/_core/linkb/creds";
import { credPath } from "../src/_core/identity";
const KIND = "claude-code" as const;

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

  it("#248 憑證文件損壞 → 返回 null(引導重配),不拋崩潰循環", () => {
    writeFileSync(credPath(KIND), "{壞 json");
    expect(() => loadCreds(KIND)).not.toThrow(); // 此前裸 JSON.parse 拋到 main → systemd 崩潰循環
    expect(loadCreds(KIND)).toBeNull();
  });

  it("#248 原子寫:重寫保持 0600、無 .tmp 殘留", () => {
    saveCreds(KIND, { serverUrl: "wss://x", connectorToken: "a", agentLinkId: "al" });
    saveCreds(KIND, { serverUrl: "wss://x", connectorToken: "b", agentLinkId: "al" });
    expect(statSync(credPath(KIND)).mode & 0o777).toBe(0o600);
    expect(existsSync(credPath(KIND) + ".tmp")).toBe(false);
    expect(loadCreds(KIND)?.connectorToken).toBe("b");
  });

  it("#387 quarantineCreds:改名 .revoked 留痕,loadCreds 回到未配對;無憑證時 no-op", () => {
    expect(quarantineCreds(KIND)).toBeNull(); // 無憑證 no-op
    saveCreds(KIND, { serverUrl: "wss://x", connectorToken: "t", agentLinkId: "al" });
    expect(quarantineCreds(KIND)).toBe(credPath(KIND) + ".revoked");
    expect(existsSync(credPath(KIND))).toBe(false);
    expect(existsSync(credPath(KIND) + ".revoked")).toBe(true); // 留痕(重跑安裝時清掉)
    expect(loadCreds(KIND)).toBeNull(); // 服務重啟 → 進等待配對,不再拿死 token 空轉
  });
});
