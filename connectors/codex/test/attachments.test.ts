import { afterEach, describe, expect, it } from "vitest";
import { isPrivateIp, pinnedLookup, validateDownloadUrl } from "../src/codex/attachments";

const LOCAL_ENV_KEYS = [
  "MACCHIATO_ATTACH_ALLOW_LOCALHOST",
  "MACCHIATO_ATTACH_LOCAL_PORT",
  "MACCHIATO_ATTACH_LOCAL_PATH_PREFIX",
] as const;

function clearLocalAttachEnv() {
  for (const k of LOCAL_ENV_KEYS) delete process.env[k];
}

afterEach(() => {
  clearLocalAttachEnv();
});

describe("codex SSRF 防護(#249/#379)", () => {
  it("isPrivateIp:私網/環回/link-local/雲元數據 → true;公網 → false", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])
      expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1::"])
      expect(isPrivateIp(ip), ip).toBe(false);
  });

  it("validateDownloadUrl:生產默認拒 file/ftp/data/http/loopback、私網 https", async () => {
    clearLocalAttachEnv();
    for (const bad of [
      "file:///etc/passwd",
      "ftp://x/y",
      "data:text/plain,hi",
      "http://evil.com/x",
      "http://localhost:8080/attachments/x",
      "http://127.0.0.1:8080/attachments/x",
      "http://[::1]:8080/attachments/x",
      "http://0.0.0.0:8080/attachments/x",
      "https://169.254.169.254/x",
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
    ])
      await expect(validateDownloadUrl(bad), bad).rejects.toThrow();
  });

  it("validateDownloadUrl:dev env 下放行 http→loopback；錯 port/path/userinfo 仍拒", async () => {
    process.env.MACCHIATO_ATTACH_ALLOW_LOCALHOST = "1";
    for (const ok of [
      "http://localhost:8080/attachments/raw?k=1",
      "http://127.0.0.1:8080/attachments/x",
      "http://[::1]:8080/attachments",
    ])
      await expect(validateDownloadUrl(ok), ok).resolves.toBeUndefined();

    for (const bad of [
      "http://localhost/attachments/x",
      "http://localhost:9/attachments/x",
      "http://localhost:8080/other/x",
      "http://evil@127.0.0.1:8080/attachments/x",
      "http://0.0.0.0:8080/attachments/x",
      "https://localhost:8080/attachments/x",
    ])
      await expect(validateDownloadUrl(bad), bad).rejects.toThrow();

    process.env.MACCHIATO_ATTACH_LOCAL_PORT = "9999";
    process.env.MACCHIATO_ATTACH_LOCAL_PATH_PREFIX = "/media";
    await expect(validateDownloadUrl("http://127.0.0.1:9999/media/a")).resolves.toBeUndefined();
    await expect(validateDownloadUrl("http://127.0.0.1:8080/media/a")).rejects.toThrow();
  });

  it("#249 pinnedLookup:解析到私網 IP → 拒", async () => {
    await expect(
      new Promise<string>((resolve, reject) =>
        pinnedLookup("localhost", {}, (err, addr) => (err ? reject(err) : resolve(addr))),
      ),
    ).rejects.toThrow(/私網|SSRF/);
    const addr = await new Promise<string>((resolve, reject) =>
      pinnedLookup("1.1.1.1", {}, (err, a) => (err ? reject(err) : resolve(a))),
    );
    expect(addr).toBe("1.1.1.1");
  });
});
