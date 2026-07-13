import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** #151:入站附件 TTL GC——過期文件刪除、空 id 目錄清掉、新文件保留。 */
describe("#151 attachments GC", () => {
  it("過期文件刪、空目錄清、新文件留;節流由 now 參數繞開", async () => {
    const dir = mkdtempSync(join(tmpdir(), "att-gc-"));
    process.env.MACCHIATO_CC_ATTACH_DIR = dir;
    process.env.MACCHIATO_CODEX_ATTACH_DIR = dir;
    const { gcAttachments } = await import("../src/codex/attachments");
    const oldDir = join(dir, "old1");
    const newDir = join(dir, "new1");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    const oldFile = join(oldDir, "a.png");
    const newFile = join(newDir, "b.png");
    writeFileSync(oldFile, "x");
    writeFileSync(newFile, "y");
    const past = (Date.now() - 7 * 3600 * 1000) / 1000; // 7h 前(TTL 默認 6h)
    utimesSync(oldFile, past, past);
    const removed = gcAttachments(Date.now() + 11 * 60_000); // 繞開 10min 節流窗
    expect(removed).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(oldDir)).toBe(false); // 空 id 目錄清掉
    expect(existsSync(newFile)).toBe(true);
  });
});
