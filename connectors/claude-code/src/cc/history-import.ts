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
  /** #154 所屬 project(transcript 條目的 cwd;拿不到回退目錄 slug)——按 project 導入的分組鍵。 */
  project: string;
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
      // #154 project = 條目 cwd(CC transcript 每行都帶);拿不到回退 transcript 所在目錄 slug。
      const cwd = entries.find((e) => typeof e.obj?.cwd === "string")?.obj.cwd as string | undefined;
      out.push({
        hermesSessionId: sid,
        title: title ?? messages.find((m) => m.role === "user")!.text.slice(0, 60),
        source: "claude-code",
        messages: messages.map(toImportMessage),
        project: cwd || file.split("/").at(-2) || "(unknown)",
      });
    } catch (e) {
      console.error(`[import] skip ${sid}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** #154 按 project 聚合計數(數量降序;client 渲染多選)。 */
export function groupProjects(built: { project: string }[]): { name: string; count: number }[] {
  const byName = new Map<string, number>();
  for (const s of built) byName.set(s.project, (byName.get(s.project) ?? 0) + 1);
  return [...byName.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

export function announceImportAvailable(linkb: LinkBClient): void {
  const built = collectImportSessions();
  const projects = groupProjects(built);
  linkb.send({ t: "import_available", count: built.length, projects });
  console.log(`· import_available: ${built.length} sessions importable(${projects.length} projects)`);
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

/** 收到 import_start：枚舉(可按 projects 過濾,#154),按字節預算分帧 import_batch 回傳（最後 done:true）。 */
export function runImport(linkb: LinkBClient, projects?: string[]): void {
  console.log(`· import_start received — enumerating transcripts…${projects?.length ? `(僅 ${projects.length} 個 project)` : ""}`);
  let built = collectImportSessions();
  if (projects?.length) {
    const want = new Set(projects);
    built = built.filter((s) => want.has(s.project));
  }
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
