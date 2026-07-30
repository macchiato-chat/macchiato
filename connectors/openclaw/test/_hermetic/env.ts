/**
 * #303 hermetic env：按後綴模式清空憑證形變量 + 釘死時區。
 * 對齊 Hermes 根 conftest / docs/testing-strategy.md §6——本地跑法 == CI 跑法，
 * 宿主機洩漏的 ANTHROPIC_API_KEY / OPENAI_API_KEY / *_TOKEN 不得進單測。
 */

/** 憑證形 env 後綴（後綴匹配，避免列舉每一家 provider）。 */
export const CREDENTIAL_ENV_SUFFIXES = ["_API_KEY", "_TOKEN", "_SECRET"] as const;

const CREDENTIAL_ENV_RE = /_(?:API_KEY|TOKEN|SECRET)$/;

/**
 * 刪除 env 中所有 `*_API_KEY` / `*_TOKEN` / `*_SECRET`。
 * @returns 被刪除的 key 列表（供單測斷言；順序不保證）。
 */
export function scrubCredentialEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    if (CREDENTIAL_ENV_RE.test(key)) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}

/** 是否為憑證形 env key（純謂詞，不改 env）。 */
export function isCredentialEnvKey(key: string): boolean {
  return CREDENTIAL_ENV_RE.test(key);
}

/** 釘死 TZ=UTC，令 Date 格式化 / 日誌時間戳在本地與 CI 一致。 */
export function pinTestTimeZone(env: NodeJS.ProcessEnv = process.env): void {
  env.TZ = "UTC";
}
