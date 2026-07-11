import { describe, expect, it } from "vitest";
import { backoffMs, RECONNECT_BASE_MS, RECONNECT_MAX_MS, shouldAlert } from "../src/backoff";

describe("#3 重連指數退避", () => {
  it("指數增長、封頂 60s;抖動落在 [50%,100%] 檔內", () => {
    for (let f = 0; f < 15; f++) {
      const cap = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(f, 10));
      for (let i = 0; i < 20; i++) {
        const d = backoffMs(f);
        expect(d).toBeGreaterThanOrEqual(cap / 2);
        expect(d).toBeLessThanOrEqual(cap);
      }
    }
    // 封頂:第 10 次以後不再增長
    expect(backoffMs(50)).toBeLessThanOrEqual(RECONNECT_MAX_MS);
    // 負數容錯
    expect(backoffMs(-1)).toBeGreaterThanOrEqual(RECONNECT_BASE_MS / 2);
  });

  it("shouldAlert:每 5 次一聲,0 次不叫", () => {
    expect(shouldAlert(0)).toBe(false);
    expect(shouldAlert(1)).toBe(false);
    expect(shouldAlert(5)).toBe(true);
    expect(shouldAlert(7)).toBe(false);
    expect(shouldAlert(10)).toBe(true);
  });
});
