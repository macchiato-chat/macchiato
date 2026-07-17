import { describe, expect, it } from "vitest";
import { checkVersion, checkCompat, parseVersion, versionGte, MIN_CLI_VERSION, MAX_VERIFIED_VERSION } from "../src/codex/compat";

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
  it("#258 超出實測上限 → ok=true + advisory(不判降級,只提醒漂移)", () => {
    // 無 rollout 時 smokeParse ok;高於 MAX_VERIFIED 的版本帶 advisory
    const r = checkCompat("9.99.9");
    expect(r.ok).toBe(true);
    expect(r.advisory).toContain(MAX_VERIFIED_VERSION);
    // 恰好等於上限 → 無 advisory
    expect(checkCompat(MAX_VERIFIED_VERSION).advisory).toBeUndefined();
  });
});
