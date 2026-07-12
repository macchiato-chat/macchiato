/**
 * 解析 codex CLI 可執行路徑,**不依賴進程 PATH**。
 * systemd user 服務不繼承登錄 PATH(常缺 ~/.local/bin)→ execFile("codex") 找不到 →
 * 健康探測誤報降級(CC 連接器 2026-07-08 同款教訓)。故顯式按候選位置定位。
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

let cached: string | undefined;

export function resolveCodexBin(): string {
  if (cached) return cached;
  const override = process.env.MACCHIATO_CODEX_BIN;
  if (override && existsSync(override)) return (cached = override);
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (dir && existsSync(join(dir, "codex"))) return (cached = join(dir, "codex"));
  }
  const candidates = [
    join(homedir(), ".local/bin/codex"),
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
    join(homedir(), ".npm-global/bin/codex"),
  ];
  for (const c of candidates) if (existsSync(c)) return (cached = c);
  return (cached = "codex");
}
