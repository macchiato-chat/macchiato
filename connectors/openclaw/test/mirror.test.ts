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
