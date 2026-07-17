import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mirror, MACCHIATO_PREFIX } from "../src/openclaw/mirror";

/**
 * #147:driven 會話的 tool/thinking 塊此前被快進永久跳過(live 只投文字)→ 記錄保真缺失。
 * 打撈 = 去正文的 tool/thinking 消息補進歷史;純文字不重發(防雙投)。
 */

const SID = "01OCTESTSID00000000000000A";
const KEY = (MACCHIATO_PREFIX + SID).toLowerCase();
const FILE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const line = (o: any) => JSON.stringify(o) + "\n";
const textMsg = (text: string, ts: number) =>
  line({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], timestamp: ts } });
const toolMsg = (text: string, ts: number) =>
  line({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "想一想" },
        { type: "text", text },
        { type: "toolCall", id: "t1", name: "exec", arguments: { cmd: "ls" } },
      ],
      timestamp: ts,
    },
  }) +
  line({
    type: "message",
    message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "file1\nfile2" }], timestamp: ts + 1 },
  });

function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), "oc-sv-"));
  process.env.MACCHIATO_OPENCLAW_MIRROR = join(stateDir, "mirror.json");
  process.env.OPENCLAW_STATE_DIR = join(stateDir, "openclaw");
  const dir = join(stateDir, "openclaw", "agents/main/sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${FILE_ID}.jsonl`);
  const sent: any[] = [];
  const linkb: any = { agentLinkId: "al1", isReady: true, send: (m: any) => sent.push(m), onFrame: () => () => {} };
  const gw: any = {
    sessionsList: async () => ({ sessions: [{ key: KEY, sessionId: FILE_ID, displayName: "x", channel: "macchiato" }] }),
  };
  const mirror = new Mirror(gw, linkb);
  mirror.setDriven(KEY, SID);
  return { mirror, file, sent };
}

const appends = (sent: any[]) => sent.filter((f) => f.t === "mirror_append").flatMap((f) => f.sessions);

describe("#147 driven 會話 tool/thinking 打撈", () => {
  it("帶 tool/thinking 的 agent 消息 → 去正文補投(hermesSessionId=真大小寫 sid);純文字不發;冪等", async () => {
    const { mirror, file, sent } = setup();
    writeFileSync(file, textMsg("純文字回覆", 1000) + toolMsg("帶工具的回覆", 2000));
    await (mirror as any).pollOnce();
    const entries = appends(sent);
    expect(entries).toHaveLength(1);
    expect(entries[0].hermesSessionId).toBe(SID); // 真大小寫(sidForKey 會丟大小寫)
    const msgs = entries[0].messages;
    expect(msgs).toHaveLength(1); // 純文字那條不發(live 已投)
    expect(msgs[0].text).toBe(""); // 正文去掉(防雙投)
    expect(msgs[0].reasoning).toBe("想一想");
    expect(msgs[0].tools[0]).toMatchObject({ name: "exec", state: "ok", output: "file1\nfile2" });
    expect(msgs[0].srcId).toBeTruthy();
    // 冪等:水位線已推,再 poll 不重發
    await (mirror as any).pollOnce();
    expect(appends(sent)).toHaveLength(1);
  });

  it("fastForward(回合末主動打撈)同樣補投 tool 塊並推水位線", async () => {
    const { mirror, file, sent } = setup();
    writeFileSync(file, "");
    await (mirror as any).pollOnce(); // macchiato-prefix 基線 0
    appendFileSync(file, toolMsg("回覆", 3000));
    mirror.fastForward(KEY);
    await new Promise((r) => setTimeout(r, 30));
    const entries = appends(sent);
    expect(entries).toHaveLength(1);
    expect(entries[0].messages[0].tools[0].name).toBe("exec");
    // 隨後 poll 不重發
    await (mirror as any).pollOnce();
    expect(appends(sent)).toHaveLength(1);
  });

  it("#252 Link B 未 ready → salvageToEnd 整體跳過:不推水位線,ready 後 pollOnce 補得回", async () => {
    const { mirror, file, sent } = setup();
    const linkb = (mirror as any).linkb;
    writeFileSync(file, "");
    await (mirror as any).pollOnce(); // 基線 0
    appendFileSync(file, toolMsg("斷線期回覆", 3000));
    linkb.isReady = false; // Link B 斷
    mirror.fastForward(KEY);
    await new Promise((r) => setTimeout(r, 30));
    expect(appends(sent)).toHaveLength(0); // 沒 ready:不發、不推水位線
    // ready 後照樣打撈得到(水位線沒被白推過)
    linkb.isReady = true;
    await (mirror as any).pollOnce();
    const entries = appends(sent);
    expect(entries).toHaveLength(1);
    expect(entries[0].messages[0].tools[0].name).toBe("exec");
  });

  it("macchiato-native 新會話基線 0(首回合工具不丟);非 macchiato 頻道 driven key 首見基線到文件末", async () => {
    const { mirror, file, sent } = setup();
    // macchiato key:文件已有內容,首見從 0 打撈 → 首回合的 tools 撈得到
    writeFileSync(file, toolMsg("首回合", 500));
    await (mirror as any).pollOnce();
    expect(appends(sent)).toHaveLength(1);
    // 頻道 driven key(非 macchiato 前綴):首見只基線,不回挖舊歷史
    const chanKey = "agent:main:discord:channel:99";
    const chanFile = join(file, "..", "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl");
    writeFileSync(chanFile, toolMsg("舊歷史", 100));
    (mirror as any).gw.sessionsList = async () => ({
      sessions: [{ key: chanKey, sessionId: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", displayName: "x", channel: "discord" }],
    });
    mirror.setDriven(chanKey, chanKey);
    await (mirror as any).pollOnce(); // 首見 → 基線到末,不發
    expect(appends(sent)).toHaveLength(1);
    appendFileSync(chanFile, toolMsg("新回合", 4000));
    await (mirror as any).pollOnce(); // 基線之後的新 tools 照撈
    expect(appends(sent)).toHaveLength(2);
  });
});

describe("#161 墓碑", () => {
  it("tombstone 後 poll 永不再撈(打撈同跳);持久跨實例", async () => {
    const { mirror, file, sent } = setup();
    writeFileSync(file, textMsg("正常", 1000) + toolMsg("帶工具", 2000));
    await (mirror as any).pollOnce();
    const before = appends(sent).length;
    mirror.tombstone(KEY);
    appendFileSync(file, toolMsg("刪後新內容", 3000));
    await (mirror as any).pollOnce();
    expect(appends(sent).length).toBe(before); // 不再撈
  });
});
