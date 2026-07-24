import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announceImportAvailable, runImport } from "../src/cc/history-import";

/**
 * 隱私不變量:**本機既有 CC 對話內容,只有用戶顯式點「導入」才會離開這台機器。**
 *
 * 連接器裝上就能看到用戶滿硬盤的 Claude Code 歷史(本機實測 877 個 transcript / 18 個 project)。
 * 把它們不請自來地灌進 Macchiato 是嚴重的隱私事故,故有兩道閘:
 *  1. #154 鏡像首掃**基線到文件末**——既有歷史不自動鏡像(該閘由 mirror.test.ts「#154 首掃基線」守)。
 *  2. 本文件守第二道:`announceImportAvailable` 只上報**計數**供 app 顯示入口;真正的正文只在
 *     用戶點下導入、server 下發 `import_start` → `runImport` 時才發。
 *
 * 這兩個函數在 index.ts 裡貼得很近(啟動即 announce;import_start 才 runImport),重構時把
 * announce 誤寫成 runImport = 靜默全量上傳且沒人會發現。故用**阳性對照**測法:先證明「內容一旦
 * 洩漏本測一定抓得到」(runImport 對照組),再斷言 announce 路徑上不存在。
 *
 * 相關:#374(歷史鏡像與全量導入必須分開徵得明確同意,p1 開著)。
 */

const SID = "6966afc5-2dca-477d-a987-848421d25199";
/** 全局唯一的哨兵串:出現在任何出站幀裡 = 對話正文洩漏。 */
const SECRET = "SENTINEL-用戶私密對話內容-DO-NOT-LEAK";

type Sent = { frames: Record<string, unknown>[] };

function fakeLinkb(): { linkb: any; sent: Sent } {
  const sent: Sent = { frames: [] };
  return {
    linkb: {
      agentLinkId: "AL1",
      isReady: true,
      send: (m: Record<string, unknown>) => sent.frames.push(m),
      onFrame: () => () => {},
    },
    sent,
  };
}

const noE2E = { isE2E: () => false } as any;

describe("隱私:本機既有 CC 歷史不會不請自來地上傳", () => {
  let cfg: string;
  let prevCfg: string | undefined;

  beforeEach(() => {
    cfg = mkdtempSync(join(tmpdir(), "cc-privacy-"));
    prevCfg = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    const dir = join(cfg, "projects", "-opt-secret-proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${SID}.jsonl`),
      JSON.stringify({
        type: "user",
        uuid: "00000000-0000-4000-8000-000000000001",
        cwd: "/opt/secret-proj",
        timestamp: "2026-07-24T00:00:00Z",
        message: { role: "user", content: SECRET },
      }) + "\n",
    );
  });

  afterEach(() => {
    rmSync(cfg, { recursive: true, force: true });
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevCfg;
  });

  it("阳性對照:顯式 runImport(用戶點了導入)時,正文確實會出站——證明本測抓得到洩漏", () => {
    const { linkb, sent } = fakeLinkb();
    runImport(linkb, noE2E);
    expect(JSON.stringify(sent.frames)).toContain(SECRET);
  });

  it("announceImportAvailable 只上報計數與 project 名,幀裡**沒有任何對話正文**", () => {
    const { linkb, sent } = fakeLinkb();
    announceImportAvailable(linkb, noE2E);
    expect(JSON.stringify(sent.frames)).not.toContain(SECRET);
    expect(sent.frames).toEqual([
      { t: "import_available", count: 1, projects: [{ name: "/opt/secret-proj", count: 1 }] },
    ]);
  });

  it("announce 不產生 import_batch——正文只走顯式 import_start 觸發的那條路", () => {
    const { linkb, sent } = fakeLinkb();
    announceImportAvailable(linkb, noE2E);
    expect(sent.frames.filter((f) => f.t === "import_batch")).toHaveLength(0);
  });
});
