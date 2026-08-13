/**
 * Codex rollout JSONL 解析(~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)。
 * 每行 typed envelope:{type, payload}。鏡像取 event_msg 的 user_message / agent_message
 * (文本乾淨、無 metadata wrapper)。response_item/message 攜同一文本 → 跳過防雙份;
 * 工具細節(exec/file_change)v1 不入(對齊 OpenClaw v1,見 #61 同款後續)。
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
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

export interface RolloutTail {
  /** 從請求 offset 起實際讀到的字節；可能以未完成 JSONL 行結尾。 */
  content: Buffer;
  /** 本次 snapshot 的讀取終點；完整行水位仍由 readNewMessages 決定。 */
  endOffset: number;
}

/**
 * 只讀 rollout 在 byte offset 之後的尾部。每輪 poll 的成本因此取決於新增內容，
 * 不再取決於整條長會話的歷史大小。文件在 fstat 後繼續增長時，剩餘字節留到下輪。
 */
export function readRolloutTail(file: string, offset: number): RolloutTail {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return { content: Buffer.alloc(0), endOffset: offset };
    const buffer = Buffer.allocUnsafe(size - offset);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = readSync(
        fd,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        offset + bytesRead,
      );
      if (read <= 0) break;
      bytesRead += read;
    }
    return {
      content: bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead),
      endOffset: offset + bytesRead,
    };
  } finally {
    closeSync(fd);
  }
}

export interface RolloutPreamble {
  /** 僅含首條 session_meta 與首條 user_message，足夠派生 cwd/title/內部 thread 判據。 */
  content: string;
  hasUserMessage: boolean;
}

/**
 * 流式找 rollout 頭部 metadata，不把歷史正文載入內存。正常格式兩條內即可返回；
 * 舊格式缺字段時掃到 snapshot EOF，仍只保留命中的兩行。
 */
export function readRolloutPreamble(file: string): RolloutPreamble {
  const fd = openSync(file, "r");
  try {
    const snapshotSize = fstatSync(fd).size;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let carry = Buffer.alloc(0);
    let sessionMeta: string | undefined;
    let userMessage: string | undefined;

    while (position < snapshotSize) {
      const length = Math.min(chunk.length, snapshotSize - position);
      const bytesRead = readSync(fd, chunk, 0, length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      const data = carry.length
        ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      let lineStart = 0;
      let newline = data.indexOf(0x0a, lineStart);
      while (newline >= 0) {
        const line = data.subarray(lineStart, newline).toString("utf8").trim();
        if (line) {
          try {
            const value = JSON.parse(line) as {
              type?: string;
              payload?: { type?: string; message?: unknown };
            };
            if (!sessionMeta && value.type === "session_meta") sessionMeta = line;
            if (
              !userMessage
              && value.type === "event_msg"
              && value.payload?.type === "user_message"
              && typeof value.payload.message === "string"
            ) {
              userMessage = line;
            }
          } catch {
            /* 壞行不影響後續 metadata 探測 */
          }
        }
        if (sessionMeta && userMessage) {
          return {
            content: `${sessionMeta}\n${userMessage}\n`,
            hasUserMessage: true,
          };
        }
        lineStart = newline + 1;
        newline = data.indexOf(0x0a, lineStart);
      }
      carry = Buffer.from(data.subarray(lineStart));
    }

    return {
      content: [sessionMeta, userMessage].filter(Boolean).join("\n"),
      hasUserMessage: userMessage !== undefined,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Codex guardian review 寫進 rollout 的假 user_message。
 * 首評 / 續評共用此前綴；只認開頭，用戶轉貼中段不誤傷。
 */
export function isCodexInternalHistoryText(text: string): boolean {
  return text.trimStart().startsWith("The following is the Codex agent history");
}

/** 一行 rollout envelope → 消息(user_message / agent_message);其餘 → null。 */
function lineToMessage(o: unknown, ord: number): CodexMessage | null {
  if (!o || typeof o !== "object") return null;
  const env = o as { type?: string; payload?: { type?: string; message?: unknown; phase?: string } };
  if (env.type !== "event_msg" || !env.payload) return null;
  const p = env.payload;
  if (p.type === "user_message" && typeof p.message === "string") {
    const text = p.message.trim();
    if (!text || isCodexInternalHistoryText(text)) return null;
    return { role: "user", text, ord };
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
export function nextOrdAtEof(content: string | Buffer): number {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  let n = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0a) n += 1;
  }
  return n;
}

/**
 * 從 offset 起讀新內容,按整行解析(剩半行留到下次)。返回消息 + 新 offset。
 * ord 用**全文行號**(從 0 掃),保證同一文件內去重穩定;調用方傳入起始行號基準。
 */
export function readNewMessages(
  content: string | Buffer,
  offset: number,
  ordBase: number,
  maxMessages = Number.POSITIVE_INFINITY,
): { messages: CodexMessage[]; newOffset: number; lineCount: number } {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
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
