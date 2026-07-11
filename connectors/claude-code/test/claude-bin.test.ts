import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fresh() {
  vi.resetModules();
  return await import("../src/cc/claude-bin");
}

describe("resolveClaudeBin", () => {
  beforeEach(() => {
    delete process.env.MACCHIATO_CLAUDE_BIN;
  });
  it("MACCHIATO_CLAUDE_BIN 存在時優先 + 絕對路徑標記", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, "#!/bin/sh\n"); chmodSync(bin, 0o755);
    process.env.MACCHIATO_CLAUDE_BIN = bin;
    const { resolveClaudeBin, claudeBinIsAbsolute } = await fresh();
    expect(resolveClaudeBin()).toBe(bin);
    expect(claudeBinIsAbsolute()).toBe(true);
  });
  it("PATH 缺失且候選位無 → 回退裸名 claude(不拋)", async () => {
    process.env.MACCHIATO_CLAUDE_BIN = "/nonexistent/claude";
    const old = process.env.PATH; process.env.PATH = "/nonexistent-dir-xyz";
    const { resolveClaudeBin } = await fresh();
    const r = resolveClaudeBin();
    process.env.PATH = old;
    expect(typeof r).toBe("string");
    expect(r.length).toBeGreaterThan(0);
  });
});
