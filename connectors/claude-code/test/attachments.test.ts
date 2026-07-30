import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_BLOCK_MAX, imageBlockFor, isPrivateIp, materializeAttachment, pinnedLookup, validateDownloadUrl } from "../src/cc/attachments";

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

describe("validateDownloadUrl (#379 生產拒 localhost)", () => {
  it("生產默認拒 file/ftp/data/http/loopback、私網 https", async () => {
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

  it("dev env 下放行 http→loopback（host/port/path 對齊）；錯 port/path/userinfo 仍拒", async () => {
    process.env.MACCHIATO_ATTACH_ALLOW_LOCALHOST = "1";
    // 默認 port 8080 + path /attachments
    for (const ok of [
      "http://localhost:8080/attachments/raw?k=1",
      "http://127.0.0.1:8080/attachments/x",
      "http://[::1]:8080/attachments",
    ])
      await expect(validateDownloadUrl(ok), ok).resolves.toBeUndefined();

    for (const bad of [
      "http://localhost/attachments/x", // 缺端口 → 80 ≠ 8080
      "http://localhost:9/attachments/x", // 錯端口
      "http://localhost:8080/other/x", // 錯 path
      "http://evil@127.0.0.1:8080/attachments/x", // userinfo
      "http://0.0.0.0:8080/attachments/x", // 非 loopback 字面
      "https://localhost:8080/attachments/x", // https→loopback 仍走 isPrivateIp 拒
    ])
      await expect(validateDownloadUrl(bad), bad).rejects.toThrow();

    process.env.MACCHIATO_ATTACH_LOCAL_PORT = "9999";
    process.env.MACCHIATO_ATTACH_LOCAL_PATH_PREFIX = "/media";
    await expect(validateDownloadUrl("http://127.0.0.1:9999/media/a")).resolves.toBeUndefined();
    await expect(validateDownloadUrl("http://127.0.0.1:8080/media/a")).rejects.toThrow();
    await expect(validateDownloadUrl("http://127.0.0.1:9999/attachments/a")).rejects.toThrow();
  });
});

describe("materializeAttachment", () => {
  it("dev env 下 http+loopback 真下載落盤,內容正確", async () => {
    const payload = Buffer.from("\x89PNG-attachment-body");
    const srv = createServer((_q, res) => res.end(payload));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "cc-att-"));
    process.env.MACCHIATO_CC_ATTACH_DIR = dir;
    process.env.MACCHIATO_ATTACH_ALLOW_LOCALHOST = "1";
    process.env.MACCHIATO_ATTACH_LOCAL_PORT = String(port);
    process.env.MACCHIATO_ATTACH_LOCAL_PATH_PREFIX = "/attachments";
    try {
      const p = await materializeAttachment({
        id: "a1",
        name: "pic.png",
        url: `http://127.0.0.1:${port}/attachments/pic.png`,
      });
      expect(readFileSync(p)).toEqual(payload);
      expect(p).toContain("pic.png");
    } finally {
      srv.close();
    }
  });
  it("生產默認拒絕 localhost 下載", async () => {
    clearLocalAttachEnv();
    await expect(
      materializeAttachment({ id: "b", name: "n", url: "http://127.0.0.1:8080/attachments/x" }),
    ).rejects.toThrow();
  });
  it("拒絕 file:// url(不落盤)", async () => {
    await expect(materializeAttachment({ id: "b", name: "n", url: "file:///etc/passwd" })).rejects.toThrow();
  });
});

describe("#249 pinnedLookup(連接時校驗實際 IP,防 rebinding TOCTOU)", () => {
  it("解析到私網 IP → 拒(rebinding 換的正是這次連接的 IP)", async () => {
    // localhost 必解析到環回(127.0.0.1/::1)= 私網 → pinnedLookup 應報錯
    await expect(
      new Promise((resolve, reject) =>
        pinnedLookup("localhost", {}, (err, addr) => (err ? reject(err) : resolve(addr))),
      ),
    ).rejects.toThrow(/私網|SSRF/);
  });
  it("解析到公網 IP → 放行(以字面公網 IP 為例,lookup 原樣返回)", async () => {
    const addr = await new Promise((resolve, reject) =>
      pinnedLookup("1.1.1.1", {}, (err, a) => (err ? reject(err) : resolve(a))),
    );
    expect(addr).toBe("1.1.1.1");
  });

  // Node 20+ 的 autoSelectFamily(默認開)就是用 all:true 調 lookup 的,並期待回調給**數組**。
  // 舊實現強行改寫成 all:false 回字符串 → Node 讀 addresses[0].address 得 undefined,
  // 拋 `Invalid IP address: undefined`,https 附件下載全掛(本地 dev 走 http 繞開 lookup,故長期沒暴露)。
  // 這條用例只要退回「覆蓋 all」的寫法就會紅。
  it("pinnedLookup:調用方要 all:true 時必須回數組,且逐個校驗私網", async () => {
    const many = await new Promise<unknown>((resolve, reject) =>
      pinnedLookup("1.1.1.1", { all: true }, (err, a) => (err ? reject(err) : resolve(a))),
    );
    expect(Array.isArray(many)).toBe(true);
    expect(many).toEqual([expect.objectContaining({ address: "1.1.1.1" })]);

    // localhost 在 all:true 下會回 ::1 與 127.0.0.1 兩條,任意一條是私網就得拒。
    await expect(
      new Promise((resolve, reject) =>
        pinnedLookup("localhost", { all: true }, (err, a) => (err ? reject(err) : resolve(a))),
      ),
    ).rejects.toThrow(/私網|SSRF/);
  });
});
