import { describe, expect, it } from "vitest";
import { checkCompat, checkVersion, parseVersion, smokeParseLatest, versionGte } from "../src/cc/compat";
import { projectsDir } from "../src/cc/transcripts";
import { existsSync } from "node:fs";

describe("parseVersion / versionGte", () => {
  it("解析多種格式 + 比較", () => {
    expect(parseVersion("2.1.201 (Claude Code)")).toEqual([2, 1, 201]);
    expect(parseVersion("2.1.201")).toEqual([2, 1, 201]);
    expect(parseVersion("garbage")).toBeNull();
    expect(versionGte("2.1.201", "2.0.0")).toBe(true);
    expect(versionGte("2.0.0", "2.0.0")).toBe(true);
    expect(versionGte("1.9.9", "2.0.0")).toBe(false);
    expect(versionGte("2.1.5", "2.1.10")).toBe(false);
  });
});

describe("checkVersion", () => {
  it("缺失/畸形/過低 → 不兼容;達標 → 兼容", () => {
    expect(checkVersion(undefined).ok).toBe(false);
    expect(checkVersion("garbage").ok).toBe(false);
    expect(checkVersion("1.0.0").ok).toBe(false);
    expect(checkVersion("2.1.201").ok).toBe(true);
  });
});

describe("checkCompat (real transcripts)", () => {
  it("本機真實 transcript + 達標版本 → 兼容", () => {
    const r = checkCompat("2.1.201");
    if (existsSync(projectsDir())) {
      expect(r.ok).toBe(true);
    }
  });
  it("版本過低直接不兼容(不到解析階段)", () => {
    expect(checkCompat("1.0.0").ok).toBe(false);
  });
});

describe("smokeParseLatest", () => {
  it("無 transcript(或有真實 transcript)都不誤判失敗", () => {
    const r = smokeParseLatest();
    expect(typeof r.ok).toBe("boolean");
    if (existsSync(projectsDir())) expect(r.ok).toBe(true);
  });
});
