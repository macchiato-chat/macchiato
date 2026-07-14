/**
 * §11 歷史導入:枚舉 ~/.codex/sessions 全部 rollout → import_batch。過濾空會話;
 * 標題/cwd 從 rollout 自身派生。.jsonl.zst(壓縮的舊會話)v1 跳過並記數(不靜默丟)。
 */
import { readFileSync } from "node:fs";
import type { LinkBClient } from "../linkb/client";
import { deriveMeta, discoverRollouts } from "./mirror";
import { readNewMessages } from "./transcripts";

const FRAME_BUDGET = 3 * 1024 * 1024;

interface BuiltSession {
  hermesSessionId: string;
  title: string;
  source: string;
  messages: Record<string, unknown>[];
  /** #154 所屬 project(rollout session_meta.cwd)——按 project 導入的分組鍵。 */
  project: string;
}

export function collectImportSessions(): { built: BuiltSession[]; compressed: number } {
  const { rollouts, compressed } = discoverRollouts();
  const built: BuiltSession[] = [];
  for (const { file, threadId } of rollouts) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const { messages } = readNewMessages(content, 0, 0);
    if (!messages.length) continue; // 純工具/空會話跳過
    const { title, cwd } = deriveMeta(content);
    built.push({
      hermesSessionId: threadId,
      title,
      source: "codex",
      messages: messages.map((m) => ({ role: m.role, text: m.text })),
      project: cwd || "(unknown)", // #154
    });
  }
  return { built, compressed };
}

/** #154 按 project 聚合計數(數量降序)。 */
export function groupProjects(built: { project: string }[]): { name: string; count: number }[] {
  const byName = new Map<string, number>();
  for (const s of built) byName.set(s.project, (byName.get(s.project) ?? 0) + 1);
  return [...byName.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

export function announceImportAvailable(linkb: LinkBClient): void {
  const { built, compressed } = collectImportSessions();
  const projects = groupProjects(built);
  linkb.send({ t: "import_available", count: built.length, projects });
  console.log(`· import_available: ${built.length} sessions importable(${projects.length} projects)${compressed ? ` (${compressed} 個已壓縮會話跳過)` : ""}`);
}

export function packFrames(built: BuiltSession[], budget = FRAME_BUDGET): BuiltSession[][] {
  const frames: BuiltSession[][] = [];
  let cur: BuiltSession[] = [];
  let size = 0;
  for (const s of built) {
    const sz = JSON.stringify(s).length;
    if (cur.length && size + sz > budget) {
      frames.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(s);
    size += sz;
  }
  if (cur.length) frames.push(cur);
  return frames;
}

export function runImport(linkb: LinkBClient, projects?: string[]): void {
  let { built, compressed } = collectImportSessions();
  if (projects?.length) {
    const want = new Set(projects);
    built = built.filter((s) => want.has(s.project)); // #154 按 project 過濾
  }
  if (!built.length) {
    linkb.send({ t: "import_batch", agentLinkId: linkb.agentLinkId, sessions: [], done: true });
    return;
  }
  const frames = packFrames(built);
  frames.forEach((sessions, i) => {
    linkb.send({ t: "import_batch", agentLinkId: linkb.agentLinkId, sessions, done: i === frames.length - 1 });
  });
  console.log(`· import: ${built.length} sessions in ${frames.length} frame(s)${compressed ? `, ${compressed} 壓縮跳過` : ""}`);
}
