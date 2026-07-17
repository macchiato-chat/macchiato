import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_BLOCK_MAX, imageBlockFor, isPrivateIp, materializeAttachment, pinnedLookup, validateDownloadUrl } from "../src/cc/attachments";

describe("imageBlockFor (#118 原生圖片入站)", () => {
  it("支持類型且 ≤3.5MB → image block;非圖/超限/讀失敗 → null(回退路徑注入)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-img-"));
    const small = join(dir, "a.png");
    writeFileSync(small, Buffer.alloc(16, 1));
    expect(imageBlockFor(small, "image/png")).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png" },
    });
    expect(imageBlockFor(small, "IMAGE/JPEG")).toMatchObject({ source: { media_type: "image/jpeg" } }); // mime 大小寫容錯
    expect(imageBlockFor(small, "application/pdf")).toBeNull(); // 非圖
    expect(imageBlockFor(small, "image/svg+xml")).toBeNull(); // API 不支持的圖片類型
    const big = join(dir, "big.png");
    writeFileSync(big, Buffer.alloc(IMAGE_BLOCK_MAX + 1));
    expect(imageBlockFor(big, "image/png")).toBeNull(); // 超限
    expect(imageBlockFor(join(dir, "missing.png"), "image/png")).toBeNull(); // 讀失敗
  });
});

describe("isPrivateIp", () => {
  it("私網/環回/link-local/雲元數據 → true;公網 → false", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])
      expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1::"])
      expect(isPrivateIp(ip), ip).toBe(false);
  });
});

describe("validateDownloadUrl", () => {
  it("拒 file/ftp/data、http 非 localhost、私網/雲元數據 https;放行 http+localhost", async () => {
    for (const bad of ["file:///etc/passwd", "ftp://x/y", "data:text/plain,hi", "http://evil.com/x", "https://169.254.169.254/x", "https://127.0.0.1/x", "https://10.0.0.5/x"])
      await expect(validateDownloadUrl(bad), bad).rejects.toThrow();
    await expect(validateDownloadUrl("http://localhost:8080/x")).resolves.toBeUndefined();
    await expect(validateDownloadUrl("http://127.0.0.1:9/x")).resolves.toBeUndefined();
  });
});

describe("materializeAttachment", () => {
  it("http+localhost 真下載落盤,內容正確", async () => {
    const payload = Buffer.from("\x89PNG-attachment-body");
    const srv = createServer((_q, res) => res.end(payload));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "cc-att-"));
    process.env.MACCHIATO_CC_ATTACH_DIR = dir;
    try {
      const p = await materializeAttachment({ id: "a1", name: "pic.png", url: `http://127.0.0.1:${port}/pic.png` });
      expect(readFileSync(p)).toEqual(payload);
      expect(p).toContain("pic.png");
    } finally {
      srv.close();
    }
  });
  it("拒絕 file:// url(不落盤)", async () => {
    await expect(materializeAttachment({ id: "b", name: "n", url: "file:///etc/passwd" })).rejects.toThrow();
  });
});

describe("#249 pinnedLookup(連接時校驗實際 IP,防 rebinding TOCTOU)", () => {
  it("解析到私網 IP → 拒(rebinding 換的正是這次連接的 IP)", async () => {
    // localhost 必解析到環回(127.0.0.1/::1)= 私網 → pinnedLookup 應報錯
    await expect(
      new Promise<string>((resolve, reject) =>
        pinnedLookup("localhost", {}, (err, addr) => (err ? reject(err) : resolve(addr))),
      ),
    ).rejects.toThrow(/私網|SSRF/);
  });
  it("解析到公網 IP → 放行(以字面公網 IP 為例,lookup 原樣返回)", async () => {
    const addr = await new Promise<string>((resolve, reject) =>
      pinnedLookup("1.1.1.1", {}, (err, a) => (err ? reject(err) : resolve(a))),
    );
    expect(addr).toBe("1.1.1.1");
  });
});
