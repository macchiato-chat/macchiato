/**
 * F-13 / #490 → #473:能力誠實的兩面。
 * 原測試斷言「codex 無 rewind → hello 絕不宣告」,依據是「底層沒有截斷上下文 API」——
 * 那個前提被 #473 推翻:app-server 有 `thread/fork` + `lastTurnId`(inclusive 保留),
 * 正是回合粒度的回退。誠實原則不變,方向翻轉:
 *  - **app-server 引擎**:能力在 → 宣告(index.ts 於引擎握手成功後設 declareRewind);
 *  - **exec v1 回退**:沒有 fork API → 缺省不宣告——server 409、UI 不出入口,
 *    而不是下達後 30s 超時。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 「缺省不宣告 / 開了才宣告」的注入邏輯由 connector-core 的 test/hello-caps.test.ts 抓真實
// hello 幀斷言(#633);這裡只管本家接線——唯一開啟點必須在 app-server 握手成功之後。
describe("#473 hello rewind cap(codex,引擎級)", () => {
  it("只有 app-server 引擎分支開宣告(exec 強制/探活回退兩條路都不開)", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const marks = [...src.matchAll(/linkb\.declareRewind = true/g)];
    expect(marks).toHaveLength(1);
    // 唯一開啟點必須在 app-server 握手成功之後(appClient.start() 之後的成功分支)
    const at = src.indexOf("linkb.declareRewind = true");
    const appStart = src.indexOf("await appClient.start()");
    expect(appStart).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(appStart);
  });

  it("app-server drive 有 session.rewind handler;exec drive 沒有(它不宣告,不該有死代碼)", () => {
    const appserver = readFileSync(new URL("../src/codex/drive-appserver.ts", import.meta.url), "utf8");
    expect(appserver).toContain('case "session.rewind"');
    const execSrc = readFileSync(new URL("../src/codex/drive.ts", import.meta.url), "utf8");
    const codeLines = execSrc.split("\n").map((l) => l.replace(/\/\/.*$/, ""));
    expect(codeLines.some((l) => l.includes("session.rewind"))).toBe(false);
  });
});
