/**
 * #303：共享 hermetic setup（憑證 env 清空 / TZ=UTC / HOME+TMPDIR 沙箱）。
 * 實作見 @macchiato/test-hermetic；此檔只做 vitest setupFiles 入口。
 */
import "./_hermetic/setup";
