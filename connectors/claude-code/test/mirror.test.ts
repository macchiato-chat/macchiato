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

describe("Mirror", () => {
  let file: string;

  /** 每測一套隔離環境:projectsDir()=$CLAUDE_CONFIG_DIR/projects、獨立水位線 state。 */
  function setupEnv(): void {
    const cfg = mkdtempSync(join(tmpdir(), "cc-cfg-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    mkdirSync(join(cfg, "projects", "-home-x"), { recursive: true });
    file = join(cfg, "projects", "-home-x", `${SID}.jsonl`);
  }

  beforeEach(() => {
    n = 0;
  });

  it("未知會話從 0 全量鏡像歷史(不再 baseline 跳過);之後增量(帶 srcId)", () => {
    setupEnv();
    writeFileSync(file, userLine("old history") + userLine("second"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();
    // 全量:歷史消息都發出來(不再只發標題)
    const all = sent.frames.flatMap((f: any) => f.sessions[0].messages);
    expect(all.map((x: any) => x.text)).toEqual(["old history", "second"]);
    expect(all[0].srcId).toMatch(/^0{8}-/);
    expect((sent.frames[0] as any).sessions[0].source).toBe("claude-code");
    // 增量:新消息
    appendFileSync(file, userLine("new message"));
    (m as any).doPoll();
    const last = (sent.frames.at(-1) as any).sessions[0];
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
    expect(sent.frames.length).toBe(3);
    for (const f of sent.frames) expect((f as any).sessions).toHaveLength(1);
    const total = sent.frames.flatMap((f: any) => f.sessions[0].messages);
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
    const batchId = (sent.frames.at(-1) as any).batchId;
    m.handleNack(batchId);
    (m as any).doPoll();
    const last = (sent.frames.at(-1) as any).sessions[0];
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
    const batches = sent.frames.filter((f: any) => f.sessions?.[0]?.messages?.length > 0);
    expect(batches).toHaveLength(0);
  });

  it("連接器啟動後新建的會話 → 從 0 全量鏡像(claude -p 短會話不丟)", async () => {
    setupEnv();
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll(); // 啟動時 projects 尚無此會話
    await new Promise((r) => setTimeout(r, 5)); // 確保 birthtime > startedAt
    writeFileSync(file, userLine("fresh q") + userLine("follow"));
    (m as any).doPoll();
    const batch = (sent.frames.at(-1) as any)?.sessions?.[0];
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
    expect(sent.frames.filter((f: any) => f.sessions?.[0]?.messages?.length > 0)).toHaveLength(0);
    // 用戶真在該會話說話 → 全量鏡像(含此前的 agent 消息)
    appendFileSync(file, userLine("real human"));
    (m as any).doPoll();
    const batch = (sent.frames.at(-1) as any)?.sessions?.[0];
    expect(batch?.messages?.map((x: any) => x.text)).toEqual(["task output", "real human"]);
  });

  it("標題變更(custom-title 流過)→ 補發純標題批", () => {
    setupEnv();
    writeFileSync(file, userLine("q"));
    const { linkb, sent } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll(); // baseline
    appendFileSync(file, JSON.stringify({ type: "custom-title", customTitle: "Renamed", sessionId: SID }) + "\n");
    (m as any).doPoll();
    const last = (sent.frames.at(-1) as any).sessions[0];
    expect(last.title).toBe("Renamed");
  });
});
