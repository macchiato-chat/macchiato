/**
 * #3 重連指數退避:3s 起步、×2、封頂 60s,帶 [50%,100%] 抖動(防多實例齊步重連)。
 * 連上即歸零;連續失敗由調用方按 failures 告警(每 5 次一行 + health 上浮)。
 * 此前固定 3s 死磕——斷網一晚 = 上萬次重連。
 */
export const RECONNECT_BASE_MS = 3000;
export const RECONNECT_MAX_MS = 60_000;

export function backoffMs(failures: number): number {
  const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(Math.max(failures, 0), 10));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

/** 連續失敗是否該告警(每 5 次一行,免刷屏)。 */
export function shouldAlert(failures: number): boolean {
  return failures > 0 && failures % 5 === 0;
}
