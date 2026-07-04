import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announceImportAvailable, runImport } from "../src/openclaw/history-import";

// 渠道用戶消息（帶 OpenClaw 的 metadata wrapper）
function metaUser(channelId: string, channelName: string, text: string, ts = 1): string {
  const meta = JSON.stringify({ conversation_label: `Guild ${channelName} channel id:${channelId}`, group_channel: channelName });
  const wrapped = `Conversation info (untrusted metadata):\n\`\`\`json\n${meta}\n\`\`\`\n\n${text}`;
  return JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: wrapped }], timestamp: ts } }) + "\n";
}
function asst(text: string, ts = 2): string {
  return JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], timestamp: ts } }) + "\n";
}
function cronUser(id: string): string {
  return JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `[cron:${id} 日報]` }], timestamp: 1 } }) + "\n";
}

describe("history-import（深度：全文件 + 清洗 + 合併 + 過濾）", () => {
  let sdir: string;
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "occ-imp-"));
    sdir = join(root, "agents/main/sessions");
    mkdirSync(sdir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = root;
  });
  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  const collect = async (sessions: any[] = []) => {
    const gw: any = { sessionsList: async () => ({ sessions }) };
    const sent: any[] = [];
    const linkb: any = { send: (m: any) => sent.push(m) };
    await runImport(gw, linkb);
    return sent;
  };

  it("歸檔頻道對話：清洗 wrapper + 頻道標題 + hermesSessionId 由 channel id", async () => {
    writeFileSync(join(sdir, "archA.jsonl"), metaUser("999", "#crypto", "舊問題", 1) + asst("舊答", 2));
    const sent = await collect([]); // 無活躍 → 純歸檔
    const ss = sent.filter((m) => m.t === "import_batch").flatMap((b) => b.sessions);
    expect(ss.length).toBe(1);
    expect(ss[0].hermesSessionId).toBe("agent:main:discord:channel:999");
    expect(ss[0].title).toBe("#crypto");
    expect(ss[0].source).toBe("discord");
    expect(ss[0].messages.find((m: any) => m.role === "user").text).toBe("舊問題"); // wrapper 已清
  });

  it("cron（[cron:）+ 純自動化（無用戶消息）都跳過", async () => {
    writeFileSync(join(sdir, "cron1.jsonl"), cronUser("x") + asst("cron 報告"));
    writeFileSync(join(sdir, "auto1.jsonl"), asst("只有助手"));
    expect(await collect([])).toEqual([{ t: "import_batch", sessions: [], done: true }]);
  });

  it("歸檔 + 活躍同頻道合併成一條，消息按 createdAt 排序", async () => {
    writeFileSync(join(sdir, "old.jsonl"), metaUser("999", "#crypto", "三月舊問", 1));
    writeFileSync(join(sdir, "act.jsonl"), metaUser("999", "#crypto", "現在新問", 3));
    const sent = await collect([
      { sessionId: "act", key: "agent:main:discord:channel:999", displayName: "discord:g#crypto", channel: "discord" },
    ]);
    const ss = sent.filter((m) => m.t === "import_batch").flatMap((b) => b.sessions);
    expect(ss.length).toBe(1); // 合併
    expect(ss[0].hermesSessionId).toBe("agent:main:discord:channel:999");
    expect(ss[0].messages.filter((m: any) => m.role === "user").map((m: any) => m.text)).toEqual(["三月舊問", "現在新問"]);
  });

  it("活躍 cron key 跳過", async () => {
    writeFileSync(join(sdir, "c.jsonl"), metaUser("1", "#x", "hi"));
    const sent = await collect([{ sessionId: "c", key: "agent:main:cron:abc", channel: undefined }]);
    expect(sent).toEqual([{ t: "import_batch", sessions: [], done: true }]);
  });

  it("無文件 → 空 import_batch done:true", async () => {
    expect(await collect([])).toEqual([{ t: "import_batch", sessions: [], done: true }]);
  });

  it("announceImportAvailable 計數（合併後）", async () => {
    writeFileSync(join(sdir, "a.jsonl"), metaUser("1", "#a", "hi"));
    writeFileSync(join(sdir, "b.jsonl"), metaUser("2", "#b", "yo"));
    const sent: any[] = [];
    const linkb: any = { send: (m: any) => sent.push(m) };
    await announceImportAvailable({ sessionsList: async () => ({ sessions: [] }) } as any, linkb);
    expect(sent[0]).toEqual({ t: "import_available", count: 2 });
  });
});
