/**
 * F-13 / #490:Codex 無 session.rewind 能力 → hello 絕不可宣告 rewind。
 * (底層 app-server 沒有截斷上下文 API;裝有會讓 App 亮入口、用戶白等。)
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("#490 hello rewind cap(codex)", () => {
  it("linkb hello 不宣告 rewind", () => {
    const src = readFileSync(new URL("../src/linkb/client.ts", import.meta.url), "utf8");
    const idx = src.search(/t\s*:\s*["']hello["']/);
    expect(idx).toBeGreaterThanOrEqual(0);
    const window = src.slice(idx, idx + 900);
    expect(window).not.toMatch(/["']?rewind["']?\s*:\s*1\b/);
  });

  it("drive 無 session.rewind handler", () => {
    for (const rel of ["../src/codex/drive.ts", "../src/codex/drive-appserver.ts"]) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      const codeLines = src.split("\n").map((l) => l.replace(/\/\/.*$/, ""));
      expect(codeLines.some((l) => l.includes("session.rewind"))).toBe(false);
    }
  });
});
