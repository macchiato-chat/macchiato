/**
 * §11 歷史導入（深度）：讀 OpenClaw **全部** .jsonl（不止 gateway 活躍的 ~17 個）→ import_batch。
 *  - 過濾：無用戶消息（純自動化/cron 輸出）、cron（首條用戶消息以 `[cron:` 開頭、或活躍 key 含 :cron:）。
 *  - 元數據：活躍會話用 gateway（key/displayName/channel）；歸檔會話從用戶消息的 metadata wrapper
 *    提頻道名 + channel id。
 *  - 合併：同頻道 id 的「歸檔 + 活躍」併成一條（hermesSessionId = agent:main:discord:channel:<id>）, 
 *    messages按 createdAt 排序 → 一條完整歷史。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { E2EKeyStore } from "../e2e/keys";
import type { LinkBClient } from "../linkb/client";
import type { OpenClawGateway } from "./gateway";
import {
  deriveSource,
  deriveTitle,
  extractChannelMeta,
  isCronSession,
  lineToMessage,
  MACCHIATO_PREFIX,
  rawUserText,
  type MirrorMessage,
} from "./mirror";

const IMPORT_BATCH = 20;

function sessionsDir(): string {
  return join(process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw"), "agents/main/sessions");
}

interface ImportSession {
  hermesSessionId: string;
  title: string;
  source: string;
  messages: MirrorMessage[];
}

type E2EStatus = Pick<E2EKeyStore, "isE2E">;

function withoutE2ESessions(built: ImportSession[], e2e: E2EStatus): ImportSession[] {
  return built.filter((session) => !e2e.isE2E(session.hermesSessionId));
}

interface ActiveMeta {
  key: string;
  displayName?: string;
  channel?: string;
  origin?: { provider?: string };
}

/** gateway 活躍會話 sessionId → 元數據。拿不到就只靠文件。 */
async function activeSessions(gw: OpenClawGateway): Promise<Map<string, ActiveMeta>> {
  const map = new Map<string, ActiveMeta>();
  try {
    const r = await gw.sessionsList();
    for (const s of (r?.sessions ?? []) as any[]) {
      if (s.sessionId && s.key) map.set(s.sessionId, s);
    }
  } catch {
    /* ignore */
  }
  return map;
}

/** 所有主 .jsonl（排除 .trajectory./.reset/.codex 變體）。 */
function listSessionFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl") && !n.includes(".trajectory."))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

function parseFile(file: string): { messages: MirrorMessage[]; firstUserRaw: string | null } {
  const messages: MirrorMessage[] = [];
  let firstUserRaw: string | null = null;
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return { messages, firstUserRaw };
  }
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (firstUserRaw === null) {
      const r = rawUserText(o);
      if (r && r.trim()) firstUserRaw = r;
    }
    const m = lineToMessage(o);
    if (m) messages.push(m);
  }
  return { messages, firstUserRaw };
}

/**
 * #112 解析冒煙(對齊 CC compat.smokeParseLatest):拿最新 session .jsonl 真解析一遍——
 * OpenClaw 升級改 transcript 格式時,在靜默丟消息之前把降級亮出來。無文件/空文件不判失敗(新機器)。
 */
export function smokeParseLatest(): { ok: boolean; reason?: string } {
  try {
    const files = listSessionFiles(sessionsDir());
    if (!files.length) return { ok: true };
    let latest = files[0]!;
    let latestMtime = 0;
    for (const f of files) {
      try {
        const mt = statSync(f).mtimeMs;
        if (mt > latestMtime) {
          latestMtime = mt;
          latest = f;
        }
      } catch {
        /* 跳過 */
      }
    }
    const content = readFileSync(latest, "utf8").trim();
    if (!content) return { ok: true }; // 空文件不判失敗
    const { messages, firstUserRaw } = parseFile(latest);
    if (!messages.length && !firstUserRaw)
      return { ok: false, reason: `最新 transcript 解析零產出(格式可能漂移): ${basename(latest)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `transcript 解析冒煙拋錯: ${(e as Error).message}` };
  }
}

/** 深度收集可導入會話（活躍 + 歸檔, 按頻道合併、按時間排序）。 */
async function collectImportSessions(gw: OpenClawGateway): Promise<ImportSession[]> {
  const active = await activeSessions(gw);
  const byKey = new Map<string, ImportSession>();
  for (const file of listSessionFiles(sessionsDir())) {
    const sessionId = basename(file).replace(/\.jsonl$/, "");
    const { messages, firstUserRaw } = parseFile(file);
    if (!messages.length) continue; // 無內容
    if (!firstUserRaw) continue; // 無用戶消息 = 純自動化/cron 輸出
    if (firstUserRaw.startsWith("[cron:")) continue; // cron 跳過

    let hermesSessionId: string;
    let title: string;
    let source: string;
    const a = active.get(sessionId);
    if (a) {
      if (isCronSession(a.key)) continue;
      // #113 macchiato: 前綴會話不導入——driven 會話 live 已入庫(再導=重複);titlegen 是隱藏會話。
      if (a.key?.toLowerCase().startsWith(MACCHIATO_PREFIX)) continue;
      hermesSessionId = a.key;
      title = deriveTitle(a);
      source = deriveSource(a);
    } else {
      const meta = extractChannelMeta(firstUserRaw);
      if (meta.channelId) {
        hermesSessionId = `agent:main:discord:channel:${meta.channelId}`; // 與活躍同名頻道合併
        title = meta.channelName || `#${meta.channelId}`;
        source = "discord";
      } else {
        hermesSessionId = sessionId;
        title = messages.find((m) => m.role === "user")?.text.slice(0, 40).trim() || `OpenClaw ${sessionId.slice(0, 8)}`;
        source = "openclaw";
      }
    }

    const existing = byKey.get(hermesSessionId);
    if (existing) existing.messages.push(...messages);
    else byKey.set(hermesSessionId, { hermesSessionId, title, source, messages });
  }
  const out = [...byKey.values()];
  for (const s of out) s.messages.sort((x, y) => (x.createdAt ?? 0) - (y.createdAt ?? 0));
  return out;
}

/** 上報可導入會話數（Link B ready 後調一次）。 */
export async function announceImportAvailable(gw: OpenClawGateway, linkb: LinkBClient, e2e: E2EStatus): Promise<void> {
  const built = withoutE2ESessions(await collectImportSessions(gw), e2e);
  linkb.send({ t: "import_available", count: built.length });
  console.log(`· import_available: ${built.length} sessions importable (incl. archived; cron/automation filtered)`);
}

/** 收到 import_start：深度枚舉（含歸檔）, 分批 import_batch 回傳（最後 done:true）。 */
export async function runImport(gw: OpenClawGateway, linkb: LinkBClient, e2e: E2EStatus): Promise<void> {
  console.log("· import_start received — enumerating full history (incl. archived)…");
  const built = withoutE2ESessions(await collectImportSessions(gw), e2e);
  if (!built.length) {
    linkb.send({ t: "import_batch", sessions: [], done: true });
    console.log("  → no history, sending empty done");
    return;
  }
  for (let i = 0; i < built.length; i += IMPORT_BATCH) {
    const chunk = built.slice(i, i + IMPORT_BATCH);
    const done = i + IMPORT_BATCH >= built.length;
    linkb.send({ t: "import_batch", sessions: chunk, done });
    const total = chunk.reduce((n, s) => n + s.messages.length, 0);
    console.log(`  → import_batch ${Math.floor(i / IMPORT_BATCH) + 1}: ${chunk.length} sessions / ${total} messages${done ? " (done)" : ""}`);
  }
}
