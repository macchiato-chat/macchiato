import { describe, expect, it } from "vitest";
import { isPrivateIp, pinnedLookup, validateDownloadUrl } from "../src/openclaw/attachments";

describe("openclaw SSRF 防護(#249/#270)", () => {
  it("isPrivateIp:私網/環回/link-local/雲元數據 → true;公網 → false", () => {
    for (const ip of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.1", "172.16.0.1", "::1", "fd00::1"])
      expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34"]) expect(isPrivateIp(ip), ip).toBe(false);
  });

  it("validateDownloadUrl:拒 file/ftp/data、http 非 localhost、字面私網 https;放行 http+localhost", async () => {
    for (const bad of ["file:///etc/passwd", "ftp://x/y", "data:text/plain,hi", "http://evil.com/x", "https://169.254.169.254/x", "https://127.0.0.1/x", "https://10.0.0.5/x"])
      await expect(validateDownloadUrl(bad), bad).rejects.toThrow();
    await expect(validateDownloadUrl("http://localhost:8080/x")).resolves.toBeUndefined();
  });

  it("#249 pinnedLookup:解析到私網 IP → 拒(連接時校驗實際 IP,防 rebinding TOCTOU)", async () => {
    // localhost 必解析到環回 = 私網 → pinnedLookup 應報錯
    await expect(
      new Promise<string>((resolve, reject) => pinnedLookup("localhost", {}, (err, addr) => (err ? reject(err) : resolve(addr)))),
    ).rejects.toThrow(/私網|SSRF/);
    // 字面公網 IP → 原樣放行
    const addr = await new Promise<string>((resolve, reject) =>
      pinnedLookup("1.1.1.1", {}, (err, a) => (err ? reject(err) : resolve(a))),
    );
    expect(addr).toBe("1.1.1.1");
  });
});
