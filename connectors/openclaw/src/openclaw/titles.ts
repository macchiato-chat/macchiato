/**
 * #113 Macchiato 發起的 OpenClaw 會話自動標題——路由過**用戶自己的 agent**(gateway `agent` RPC,
 * 用其配置的默認模型;零 hardcode provider/model,CLAUDE.md 鐵律)。消除 #94 的「放空」妥協。
 *
 * 靜默通道(2026-07-11 活測):`agent` RPC + 專用 session key `agent:main:macchiato:titlegen-<sid>`
 * ——落在 MACCHIATO_PREFIX 下,鏡像與深度導入永久跳過,不會像 CC #94 踩過的那樣冒出「幽靈會話」;
 * drive 也從不 markDriven 它,gateway 事件被忽略 → 與用戶對話零污染。
 * 結果取自 chat final **事件**(agent RPC 的直接響應只是 ack,且客戶端 15s 超時可能先拋)。
 * 清理:sessions.delete/reset 需 operator.admin(連接器只有 read/write)→ 不刪。每會話一個
 * 一次性 titlegen 會話(單回合、幾 KB),可接受;OpenClaw 側可見但無害。
 *
 * env `MACCHIATO_OPENCLAW_TITLE_MODE`:summary(默認,經用戶 agent 生成)/ firstmsg(截斷,零 LLM)/ off。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OpenClawGateway } from "./gateway";

export type TitleMode = "summary" | "firstmsg" | "off";

export function titleMode(): TitleMode {
  const m = process.env.MACCHIATO_OPENCLAW_TITLE_MODE;
  if (m === "firstmsg" || m === "off") return m;
  if (m && m !== "summary") console.error(`[titles] 忽略非法 MACCHIATO_OPENCLAW_TITLE_MODE=${m}(summary/firstmsg/off)`);
  return "summary";
}

function timeoutMs(): number {
  const v = Number(process.env.MACCHIATO_OPENCLAW_TITLE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 45_000;
}

/** 首條消息截斷兜底標題(對齊 CC)。 */
export function fallbackTitle(firstUserText: string): string {
  return firstUserText.replace(/\s+/g, " ").trim().slice(0, 56) || "新會話";
}

/** 清洗模型輸出:去引號/前綴/多行,截長(對齊 CC)。 */
export function cleanTitle(raw: string): string {
  return raw
    .split("\n")[0]!
    .replace(/^["'`「」『』《》\s]+|["'`「」『』《》\s]+$/g, "")
    .replace(/^(title|標題|标题)[:：]\s*/i, "")
    .slice(0, 60)
    .trim();
}

/** titlegen 專用 session key(MACCHIATO_PREFIX 下 → 鏡像/導入天然跳過;OpenClaw 會轉小寫)。 */
export function titlegenKey(sid: string): string {
  return `agent:main:macchiato:titlegen-${sid}`.toLowerCase();
}

function titlePrompt(firstUserText: string): string {
  return (
    `Generate a concise title (max 8 words, same language as the message) for a conversation` +
    ` that starts with this user message:\n"""\n${firstUserText.slice(0, 500)}\n"""\n` +
    `Reply with ONLY the title — no quotes, no explanations, no tool use.`
  );
}

/**
 * 生成標題:summary 經用戶自己的 agent(失敗/超時回退截斷);firstmsg 直接截斷;off 返回空。
 * 先掛 final 事件監聽再發 RPC(免競態);RPC 響應不依賴(只是 ack)。
 */
export async function generateTitle(gw: OpenClawGateway, sid: string, firstUserText: string): Promise<string> {
  const mode = titleMode();
  if (mode === "off") return "";
  const fallback = fallbackTitle(firstUserText);
  if (mode === "firstmsg") return fallback;
  const key = titlegenKey(sid);
  try {
    const final = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`titlegen final 超時 ${timeoutMs()}ms`));
      }, timeoutMs());
      const off = gw.onEvent((e) => {
        const p = (e.payload ?? {}) as Record<string, any>;
        if (e.event !== "chat" || p.state !== "final") return;
        if (String(p.sessionKey ?? "").toLowerCase() !== key) return;
        const text = (Array.isArray(p.message?.content) ? p.message.content : [])
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("");
        clearTimeout(timer);
        off();
        resolve(text);
      });
    });
    void gw
      .request("agent", {
        message: titlePrompt(firstUserText),
        sessionKey: key,
        deliver: false,
        timeout: Math.ceil(timeoutMs() / 1000),
        idempotencyKey: `titlegen-${sid}-${Date.now()}`,
      })
      .catch(() => {
        /* ack 超時/失敗不致命——final 事件才是結果;真失敗由 final 超時兜底 */
      });
    return cleanTitle(await final) || fallback;
  } catch (e) {
    console.error(`[openclaw titlegen failed for ${sid}] ${(e as Error).message}`);
    return fallback;
  }
}

// ── 已生成標題的 sid 持久集(重啟後不重生,免覆蓋用戶手改)────────────────────────
function titledPath(): string {
  return process.env.MACCHIATO_OPENCLAW_TITLED || join(homedir(), ".macchiato/openclaw-titled.json");
}

export function loadTitled(): Set<string> {
  // #248 主檔壞/缺 → 試 .bak(此前非原子直寫,損壞回空集 → 手改標題被重新生成覆蓋)。
  for (const path of [titledPath(), titledPath() + ".bak"]) {
    try {
      const arr = JSON.parse(readFileSync(path, "utf8"));
      return new Set(Array.isArray(arr) ? arr.map(String) : []);
    } catch {
      /* 試下一個 */
    }
  }
  return new Set();
}

export function saveTitled(titled: Set<string>): void {
  try {
    mkdirSync(dirname(titledPath()), { recursive: true });
    // #248 tmp+rename 原子寫 + .bak 輪替(此前直寫,崩在寫一半即損壞回空集、手改標題被覆蓋)。
    const tmp = titledPath() + ".tmp";
    writeFileSync(tmp, JSON.stringify([...titled]));
    if (existsSync(titledPath())) renameSync(titledPath(), titledPath() + ".bak");
    renameSync(tmp, titledPath());
  } catch (e) {
    console.error("[titled save failed]", (e as Error).message);
  }
}
