import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanUserText,
  deriveSource,
  deriveTitle,
  extractChannelMeta,
  isCronSession,
  lineToMessage,
  readNewMessages,
} from "../src/openclaw/mirror";

describe("mirror cleanUserText / extractChannelMeta（去 OpenClaw metadata wrapper）", () => {
  const wrapped =
    'Conversation info (untrusted metadata):\n```json\n{"group_channel":"#crypto","conversation_label":"Guild #crypto channel id:123"}\n```\n\n真實內容';
  it("剝離 wrapper 取正文；普通消息原樣", () => {
    expect(cleanUserText(wrapped)).toBe("真實內容");
    expect(cleanUserText("普通消息")).toBe("普通消息");
  });
  it("提取頻道 id + 名", () => {
    expect(extractChannelMeta(wrapped)).toEqual({ channelId: "123", channelName: "#crypto" });
    expect(extractChannelMeta("普通")).toEqual({});
  });
  it("Sender 等其它標籤變體也剝離", () => {
    const sender = 'Sender (untrusted metadata):\n```json\n{"group_channel":"#search"}\n```\n\n搜一下';
    expect(cleanUserText(sender)).toBe("搜一下");
    expect(extractChannelMeta(sender).channelName).toBe("#search");
  });
});

describe("mirror isCronSession", () => {
  it("key 含 :cron: → true，其餘 false", () => {
    expect(isCronSession("agent:main:cron:abc")).toBe(true);
    expect(isCronSession("agent:main:discord:channel:123")).toBe(false);
    expect(isCronSession(undefined)).toBe(false);
  });
});

describe("mirror deriveTitle / deriveSource（標題清理）", () => {
  it("Discord 頻道 displayName 形如 discord:<guildId>#crypto → #crypto", () => {
    expect(deriveTitle({ displayName: "discord:1478643979191849082#crypto", channel: "discord", key: "k" })).toBe("#crypto");
  });
  it("Cron / 直接名保持原樣", () => {
    expect(deriveTitle({ displayName: "Cron: 加密货币日报", key: "k" })).toBe("Cron: 加密货币日报");
  });
  it("無 displayName → fallback key", () => {
    expect(deriveTitle({ key: "agent:main:x" })).toBe("agent:main:x");
  });
  it("deriveSource：channel → origin.provider → openclaw", () => {
    expect(deriveSource({ channel: "discord" })).toBe("discord");
    expect(deriveSource({ origin: { provider: "telegram" } })).toBe("telegram");
    expect(deriveSource({})).toBe("openclaw");
  });
});

describe("mirror lineToMessage（.jsonl 行 → ImportMessage）", () => {
  it("user 行 → role user + 拼接 text blocks", () => {
    const o = {
      type: "message",
      id: "x",
      timestamp: 100,
      message: { role: "user", content: [{ type: "text", text: "你好" }, { type: "text", text: "世界" }], timestamp: 99 },
    };
    expect(lineToMessage(o)).toEqual({ role: "user", text: "你好世界", createdAt: 99 });
  });

  it("assistant 行 → role agent", () => {
    const o = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "回覆" }], timestamp: 50 } };
    expect(lineToMessage(o)?.role).toBe("agent");
  });

  it("toolResult / 系統行 → null（MVP 跳過）", () => {
    expect(lineToMessage({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "r" }] } })).toBeNull();
    expect(lineToMessage({ type: "session", id: "s" })).toBeNull();
    expect(lineToMessage({ type: "model_change" })).toBeNull();
  });

  it("空白 text → null", () => {
    expect(lineToMessage({ type: "message", message: { role: "user", content: [{ type: "text", text: "  " }] } })).toBeNull();
  });
});

describe("mirror readNewMessages（增量 + 半行邊界）", () => {
  function line(role: string, text: string): string {
    return JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }], timestamp: 1 } }) + "\n";
  }

  it("從 offset 起讀整行，半行留到下次", () => {
    const dir = mkdtempSync(join(tmpdir(), "occ-mir-"));
    const f = join(dir, "s.jsonl");
    try {
      const a = line("user", "一");
      const b = line("assistant", "二");
      writeFileSync(f, a + b);
      // 從頭讀 → 兩條，offset 到末尾
      const r1 = readNewMessages(f, 0);
      expect(r1.messages.map((m) => m.text)).toEqual(["一", "二"]);
      expect(r1.newOffset).toBe(Buffer.byteLength(a + b));

      // 追加半行（無換行）→ 不產出，offset 不動
      writeFileSync(f, a + b + '{"type":"message"');
      const r2 = readNewMessages(f, r1.newOffset);
      expect(r2.messages).toEqual([]);
      expect(r2.newOffset).toBe(r1.newOffset);

      // 補全該行 → 產出第三條
      writeFileSync(f, a + b + line("user", "三"));
      const r3 = readNewMessages(f, r1.newOffset);
      expect(r3.messages.map((m) => m.text)).toEqual(["三"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#6/#9 狀態文件兜底與裁剪", () => {
  it("#6 saveStateFile 輪替 .bak;主文件損壞/丟失 → loadStateFile 從 .bak 恢復", async () => {
    const { loadStateFile, saveStateFile } = await import("../src/openclaw/mirror");
    const d = mkdtempSync(join(tmpdir(), "oc-state-"));
    const p = join(d, "mirror.json");
    const revive = (raw: any) => ({ offsets: raw.offsets ?? {} });
    saveStateFile(p, { offsets: { k: 9 } });
    saveStateFile(p, { offsets: { k: 12 } }); // 第二次保存 → 上一版落 .bak
    writeFileSync(p, "{corrupted"); // 主文件損壞
    expect(loadStateFile(p, revive, () => ({ offsets: {} })).offsets.k).toBe(9);
    rmSync(p); // 主文件丟失同樣兜底
    expect(loadStateFile(p, revive, () => ({ offsets: {} })).offsets.k).toBe(9);
    rmSync(`${p}.bak`); // 雙亡 → 才重置
    expect(loadStateFile(p, revive, () => ({ offsets: {} })).offsets).toEqual({});
  });

  it("#9 prune:消失超期才裁;在列即清 missingAt;短暫缺席不裁", async () => {
    const { Mirror } = await import("../src/openclaw/mirror");
    process.env.MACCHIATO_OPENCLAW_MIRROR = join(mkdtempSync(join(tmpdir(), "oc-prune-")), "m.json");
    const m: any = new Mirror({ onEvent: () => () => {} } as any, { agentLinkId: "al" } as any);
    m.state = {
      offsets: { live: 5, gone_old: 7, gone_new: 8 },
      missingAt: { gone_old: Date.now() - 8 * 24 * 3600 * 1000 }, // 消失 8 天 > 7 天閾值
    };
    m.prune(new Set(["live"]));
    expect(Object.keys(m.state.offsets).sort()).toEqual(["gone_new", "live"]); // 超期的裁掉
    expect(m.state.missingAt.gone_new).toBeTruthy(); // 新消失的記時、暫不裁
    m.prune(new Set(["live", "gone_new"])); // gone_new 回歸
    expect(m.state.missingAt.gone_new).toBeUndefined(); // 回歸即清
    expect(m.state.offsets.gone_new).toBe(8);
  });
});

describe("#61 工具調用/思考塊入鏡像", () => {
  const line = (o: any) => JSON.stringify(o);
  const asst = (blocks: any[], ts = Date.now()) =>
    ({ type: "message", message: { role: "assistant", content: blocks, timestamp: ts } });
  const toolRes = (cid: string, text: string, isError = false) =>
    ({ type: "message", message: { role: "toolResult", toolCallId: cid, isError,
       content: [{ type: "text", text }], timestamp: Date.now() } });

  it("lineToMessage:thinking → reasoning、toolCall → tools(帶 input);純工具消息不再被丟", async () => {
    const { lineToMessage } = await import("../src/openclaw/mirror");
    const m = lineToMessage(asst([
      { type: "thinking", thinking: "想一下" },
      { type: "toolCall", id: "c1", name: "web_fetch", arguments: { url: "https://x" } },
      { type: "text", text: "查到了" },
    ]))!;
    expect(m.reasoning).toBe("想一下");
    expect(m.tools).toEqual([{ callId: "c1", name: "web_fetch", state: "ok", input: { url: "https://x" } }]);
    expect(m.text).toBe("查到了");
    // 只有 toolCall、無文字的 assistant 行:此前被 !text.trim() 丟棄 → 現在保留
    expect(lineToMessage(asst([{ type: "toolCall", id: "c2", name: "exec" }]))).toBeTruthy();
  });

  it("foldMessages:toolResult 按 callId 折入 output;isError → state=error", async () => {
    const { foldMessages } = await import("../src/openclaw/mirror");
    const { messages } = foldMessages([
      asst([{ type: "toolCall", id: "c1", name: "exec" }, { type: "text", text: "跑一下" }]),
      toolRes("c1", "命令輸出"),
      asst([{ type: "toolCall", id: "c2", name: "web_fetch" }]),
      toolRes("c2", "404", true),
    ]);
    expect(messages[0].tools![0]).toMatchObject({ callId: "c1", output: "命令輸出", state: "ok" });
    expect(messages[1].tools![0]).toMatchObject({ callId: "c2", output: "404", state: "error" });
  });

  it("readNewMessages hold-back:尾部 toolCall 未結算 → 不發、offset 停行首;結果到齊後整條發出", async () => {
    const { readNewMessages } = await import("../src/openclaw/mirror");
    const d = mkdtempSync(join(tmpdir(), "oc-fold-"));
    const f = join(d, "s.jsonl");
    const l1 = line({ type: "message", message: { role: "user", content: [{ type: "text", text: "查天氣" }], timestamp: Date.now() } });
    const l2 = line(asst([{ type: "toolCall", id: "c1", name: "web_fetch" }]));
    writeFileSync(f, l1 + "\n" + l2 + "\n");
    const r1 = readNewMessages(f, 0);
    expect(r1.messages.map((m) => m.role)).toEqual(["user"]); // agent 未結算 → hold-back
    expect(r1.newOffset).toBe(Buffer.byteLength(l1, "utf8") + 1); // offset 停在 agent 行首
    writeFileSync(f, l1 + "\n" + l2 + "\n" + line(toolRes("c1", "晴 25°C")) + "\n");
    const r2 = readNewMessages(f, r1.newOffset);
    expect(r2.messages.length).toBe(1);
    expect(r2.messages[0].tools![0].output).toBe("晴 25°C"); // 下輪連結果一起出
  });

  it("readNewMessages:未結算但太舊(agent 崩)→ 照發不卡死", async () => {
    const { readNewMessages } = await import("../src/openclaw/mirror");
    const d = mkdtempSync(join(tmpdir(), "oc-stale-"));
    const f = join(d, "s.jsonl");
    writeFileSync(f, line(asst([{ type: "toolCall", id: "c1", name: "exec" }], Date.now() - 3600_000)) + "\n");
    const r = readNewMessages(f, 0);
    expect(r.messages.length).toBe(1); // 超 STALE 照發
  });
});
