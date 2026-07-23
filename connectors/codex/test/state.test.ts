import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDriveState, saveDriveState, mapPath } from "../src/codex/state";

describe("#248 codex drive state .bak 韌性", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cx-state-"));
    process.env.MACCHIATO_CODEX_SESSIONS = join(dir, "codex-sessions.json");
  });
  afterEach(() => {
    delete process.env.MACCHIATO_CODEX_SESSIONS;
    rmSync(dir, { recursive: true, force: true });
  });

  const st = (map: Record<string, string>) => ({
    map,
    cwds: {},
    models: {},
    efforts: {},
    perms: {},
    titled: new Set<string>(),
    pending: [] as string[],
  });

  it("主檔損壞 → 從 .bak 恢復(sid↔thread 映射不蒸發)", () => {
    saveDriveState(st({ s1: "t1" })); // 首存
    saveDriveState(st({ s1: "t1", s2: "t2" })); // 二存 → main/.bak 都是當前完整身份代
    writeFileSync(mapPath(), "{壞了"); // 主檔損壞
    const recovered = loadDriveState();
    expect(recovered.map).toEqual({ s1: "t1", s2: "t2" });
    expect(recovered.identityStateTrusted).toBe(false); // fallback 仍不證明主檔 crash 前沒有更晚一代
  });

  it("兩檔都無 → 空狀態(全新安裝)", () => {
    expect(loadDriveState()).toMatchObject({ map: {}, identityStateTrusted: false });
  });
});
