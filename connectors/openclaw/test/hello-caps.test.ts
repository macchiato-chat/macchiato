/**
 * F-13 / #490:OpenClaw 無 session.rewind 能力 → hello 絕不可宣告 rewind。
 * (底層 agent 只有 /reset 全清,沒有按消息截斷;裝有會讓 App 亮入口、用戶白等。)
 * #572 後 hello 能力位由 declareRewind 注入；OpenClaw 不得設 true。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("#490 hello rewind cap(openclaw)", () => {
  // 「缺省 false / 不寫死 rewind:1」的注入邏輯由 connector-core 的 test/hello-caps.test.ts
  // 抓真實 hello 幀斷言(#633,含「三個開關全關 → 一個都不出現」這條正是 OpenClaw 的形狀);
  // 這裡只管本家接線:誰都不許把它打開。
  it("index 不開啟 declareRewind / declareFork / declarePromptModes", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(index).not.toMatch(/declareRewind\s*=\s*true/);
    expect(index).not.toMatch(/declareFork\s*=\s*true/);
    expect(index).not.toMatch(/declarePromptModes\s*=\s*true/);
  });

  it("drive 無 session.rewind handler", () => {
    const src = readFileSync(new URL("../src/openclaw/drive.ts", import.meta.url), "utf8");
    const codeLines = src.split("\n").map((l) => l.replace(/\/\/.*$/, ""));
    expect(codeLines.some((l) => l.includes("session.rewind"))).toBe(false);
  });
});
