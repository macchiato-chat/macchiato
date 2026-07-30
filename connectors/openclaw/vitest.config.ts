import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    // #555 lifecycle end 等 chat final 的 grace 窗:生產 3s(上游把 end 排在尾段 delta/final
    // 之前),單測縮到 5ms——「end 無 final → 兜底定稿」的斷言仍在,只是不必真等 3 秒。
    env: { MACCHIATO_OPENCLAW_END_GRACE_MS: "5" },
  },
});
