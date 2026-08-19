/**
 * #946 標題：用 Codex 自己給線程起的人話名字。
 *
 * `~/.codex/session_index.jsonl` 每行一條：
 *   `{"id":"019bff26-…","thread_name":"Convert AssemblyAI webhook flow","updated_at":"…"}`
 * 本機 349 條、覆蓋 347/825 條用戶線程，子 agent 一條都沒有（這本身也印證了「它只給對話取名」）。
 *
 * 為什麼要它：現在標題是首條 user 消息截斷，而 IDE 會在首條消息裡注入上下文塊
 * （`# Context from my IDE setup:` / `# Files mentioned by the user:`，生產庫 117 條會話的標題
 * 就長這樣），用戶在列表裡看到一堆一模一樣、還看不懂的行。源系統本來就有真名。
 *
 * ⚠️ #376 安全邊界：**只讀一個本地 JSONL 文件**——不 spawn codex、不碰 `~/.codex/auth.json`、
 * 不把任何未可信文本送進第二個 codex 回合。這條邊界是硬的，別在這裡加「順便問問模型」。
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { sessionsRoot } from "./transcripts";

/** 索引文件 ＝ sessions 目錄的兄弟（默認 `~/.codex/session_index.jsonl`）。 */
export function sessionIndexPath(): string {
  return (
    process.env.MACCHIATO_CODEX_SESSION_INDEX
    || join(dirname(sessionsRoot()), "session_index.jsonl")
  );
}

/** 索引異常膨脹時不整檔進內存（正常量級 <100KB）。 */
const MAX_INDEX_BYTES = 8 * 1024 * 1024;

let cachePath = "";
let cacheStamp = "";
let cache = new Map<string, string>();

function load(): Map<string, string> {
  const path = sessionIndexPath();
  let stamp: string;
  try {
    const st = statSync(path);
    if (st.size > MAX_INDEX_BYTES) return new Map();
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    // 沒有索引（老 Codex / 未生成）→ 回退首條消息截斷，不報錯。
    cachePath = path;
    cacheStamp = "missing";
    cache = new Map();
    return cache;
  }
  if (path === cachePath && stamp === cacheStamp) return cache;
  const next = new Map<string, string>();
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s) as { id?: unknown; thread_name?: unknown };
        if (typeof o.id === "string" && typeof o.thread_name === "string" && o.thread_name.trim()) {
          next.set(o.id, o.thread_name.trim());
        }
      } catch {
        /* 壞行不影響其餘 */
      }
    }
  } catch {
    /* 讀失敗 → 空表回退 */
  }
  cachePath = path;
  cacheStamp = stamp;
  cache = next;
  return cache;
}

/** 源系統給該線程起的名字（沒有就 undefined，調用方回退截斷標題）。按碼點截 56。 */
export function threadName(threadId: string | undefined): string | undefined {
  if (!threadId) return undefined;
  const name = load().get(threadId);
  if (!name) return undefined;
  return [...name.replace(/\s+/g, " ").trim()].slice(0, 56).join("") || undefined;
}

/** 測試用：丟掉緩存（索引文件在同一進程內被改寫時）。 */
export function resetSessionIndexCache(): void {
  cachePath = "";
  cacheStamp = "";
  cache = new Map();
}
