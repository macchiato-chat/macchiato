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
 * 檔內完整行數 = `\n` 個數 = 從 ord=0 讀完全部完整行後的「下一起始 ord」。
 * 與 `readNewMessages(content, 0, 0).lineCount` 一致。
 *
 * ⚠️ 不可用 `content.split("\n").length`：尾 `\n` 時多出一個空串，恒多 1（#418）。
 * seed / endOrd 等「水位快進到 EOF」路徑必須與增量路徑同一計法，否則 ordBase 偏移 →
 * srcId 哈希不一致 → 跨路徑去重失效。
 */
export function nextOrdAtEof(content: string): number {
  let n = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0x0a) n += 1;
  }
  return n;
}

/**
 * 從 offset 起讀新內容,按整行解析(剩半行留到下次)。返回消息 + 新 offset。
 * ord 用**全文行號**(從 0 掃),保證同一文件內去重穩定;調用方傳入起始行號基準。
 */
export function readNewMessages(
  content: string,
  offset: number,
  ordBase: number,
  maxMessages = Number.POSITIVE_INFINITY,
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
  let consumedBytes = 0;
  let lineCount = 0;
  for (const line of lines) {
    const s = line.trim();
    if (s) {
      try {
        const m = lineToMessage(JSON.parse(s), ord);
        if (m) {
          if (messages.length >= maxMessages) {
            return {
              messages,
              newOffset: offset + consumedBytes,
              lineCount,
            };
          }
          messages.push(m);
        }
      } catch {
        /* 壞行跳過 */
      }
    }
    consumedBytes += Buffer.byteLength(line, "utf8") + 1;
    lineCount += 1;
    ord += 1;
  }
  return { messages, newOffset: offset + lastNl + 1, lineCount };
}

/**
 * #473 rewind 用:全量掃描 rollout,給每條消息附上**所屬回合**(其前最近一條
 * `event_msg.task_started` 的 turn_id)。ord 計法必須與 `readNewMessages` 逐字節一致
 * (全文行號,含非消息行)——srcId 哈希含 ord,算歪一格就對不上鏡像發過的身份。
 * 只讀完整行(尾半行忽略,與增量路徑同容錯)。
 */
export function messagesWithTurns(
  content: string,
): Array<CodexMessage & { turnId: string | null }> {
  const buf = Buffer.from(content, "utf8");
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return [];
  const lines = buf.subarray(0, lastNl).toString("utf8").split("\n");
  const out: Array<CodexMessage & { turnId: string | null }> = [];
  let ord = 0;
  let turnId: string | null = null;
  for (const line of lines) {
    const s = line.trim();
    if (s) {
      try {
        const o = JSON.parse(s) as { type?: string; payload?: { type?: string; turn_id?: unknown } };
        if (o.type === "event_msg" && o.payload?.type === "task_started" && typeof o.payload.turn_id === "string") {
          turnId = o.payload.turn_id;
        }
        const m = lineToMessage(o, ord);
        if (m) out.push({ ...m, turnId });
      } catch {
        /* 壞行跳過 */
      }
    }
    ord += 1;
  }
  return out;
}
