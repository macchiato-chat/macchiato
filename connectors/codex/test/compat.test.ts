import { describe, expect, it } from "vitest";
import { checkVersion, parseVersion, versionGte, MIN_CLI_VERSION } from "../src/codex/compat";

describe("codex compat 版本門檻", () => {
  it("parseVersion / versionGte", () => {
    expect(parseVersion("codex-cli 0.144.1")).toEqual([0, 144, 1]);
    expect(parseVersion("garbage")).toBeNull();
    expect(versionGte("0.144.1", MIN_CLI_VERSION)).toBe(true);
    expect(versionGte("0.139.0", MIN_CLI_VERSION)).toBe(false);
  });
  it("checkVersion:未找到/太舊/OK", () => {
    expect(checkVersion(undefined).ok).toBe(false);
    expect(checkVersion("0.130.0").ok).toBe(false);
    expect(checkVersion("0.144.1").ok).toBe(true);
  });
});
