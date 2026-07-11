/**
 * §11 歷史導入：讀本機**全部** Claude Code transcript → import_batch 分批回傳。
 *  - 過濾：無真人 user 消息的會話（純自動化 / headless 探針 / 空會話）不導。
 *  - 標題：custom-title（全文最後一條）> 首條 user 消息截斷。
 *  - server 端按會話冪等（重導 = 刪重插），tools 走 ImportToolCall 形狀。
 */
import type { LinkBClient } from "../linkb/client";
import { foldEntries, readEntries, type CCMessage } from "./transcripts";
import { discoverSessions, toImportMessage } from "./mirror";

/** 單帧字節預算：server maxPayload 8MiB,更關鍵是慢上行——大帧上傳期間 pong 排隊,帧越小越穩。 */
const FRAME_BUDGET = Number(process.env.MACCHIATO_CC_IMPORT_FRAME_BYTES) || 2 * 1024 * 1024;

interface BuiltSession {
  hermesSessionId: string;
  title: string;
  source: string;
  messages: Record<string, unknown>[];
}

export function collectImportSessions(): BuiltSession[] {
  const out: BuiltSession[] = [];
  for (const { sid, file } of discoverSessions()) {
    try {
      const { entries, endOffset } = readEntries(file, 0);
      if (!entries.length) continue;
      // 歷史快照:全結算（in-flight 保留是鏡像的事,導入時工具沒結果就導成無結果）
      const { messages, title } = foldEntries(entries, endOffset, Number.MAX_SAFE_INTEGER);
      if (!messages.some((m: CCMessage) => m.role === "user")) continue; // 無真人消息不導
      out.push({
        hermesSessionId: sid,
        title: title ?? messages.find((m) => m.role === "user")!.text.slice(0, 60),
        source: "claude-code",
        messages: messages.map(toImportMessage),
      });
    } catch (e) {
      console.error(`[import] skip ${sid}: ${(e as Error).message}`);
    }
  }
  return out;
}

export function announceImportAvailable(linkb: LinkBClient): void {
  const n = collectImportSessions().length;
  linkb.send({ t: "import_available", count: n });
  console.log(`· import_available: ${n} sessions importable`);
}

/** 按字節預算把會話裝帧：塞滿即開新帧;單會話超預算也只能獨佔一帧（server 按整會話導入,不可跨帧拆）。 */
export function packFrames(built: BuiltSession[], budget = FRAME_BUDGET): BuiltSession[][] {
  const frames: BuiltSession[][] = [];
  let cur: BuiltSession[] = [];
  let curBytes = 0;
  for (const s of built) {
    const b = Buffer.byteLength(JSON.stringify(s));
    if (cur.length && curBytes + b > budget) {
      frames.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(s);
    curBytes += b;
  }
  if (cur.length) frames.push(cur);
  return frames;
}

/** 收到 import_start：全量枚舉,按字節預算分帧 import_batch 回傳（最後 done:true）。 */
export function runImport(linkb: LinkBClient): void {
  console.log("· import_start received — enumerating transcripts…");
  const built = collectImportSessions();
  if (!built.length) {
    linkb.send({ t: "import_batch", sessions: [], done: true });
    console.log("  → no history, sending empty done");
    return;
  }
  const frames = packFrames(built);
  frames.forEach((chunk, i) => {
    const done = i === frames.length - 1;
    linkb.send({ t: "import_batch", sessions: chunk, done });
    const total = chunk.reduce((n, s) => n + s.messages.length, 0);
    const bytes = Buffer.byteLength(JSON.stringify(chunk));
    console.log(
      `  → import_batch ${i + 1}/${frames.length}: ${chunk.length} sessions / ${total} messages / ${(bytes / 1024 / 1024).toFixed(1)}MiB${done ? " (done)" : ""}`,
    );
  });
}
