/**
 * #303 vitest setupFiles 入口（side-effect import）。
 *
 * 三家 TS 連接器 vitest.config.ts:
 *   setupFiles: ["./_hermetic/setup"]
 * 或本地薄包裝 re-export 本模塊。
 *
 * 做的事（對齊 hermes conftest + docs/testing-strategy.md §6）:
 *   1. 按後綴清空 *_API_KEY / *_TOKEN / *_SECRET
 *   2. TZ=UTC
 *   3. HOME → 臨時沙箱（默認 ~/.macchiato / ~/.claude 路徑全部落沙箱）
 *   4. TMPDIR 沙箱（#453 tmpfs 泄漏根治）
 */
import { scrubCredentialEnv, pinTestTimeZone } from "./env";
import { installHermeticSandbox } from "./sandbox";

scrubCredentialEnv();
pinTestTimeZone();
installHermeticSandbox();
