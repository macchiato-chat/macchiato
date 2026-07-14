import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mirror } from "../src/cc/mirror";

let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const SID = "6966afc5-2dca-477d-a987-848421d25124";

function userLine(text: string): string {
  return (
    JSON.stringify({
      type: "user",
      uuid: uuid(),
      sessionId: SID,
      timestamp: "2026-07-05T10:00:00.000Z",
      message: { role: "user", content: text },
    }) + "\n"
  );
}

function assistantLine(text: string): string {
  return (
    JSON.stringify({
      type: "assistant",
      uuid: uuid(),
      sessionId: SID,
      timestamp: "2026-07-05T10:00:01.000Z",
      message: { id: `a-${n}`, role: "assistant", content: [{ type: "text", text }] },
    }) + "\n"
  );
}

interface Sent {
  frames: Record<string, unknown>[];
}

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

/** 只看鏡像內容幀(#56 起 poll 還會發 mirror_activity,別讓幀序斷言被打亂)。 */
const appends = (sent: Sent) => sent.frames.filter((f: any) => f.t === "mirror_append");

describe("Mirror", () => {
  let file: string;

  /** 每測一套隔離環境:projectsDir()=$CLAUDE_CONFIG_DIR/projects、獨立水位線 state。 */
  function setupEnv(): void {
    const cfg = mkdtempSync(join(tmpdir(), "cc-cfg-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    mkdirSync(join(cfg, "projects", "-home-x"), { recursive: true });
    file = join(cfg, "projects", "-home-x", `${SID}.jsonl`);
    // #154 預置已 seeded 的狀態:本套件測的是「首掃之後」的常態語義(新會話 from-zero 全量);
    // 首掃基線本身見「#154 首掃基線」測試。
    writeFileSync(process.env.MACCHIATO_CC_MIRROR!, JSON.stringify({ offsets: {}, titles: {}, seeded: true }));
  }

  beforeEach(() => {
    n = 0;
  });

  it("seeded 後新發現的會話從 0 全量鏡像;之後增量(帶 srcId)", () => {
    setupEnv();
    writeFileSync(file, userLine("old history") + userLine("second"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();
    // 全量:歷史消息都發出來(不再只發標題)
    const all = appends(sent).flatMap((f: any) => f.sessions[0].messages);
    expect(all.map((x: any) => x.text)).toEqual(["old history", "second"]);
    expect(all[0].srcId).toMatch(/^0{8}-/);
    expect((appends(sent)[0] as any).sessions[0].source).toBe("claude-code");
    // 增量:新消息
    appendFileSync(file, userLine("new message"));
    (m as any).doPoll();
    const last = (appends(sent).at(-1) as any).sessions[0];
    expect(last.messages.map((x: any) => x.text)).toEqual(["new message"]);
  });

  it("大會話分批發:每帧單會話 ≤ BATCH_MAX 條", () => {
    setupEnv();
    process.env.MACCHIATO_CC_BATCH_MAX = "10";
    let body = "";
    for (let i = 0; i < 25; i++) body += userLine(`m${i}`);
    writeFileSync(file, body);
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();
    delete process.env.MACCHIATO_CC_BATCH_MAX;
    // 25 條 / 10 每批 → 3 帧,每帧單會話
    expect(appends(sent).length).toBe(3);
    for (const f of appends(sent)) expect((f as any).sessions).toHaveLength(1);
    const total = appends(sent).flatMap((f: any) => f.sessions[0].messages);
    expect(total).toHaveLength(25);
    expect(total.map((x: any) => x.text)).toEqual(Array.from({ length: 25 }, (_, i) => `m${i}`));
  });

  it("mirror_nack 回退水位線 → 重發同批", () => {
    setupEnv();
    writeFileSync(file, "");
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll(); // baseline(空文件無標題,無批)
    appendFileSync(file, userLine("msg1"));
    (m as any).doPoll();
    const batchId = (appends(sent).at(-1) as any).batchId;
    m.handleNack(batchId);
    (m as any).doPoll();
    const last = (appends(sent).at(-1) as any).sessions[0];
    expect(last.messages[0].text).toBe("msg1"); // 重發
  });

  it("driven 會話只快進不投遞", () => {
    setupEnv();
    writeFileSync(file, "");
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();
    m.setDriven(SID);
    appendFileSync(file, userLine("driven content"));
    (m as any).doPoll();
    // 無新批(僅 baseline 可能發過 0 條)
    const batches = appends(sent).filter((f: any) => f.sessions?.[0]?.messages?.length > 0);
    expect(batches).toHaveLength(0);
  });

  it("driven 回合末殘片(fastForward 後才落盤的 assistant)→ 不生成影子會話;真人續問才恢復", () => {
    setupEnv();
    writeFileSync(file, "");
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll(); // baseline 空文件
    // 驅動回合:live 路徑在 ULID 下投遞 user+assistant,鏡像側只快進
    m.setDriven(SID);
    appendFileSync(file, userLine("為什麼重啟") + assistantLine("因為觸發了硬體看門狗"));
    (m as any).doPoll(); // driven → 快進水位線,不投
    // 回合末:fastForward 越過本回合 + 解除 driven
    m.fastForward(SID);
    m.unsetDriven(SID);
    // 競態:最終 assistant 塊在 fastForward 之後才落盤(殘片,無 user 行)
    appendFileSync(file, assistantLine("(補齊的收尾)"));
    (m as any).doPoll();
    // 不得憑空建一個只有 agent 消息的影子會話
    const ghost = appends(sent).filter((f: any) => f.sessions?.[0]?.messages?.length > 0);
    expect(ghost).toHaveLength(0);
    // 但用戶真在終端續這個會話(新 user 回合)→ 鏡像恢復、建會話
    appendFileSync(file, userLine("那怎麼修"));
    (m as any).doPoll();
    const resumed = appends(sent).filter((f: any) =>
      f.sessions?.[0]?.messages?.some((x: any) => x.text === "那怎麼修"),
    );
    expect(resumed.length).toBeGreaterThan(0);
  });

  it("driven 回合末標題寫回(custom-title,零消息)→ 不生成影子會話;真人續問才建", () => {
    setupEnv();
    writeFileSync(file, "");
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll(); // baseline 空
    m.setDriven(SID);
    appendFileSync(file, userLine("為什麼重啟") + assistantLine("因為看門狗"));
    (m as any).doPoll(); // driven → 快進,不投
    m.fastForward(SID);
    m.unsetDriven(SID);
    // 回合末:CC 把生成的標題寫回 transcript(custom-title 行,零消息)——舊守衛(要 messages.length)
    // 會讓它繞過、走 newTitle 分支憑空建會話(2026-07-13 實測復發的洞)。
    appendFileSync(file, JSON.stringify({ type: "custom-title", customTitle: "P4改為拍手", sessionId: SID }) + "\n");
    (m as any).doPoll();
    expect(appends(sent)).toHaveLength(0); // 連 title-only 批都不能建會話
    // 再落一塊 assistant 殘片,同樣不建
    appendFileSync(file, assistantLine("(補齊收尾)"));
    (m as any).doPoll();
    expect(appends(sent)).toHaveLength(0);
    // 但用戶真在終端續這個會話 → 恢復鏡像(帶上寫回的標題)
    appendFileSync(file, userLine("那怎麼修"));
    (m as any).doPoll();
    const batch = (appends(sent).at(-1) as any)?.sessions?.[0];
    expect(batch?.messages?.some((x: any) => x.text === "那怎麼修")).toBe(true);
    expect(batch?.title).toBe("P4改為拍手"); // 寫回的標題被保留
  });

  it("第二道守衛:driven 過的 CLI 會話,即便有 user 續問也不單獨建鏡像會話;兜底計數恆 0", () => {
    setupEnv();
    writeFileSync(file, "");
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    m.markDrivenUuid(SID); // 標記:此 CLI uuid 被 Macchiato 驅動過
    (m as any).doPoll();
    // 終端裡真人續問(有 user)——但因為是 driven 過的 uuid,鏡像永不單獨建會話
    writeFileSync(file, userLine("終端續問") + assistantLine("回覆"));
    (m as any).doPoll();
    expect(appends(sent)).toHaveLength(0);
    expect(m.counters.mirrorGhostBlocked).toBe(0); // 主守衛悄悄攔在 emit 前,絆線不觸發
  });

  it("連接器啟動後新建的會話 → 從 0 全量鏡像(claude -p 短會話不丟)", async () => {
    setupEnv();
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll(); // 啟動時 projects 尚無此會話
    await new Promise((r) => setTimeout(r, 5)); // 確保 birthtime > startedAt
    writeFileSync(file, userLine("fresh q") + userLine("follow"));
    (m as any).doPoll();
    const batch = (appends(sent).at(-1) as any)?.sessions?.[0];
    expect(batch?.messages).toHaveLength(2); // 全文都在,沒被 baseline 吃掉
    expect(batch.messages[0].text).toBe("fresh q");
    expect(batch.title).toBe("fresh q"); // 無 custom-title 時用首條 user 當標題
  });

  it("內部 fork 檔(subagent/後台任務,無真人消息)→ 跳過;後來出現 user → 全量恢復鏡像", () => {
    setupEnv();
    // fork 檔:只有 assistant 消息(後台任務的 bash 調用),無任何 user 行
    const agentLine =
      JSON.stringify({
        type: "assistant",
        uuid: uuid(),
        sessionId: SID,
        timestamp: "2026-07-11T02:27:00.000Z",
        message: { id: "a1", role: "assistant", content: [{ type: "text", text: "task output" }] },
      }) + "\n";
    writeFileSync(file, agentLine);
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();
    (m as any).doPoll(); // 第二輪:檔沒長,不重讀也不發
    expect(appends(sent).filter((f: any) => f.sessions?.[0]?.messages?.length > 0)).toHaveLength(0);
    // 用戶真在該會話說話 → 全量鏡像(含此前的 agent 消息)
    appendFileSync(file, userLine("real human"));
    (m as any).doPoll();
    const batch = (appends(sent).at(-1) as any)?.sessions?.[0];
    expect(batch?.messages?.map((x: any) => x.text)).toEqual(["task output", "real human"]);
  });

  it("#161 墓碑:app 刪過的會話,鏡像永不再撈(即使有新內容);transcript 不動", () => {
    setupEnv();
    writeFileSync(file, userLine("正常內容"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();
    expect(appends(sent).length).toBeGreaterThan(0); // 先正常鏡像
    const before = appends(sent).length;
    m.tombstone(SID);
    appendFileSync(file, userLine("刪除後的新內容"));
    (m as any).doPoll();
    expect(appends(sent).length).toBe(before); // 墓碑後不再撈
    // 持久:新 Mirror 實例(同狀態文件)照樣跳過
    const { linkb: lb2, sent: s2 } = fakeLinkb();
    const m2 = new Mirror(lb2);
    (m2 as any).doPoll();
    expect(appends(s2)).toHaveLength(0);
  });

  it("標題變更(custom-title 流過)→ 補發純標題批", () => {
    setupEnv();
    writeFileSync(file, userLine("q"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll(); // baseline
    appendFileSync(file, JSON.stringify({ type: "custom-title", customTitle: "Renamed", sessionId: SID }) + "\n");
    (m as any).doPoll();
    const last = (appends(sent).at(-1) as any).sessions[0];
    expect(last.title).toBe("Renamed");
  });
});

// ---- #56 二期:鏡像側工作態(mirror_activity) ----

function inflightToolLine(): string {
  return (
    JSON.stringify({
      type: "assistant",
      uuid: uuid(),
      sessionId: SID,
      timestamp: new Date().toISOString(),
      message: {
        id: "m-inflight",
        role: "assistant",
        content: [{ type: "tool_use", id: "t-if", name: "Bash", input: { command: "sleep 999" } }],
        stop_reason: "tool_use",
      },
    }) + "\n"
  );
}

describe("Mirror #56 mirror_activity", () => {
  let file = "";
  function setup(): { linkb: any; sent: Sent; m: Mirror } {
    const cfg = mkdtempSync(join(tmpdir(), "cc-act-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    mkdirSync(join(cfg, "projects", "-home-x"), { recursive: true });
    file = join(cfg, "projects", "-home-x", `${SID}.jsonl`);
    // #154 預置 seeded:activity 測的是「已建會話」的工作態;首掃基線的會話 server 側不存在,
    // 對其不發 busy 是新語義下的正確行為(守衛本就攔「未建會話」)。
    writeFileSync(process.env.MACCHIATO_CC_MIRROR!, JSON.stringify({ offsets: {}, titles: {}, seeded: true }));
    writeFileSync(file, userLine("hi"));
    const { linkb, sent } = fakeLinkb();
    return { linkb, sent, m: new Mirror(linkb) };
  }
  const acts = (sent: Sent) =>
    sent.frames.filter((f: any) => f.t === "mirror_activity").flatMap((f: any) => f.sessions as any[]);

  it("增長 → busy;連續 2 輪安靜 → idle(防抖);首見不算增長", () => {
    const { sent, m } = setup();
    (m as any).doPoll(); // 首見:全量鏡像但 prevSize 未知 → 不亮
    expect(acts(sent)).toEqual([]);
    appendFileSync(file, userLine("user speaks"));
    (m as any).doPoll(); // 增長 → busy
    expect(acts(sent)).toEqual([{ hermesSessionId: SID, busy: true }]);
    (m as any).doPoll(); // 安靜第 1 輪:防抖,不動
    expect(acts(sent)).toHaveLength(1);
    (m as any).doPoll(); // 安靜第 2 輪 → idle
    expect(acts(sent)).toEqual([
      { hermesSessionId: SID, busy: true },
      { hermesSessionId: SID, busy: false },
    ]);
  });

  it("尾部工具未結算(in-flight)且 90s 內有增長 → 每輪重申 busy", () => {
    const { sent, m } = setup();
    (m as any).doPoll();
    appendFileSync(file, inflightToolLine());
    (m as any).doPoll(); // 增長 → busy
    (m as any).doPoll(); // 無增長但 in-flight 且 90s 內 → 重申 busy
    expect(acts(sent)).toEqual([
      { hermesSessionId: SID, busy: true },
      { hermesSessionId: SID, busy: true },
    ]);
  });
});

describe("#6/#9 狀態文件兜底與裁剪", () => {
  it("#6 主文件損壞 → 從 .bak 恢復;#9 prune 消失超期才裁", () => {
    const d = mkdtempSync(join(tmpdir(), "cc-state-"));
    process.env.MACCHIATO_CC_MIRROR = join(d, "mirror.json");
    const linkb: any = { agentLinkId: "AL", isReady: true, send: () => {}, onFrame: () => () => {} };
    const m1: any = new Mirror(linkb);
    m1.state = { offsets: { a: 9 }, titles: { a: "t" }, missingAt: {} };
    m1.save();
    m1.state = { offsets: { a: 12 }, titles: { a: "t" }, missingAt: {} };
    m1.save(); // 上一版落 .bak
    writeFileSync(join(d, "mirror.json"), "{corrupted");
    const m2: any = new Mirror(linkb);
    expect(m2.state.offsets.a).toBe(9); // #6:.bak 恢復,不重置

    // #9:prune
    m2.state = {
      offsets: { live: 1, gone_old: 2, gone_new: 3 },
      titles: { live: "L", gone_old: "G" },
      missingAt: { gone_old: Date.now() - 8 * 24 * 3600 * 1000 },
    };
    m2.prune(new Set(["live"]), Date.now());
    expect(Object.keys(m2.state.offsets).sort()).toEqual(["gone_new", "live"]);
    expect(m2.state.titles.gone_old).toBeUndefined(); // titles 同步清
    m2.prune(new Set(["live", "gone_new"]), Date.now()); // 回歸即清 missingAt
    expect(m2.state.missingAt.gone_new).toBeUndefined();
  });
});

describe("#154 首掃基線(fresh install)", () => {
  it("無狀態文件的首掃:既有 transcript 基線到末、不自動灌;首掃後新增內容照常鏡像;新會話 from-zero", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cc-cfg-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    mkdirSync(join(cfg, "projects", "-home-x"), { recursive: true });
    const oldFile = join(cfg, "projects", "-home-x", `${SID}.jsonl`);
    writeFileSync(oldFile, userLine("多年舊歷史") + assistantLine("舊回覆"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll(); // 首掃
    expect(appends(sent)).toHaveLength(0); // 不請自來的歷史灌入沒有了(改走導入提示)
    // 首掃後該會話繼續長 → 增量照鏡(從基線起)
    appendFileSync(oldFile, userLine("新消息"));
    (m as any).doPoll();
    const inc = appends(sent).flatMap((f: any) => f.sessions[0].messages);
    expect(inc.map((x: any) => x.text)).toEqual(["新消息"]);
    // 首掃後新建的會話 → from-zero 全量(終端新會話實時可見不變)
    const sid2 = "7777afc5-2dca-477d-a987-848421d25124";
    writeFileSync(join(cfg, "projects", "-home-x", `${sid2}.jsonl`), userLine("新會話首條").replace(new RegExp(SID, "g"), sid2));
    (m as any).doPoll();
    const all2 = appends(sent).flatMap((f: any) => f.sessions).filter((x: any) => x.hermesSessionId === sid2);
    expect(all2[0]!.messages.map((x: any) => x.text)).toEqual(["新會話首條"]);
    // 重啟(新 Mirror 載同一狀態)→ seeded 持久,不會把舊歷史又基線一遍後漏鏡
    const m2 = new Mirror(linkb);
    expect(((m2 as any).state as any).seeded).toBe(true);
  });
});
