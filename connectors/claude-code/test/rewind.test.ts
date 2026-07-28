/**
 * #473 rewind(cc):回退走 SDK 的 `forkSession({ upToMessageId })`——原 transcript 一個字節不動,
 * 內容複製進新會話檔。連接器這層只負責兩件事:
 *  - **勘察**:`upToMessageId` 是 inclusive,所以要丟掉目標那條,傳的必須是它**前一條**的 uuid;
 *  - **認領**:fork 出的新檔水位線必須立刻坐到 EOF,否則下輪 poll 會把複製過去的整段歷史
 *    當新消息再灌一遍(這是本功能最壞的 bug)。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mirror } from "../src/cc/mirror";

const SID = "6966afc5-2dca-477d-a987-848421d25124";
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

function line(role: "user" | "assistant", text: string): { raw: string; uuid: string } {
  const id = uuid();
  const raw =
    JSON.stringify(
      role === "user"
        ? { type: "user", uuid: id, sessionId: SID, timestamp: "2026-07-28T10:00:00.000Z", message: { role, content: text } }
        : {
            type: "assistant",
            uuid: id,
            sessionId: SID,
            timestamp: "2026-07-28T10:00:01.000Z",
            message: { id: `a-${n}`, role, content: [{ type: "text", text }] },
          },
    ) + "\n";
  return { raw, uuid: id };
}

function setup(): { dir: string; file: string } {
  n = 0;
  const cfg = mkdtempSync(join(tmpdir(), "cc-rewind-"));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
  const dir = join(cfg, "projects", "-home-x");
  mkdirSync(dir, { recursive: true });
  writeFileSync(process.env.MACCHIATO_CC_MIRROR, JSON.stringify({ offsets: {}, titles: {}, seeded: true }));
  return { dir, file: join(dir, `${SID}.jsonl`) };
}

const fakeLinkb = () =>
  ({ agentLinkId: "AL1", isReady: true, send: () => {}, onFrame: () => () => {} }) as never;

type MirrorState = { state: { offsets: Record<string, number>; tombstones?: string[] } };

describe("#473 rewind(cc / forkSession)", () => {
  it("回目標**前一條**的 uuid(upToMessageId inclusive)+ 丟棄行數;原檔不動", () => {
    const { file } = setup();
    const l1 = line("user", "第一句");
    const l2 = line("assistant", "回第一句");
    const l3 = line("user", "第二句"); // ← 回退目標
    const l4 = line("assistant", "回第二句");
    const original = l1.raw + l2.raw + l3.raw + l4.raw;
    writeFileSync(file, original);

    const m = new Mirror(fakeLinkb());
    expect(m.rewindPlan(SID, l3.uuid)).toEqual({ keepUpToUuid: l2.uuid, dropped: 2 });
    // 勘察是純只讀:改檔案是舊做法,現在原會話就是存檔
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("目標是首行 → keepUpToUuid=null(沒東西可保留,調用方改開新會話而不是 fork)", () => {
    const { file } = setup();
    const l1 = line("user", "唯一一句");
    const l2 = line("assistant", "回它");
    writeFileSync(file, l1.raw + l2.raw);
    const m = new Mirror(fakeLinkb());
    expect(m.rewindPlan(SID, l1.uuid)).toEqual({ keepUpToUuid: null, dropped: 2 });
  });

  it("目標 uuid 不在檔裡 → null", () => {
    const { file } = setup();
    writeFileSync(file, line("user", "保持原樣").raw);
    const m = new Mirror(fakeLinkb());
    expect(m.rewindPlan(SID, "00000000-0000-4000-8000-999999999999")).toBeNull();
  });

  it("adoptForked:新檔登記 driven + 水位直接坐到 EOF(否則整段歷史會被重灌一遍)", () => {
    const { dir } = setup();
    const forked = "11111111-2222-4333-8444-555555555555";
    const copied = line("user", "被複製過去的歷史").raw + line("assistant", "也被複製").raw;
    writeFileSync(join(dir, `${forked}.jsonl`), copied);

    const m = new Mirror(fakeLinkb());
    expect(m.adoptForked(forked)).toBe(true);
    expect((m as unknown as MirrorState).state.offsets[forked]).toBe(Buffer.byteLength(copied, "utf8"));

    // 水位已在 EOF → 一輪 poll 不會把複製過去的歷史當新消息發出去
    const sent: Record<string, unknown>[] = [];
    const m2 = new Mirror({
      agentLinkId: "AL1",
      isReady: true,
      send: (f: Record<string, unknown>) => sent.push(f),
      onFrame: () => () => {},
    } as never);
    (m2 as unknown as { doPoll: () => void }).doPoll();
    expect(sent.filter((f) => f.t === "mirror_append")).toHaveLength(0);
  });

  it("檔還沒落盤也不炸:水位記 0,driven 守衛仍然擋住明文落地", () => {
    setup();
    const m = new Mirror(fakeLinkb());
    expect(m.adoptForked("99999999-8888-4777-8666-555555555555")).toBe(true);
    expect((m as unknown as MirrorState).state.offsets["99999999-8888-4777-8666-555555555555"]).toBe(0);
  });
});
