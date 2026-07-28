import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractMediaPaths,
  readMediaFile,
  resolveMediaAllowRoots,
  resolveAllowedMediaPath,
  withinRoot,
  MEDIA_MAX,
  MEDIA_ALLOW_ROOTS_ENV,
} from "../src/openclaw/media";

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** #158 + #372 出站附件:capability-bound MEDIA: 解析 + 安全讀取。 */
describe("#372 media allow roots", () => {
  const prev = process.env[MEDIA_ALLOW_ROOTS_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[MEDIA_ALLOW_ROOTS_ENV];
    else process.env[MEDIA_ALLOW_ROOTS_ENV] = prev;
  });

  it("withinRoot 邊界安全(防 /a/bc 誤判在 /a/b 內)", () => {
    expect(withinRoot("/a/b", "/a/b/c")).toBe(true);
    expect(withinRoot("/a/b", "/a/b")).toBe(true);
    expect(withinRoot("/a/b", "/a/bc")).toBe(false);
    expect(withinRoot("/a/b", "/a/b2")).toBe(false);
  });

  it("resolveMediaAllowRoots:session cwd + env 額外根;不存在跳過", () => {
    const a = tempDir("oc-root-a-");
    const b = tempDir("oc-root-b-");
    process.env[MEDIA_ALLOW_ROOTS_ENV] = b;
    const roots = resolveMediaAllowRoots({ sessionCwd: a });
    expect(roots).toContain(a);
    expect(roots).toContain(b);
    // 幽靈根不進列表
    const roots2 = resolveMediaAllowRoots({
      sessionCwd: join(a, "definitely-missing-subdir-xyz"),
      extraRoots: [a],
    });
    expect(roots2).toContain(a);
    expect(roots2.every((r) => !r.includes("definitely-missing"))).toBe(true);
  });
});

describe("#158/#372 extractMediaPaths", () => {
  it("僅 MEDIA: 且在允許根內;裸路徑不再自動上傳;去重", () => {
    const dir = tempDir("oc-media-");
    const img = join(dir, "shot.png");
    writeFileSync(img, "fakepng");
    const text = [
      `這是截圖`,
      `MEDIA: ${img}`,
      `正文裡也提了 ${img} 一次(bare 不再收)`,
      `不存在的 MEDIA: /tmp/definitely-not-here-158.png 不算`,
      `相對路徑 MEDIA: ./a.png 不算`,
    ].join("\n");
    expect(extractMediaPaths(text, [dir])).toEqual([img]);
    // 空根 fail closed
    expect(extractMediaPaths(text, [])).toEqual([]);
  });

  it("負例:根外敏感路徑一律拒(/etc/hosts、~/.ssh、.env)", () => {
    const dir = tempDir("oc-media-deny-");
    // /etc/hosts 在真實機器上通常存在——必須被擋
    expect(resolveAllowedMediaPath("/etc/hosts", [dir])).toBeNull();
    expect(extractMediaPaths("MEDIA: /etc/hosts", [dir])).toEqual([]);
    // 無擴展名敏感路徑
    expect(extractMediaPaths("MEDIA: /etc/passwd", [dir])).toEqual([]);
    // 構造一個「看起來像 ssh key」的路徑在根外
    const outside = tempDir("oc-media-out-");
    const key = join(outside, "id_rsa");
    writeFileSync(key, "FAKE PRIVATE KEY");
    expect(resolveAllowedMediaPath(key, [dir])).toBeNull();
    expect(extractMediaPaths(`MEDIA: ${key}`, [dir])).toEqual([]);
    // .env 在根外
    const envFile = join(outside, ".env");
    writeFileSync(envFile, "SECRET=1");
    expect(resolveAllowedMediaPath(envFile, [dir])).toBeNull();
  });

  it("負例:symlink 逃逸到根外 → 拒", () => {
    const root = tempDir("oc-media-sym-root-");
    const outside = tempDir("oc-media-sym-out-");
    const secret = join(outside, "secret.png");
    writeFileSync(secret, "SECRET");
    const link = join(root, "escape.png");
    symlinkSync(secret, link);
    // realpath 解析到 outside → 不在 root 內
    expect(resolveAllowedMediaPath(link, [root])).toBeNull();
    expect(extractMediaPaths(`MEDIA: ${link}`, [root])).toEqual([]);
  });

  it("正例:允許根內真實文件(含根內 symlink)", () => {
    const root = tempDir("oc-media-ok-");
    const real = join(root, "real.png");
    writeFileSync(real, "IMG");
    const link = join(root, "alias.png");
    symlinkSync(real, link);
    expect(resolveAllowedMediaPath(real, [root])).toBe(realpathSync(real));
    expect(resolveAllowedMediaPath(link, [root])).toBe(realpathSync(real));
    expect(extractMediaPaths(`MEDIA: ${link}`, [root])).toEqual([realpathSync(real)]);
  });
});

describe("#158/#372 readMediaFile", () => {
  it("payload 形狀對齊 Hermes;超限/不存在/根外 → null", () => {
    const dir = tempDir("oc-media2-");
    const f = join(dir, "report.pdf");
    writeFileSync(f, "PDFDATA");
    const p = readMediaFile(f, [dir])!;
    expect(p).toMatchObject({ kind: "document", name: "report.pdf", mime: "application/pdf", size: 7 });
    expect(Buffer.from(p.data_b64, "base64").toString()).toBe("PDFDATA");
    expect(readMediaFile(join(dir, "nope.png"), [dir])).toBeNull();
    expect(readMediaFile("/etc/hosts", [dir])).toBeNull();
    expect(MEDIA_MAX).toBe(12 * 1024 * 1024);

    const big = join(dir, "big.bin");
    writeFileSync(big, Buffer.alloc(MEDIA_MAX + 1, 0x41));
    expect(readMediaFile(big, [dir])).toBeNull();
  });

  it("負例:目錄不是常規文件 → null", () => {
    const dir = tempDir("oc-media-dir-");
    const sub = join(dir, "subdir");
    mkdirSync(sub);
    expect(readMediaFile(sub, [dir])).toBeNull();
  });
});
