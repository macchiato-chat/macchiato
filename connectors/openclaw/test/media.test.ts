import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMediaPaths, readMediaFile, MEDIA_MAX } from "../src/openclaw/media";

/** #158 出站附件:MEDIA: 標記/裸路徑解析(存在性校驗、去重、防誤報)+ 讀文件 payload。 */
describe("#158 extractMediaPaths", () => {
  it("MEDIA: 標記 + 裸絕對路徑(存在才算);不存在/相對路徑/無副檔名不誤報;去重", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-media-"));
    const img = join(dir, "shot.png");
    writeFileSync(img, "fakepng");
    const text = [
      `這是截圖`,
      `MEDIA: ${img}`,
      `正文裡也提了 ${img} 一次(去重)`,
      `不存在的 /tmp/definitely-not-here-158.png 不算`,
      `相對路徑 ./a.png 不算;無副檔名 /usr/bin/env 不算`,
    ].join("\n");
    expect(extractMediaPaths(text)).toEqual([img]);
  });

  it("readMediaFile:payload 形狀對齊 Hermes;超限/不存在 → null", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-media2-"));
    const f = join(dir, "report.pdf");
    writeFileSync(f, "PDFDATA");
    const p = readMediaFile(f)!;
    expect(p).toMatchObject({ kind: "document", name: "report.pdf", mime: "application/pdf", size: 7 });
    expect(Buffer.from(p.data_b64, "base64").toString()).toBe("PDFDATA");
    expect(readMediaFile(join(dir, "nope.png"))).toBeNull();
    expect(MEDIA_MAX).toBe(12 * 1024 * 1024);
  });
});
