/**
 * 解析 claude CLI 可執行路徑,**不依賴進程 PATH**。
 * systemd user 服務不繼承登錄 PATH(常缺 ~/.local/bin)→ `execFile("claude")` 找不到 →
 * 健康探測失敗誤報降級(2026-07-08 本機實測)。故顯式按候選位置定位。
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

let cached: string | undefined;

export function resolveClaudeBin(): string {
  if (cached) return cached;
  const override = process.env.MACCHIATO_CLAUDE_BIN;
  if (override && existsSync(override)) return (cached = override);
  // 先走 PATH(execFile 也會這麼找,但這裡拿到絕對路徑供 SDK pathToClaudeCodeExecutable 用)
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (dir && existsSync(join(dir, "claude"))) return (cached = join(dir, "claude"));
  }
  // 常見安裝位(PATH 缺失時兜底):one-liner ~/.local/bin、npm 全局、homebrew
  const candidates = [
    join(homedir(), ".local/bin/claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    join(homedir(), ".npm-global/bin/claude"),
  ];
  for (const c of candidates) if (existsSync(c)) return (cached = c);
  return (cached = "claude"); // 全落空 → 回退裸名(讓 execFile/SDK 自行嘗試)
}

/** 是否解析到了絕對路徑(可安全傳給 SDK pathToClaudeCodeExecutable)。 */
export function claudeBinIsAbsolute(): boolean {
  return resolveClaudeBin() !== "claude";
}
