/**
 * Codex rollout JSONL 解析(~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)。
 * 每行 typed envelope:{type, payload}。鏡像取 event_msg 的 user_message / agent_message
 * (文本乾淨、無 metadata wrapper)。response_item/message 攜同一文本 → 跳過防雙份;
 * 工具細節(exec/file_change)v1 不入(對齊 OpenClaw v1,見 #61 同款後續)。
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function sessionsRoot(): string {
  return process.env.MACCHIATO_CODEX_SESSIONS_DIR || join(homedir(), ".codex/sessions");
}

export interface CodexMessage {
  role: "user" | "agent";
  text: string;
  /** 文件內序號(0 起)——srcId 去重的穩定成分(rollout 行無 uuid)。 */
  ord: number;
}

/** 一行 rollout envelope → 消息(user_message / agent_message);其餘 → null。 */
function lineToMessage(o: unknown, ord: number): CodexMessage | null {
  if (!o || typeof o !== "object") return null;
  const env = o as { type?: string; payload?: { type?: string; message?: unknown; phase?: string } };
  if (env.type !== "event_msg" || !env.payload) return null;
  const p = env.payload;
  if (p.type === "user_message" && typeof p.message === "string") {
    const text = p.message.trim();
    return text ? { role: "user", text, ord } : null;
  }
  if (p.type === "agent_message" && typeof p.message === "string") {
    const text = p.message.trim();
    return text ? { role: "agent", text, ord } : null;
  }
  return null;
}

/**
 * 從 offset 起讀新內容,按整行解析(剩半行留到下次)。返回消息 + 新 offset。
 * ord 用**全文行號**(從 0 掃),保證同一文件內去重穩定;調用方傳入起始行號基準。
 */
export function readNewMessages(
  content: string,
  offset: number,
  ordBase: number,
): { messages: CodexMessage[]; newOffset: number; lineCount: number } {
  const buf = Buffer.from(content, "utf8");
  if (buf.length <= offset) return { messages: [], newOffset: offset, lineCount: 0 };
  const slice = buf.subarray(offset);
  const lastNl = slice.lastIndexOf(0x0a);
  if (lastNl < 0) return { messages: [], newOffset: offset, lineCount: 0 }; // 尚無完整行
  const whole = slice.subarray(0, lastNl).toString("utf8");
  const lines = whole.split("\n");
  const messages: CodexMessage[] = [];
  let ord = ordBase;
  for (const line of lines) {
    const s = line.trim();
    if (s) {
      try {
        const m = lineToMessage(JSON.parse(s), ord);
        if (m) messages.push(m);
      } catch {
        /* 壞行跳過 */
      }
    }
    ord += 1;
  }
  return { messages, newOffset: offset + lastNl + 1, lineCount: lines.length };
}
