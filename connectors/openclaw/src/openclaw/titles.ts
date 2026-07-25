/**
 * #113/#376 Macchiato 發起的 OpenClaw 會話自動標題。
 *
 * #376 安全邊界:未可信首句**絕不**再路由進第二個 agent 回合。舊版經 gateway `agent` RPC 走
 * 用戶自己的 agent 生成標題——但該 RPC 在連接器側**沒有任何**禁用 tools/hooks/plugins/MCP 的
 * 參數,整個路由過用戶的完整 agent,連接器**無法證明零工具模式**。按 #376 驗收標準(「若
 * gateway 無法提供可證明的零工具模式，則不提供 summary」),移除 summary 路徑:只保留本地截斷,
 * 零 LLM、零 RPC。這也順帶消除舊版每會話留一個 OpenClaw 側 titlegen 會話的副作用。
 * env `MACCHIATO_OPENCLAW_TITLE_MODE`:firstmsg(默認,截斷)/ off(不生成)。summary 已移除。
 *
 * `OpenClawGateway`/`sid` 參數保留以維持 drive.ts 調用簽名穩定,firstmsg 路徑不再使用它們。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OpenClawGateway } from "./gateway";

export type TitleMode = "firstmsg" | "off";

export function titleMode(): TitleMode {
  const m = process.env.MACCHIATO_OPENCLAW_TITLE_MODE;
  if (m === "firstmsg" || m === "off") return m;
  if (m === "summary")
    console.error(
      `[titles] MACCHIATO_OPENCLAW_TITLE_MODE=summary 已因安全原因移除(#376),回退 firstmsg 截斷`,
    );
  else if (m) console.error(`[titles] 忽略非法 MACCHIATO_OPENCLAW_TITLE_MODE=${m}(firstmsg/off)`);
  return "firstmsg"; // #376 安全默認:不把未可信首句路由進另一個 agent 回合
}

/** 首條消息截斷兜底標題。按碼點截(而非 UTF-16 單元),emoji/增補面字符不被劈成孤代理項。 */
export function fallbackTitle(firstUserText: string): string {
  return [...firstUserText.replace(/\s+/g, " ").trim()].slice(0, 56).join("") || "新會話";
}

/** 清洗輸出:去引號/前綴/多行,截長(保留供未來安全 summary 通道與測試複用)。 */
export function cleanTitle(raw: string): string {
  return raw
    .split("\n")[0]!
    .replace(/^["'`「」『』《》\s]+|["'`「」『』《》\s]+$/g, "")
    .replace(/^(title|標題|标题)[:：]\s*/i, "")
    .slice(0, 60)
    .trim();
}

/**
 * 生成標題:firstmsg 直接截斷;off 返回空。永不經 gateway RPC 路由未可信首句。
 * gw/sid 保留簽名,不再使用。
 */
export async function generateTitle(
  _gw: OpenClawGateway,
  _sid: string,
  firstUserText: string,
): Promise<string> {
  if (titleMode() === "off") return "";
  return fallbackTitle(firstUserText);
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
