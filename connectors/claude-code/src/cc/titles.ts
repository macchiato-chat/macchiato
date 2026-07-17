/**
 * #94 Macchiato 發起的 CC 會話標題生成。這類會話默認標題卡在「新會話」(driven,mirror 跳過、
 * 吃不到首條消息兜底)。連接器在**第一回合**生成標題,emit session.title 給 server + renameSession
 * 寫回 transcript(終端也看得到)。
 *
 * 成本:走 CC 同一認證(機器的 Claude Code **訂閱 OAuth**,非按 token 計費的 API key;server 零成本)。
 * env `MACCHIATO_CC_TITLE_MODE`:summary(默認,haiku 摘要)/ firstmsg(截斷首條,零 LLM)/ off。
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeBinIsAbsolute, resolveClaudeBin } from "./claude-bin";
import { workDir } from "./drive";

export type TitleMode = "summary" | "firstmsg" | "off";

export function titleMode(): TitleMode {
  const m = process.env.MACCHIATO_CC_TITLE_MODE;
  if (m === "firstmsg" || m === "off") return m;
  if (m && m !== "summary") console.error(`[titles] 忽略非法 MACCHIATO_CC_TITLE_MODE=${m}(summary/firstmsg/off)`);
  return "summary"; // 默認
}

/** 首條消息截斷兜底標題。 */
function fallbackTitle(firstUserText: string): string {
  return firstUserText.replace(/\s+/g, " ").trim().slice(0, 56) || "新會話";
}

/** 清洗模型輸出:去引號/前綴/多行,截長。 */
function cleanTitle(raw: string): string {
  return raw
    .split("\n")[0]!
    .replace(/^["'`「」『』《》\s]+|["'`「」『』《》\s]+$/g, "")
    .replace(/^(title|標題|标题)[:：]\s*/i, "")
    .slice(0, 60)
    .trim();
}

/** 生成標題。summary 走 haiku 小調用(失敗回退截斷);firstmsg 直接截斷;off 返回空。 */
export async function generateTitle(firstUserText: string): Promise<string> {
  const mode = titleMode();
  if (mode === "off") return "";
  const fallback = fallbackTitle(firstUserText);
  if (mode === "firstmsg") return fallback;
  // ⚠️ 標題生成會起一個真 claude query → 落一個 transcript。若落在被鏡像的 CLAUDE_CONFIG_DIR,
  // 鏡像會把這個垃圾會話當**新對話**捞上來(2026-07-09 用戶實測踩中)。故用**臨時 config dir**
  // (拷貝憑證認證)隔離,transcript 落臨時目錄、鏡像看不到,用完刪。SDK 文檔認可此法(env CLAUDE_CONFIG_DIR)。
  const tmpCfg = mkdtempSync(join(tmpdir(), "cc-titlegen-"));
  try {
    mkdirSync(join(tmpCfg, "projects"), { recursive: true });
    try {
      // #266:憑證源要尊重 CLAUDE_CONFIG_DIR(自定義 config dir + OAuth 用戶,寫死 ~/.claude 會拷空、
      // 標題生成必失敗回退截斷)。與 transcripts.ts 同款解析。
      const srcCfg = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
      copyFileSync(join(srcCfg, ".credentials.json"), join(tmpCfg, ".credentials.json"));
    } catch {
      /* 無憑證文件(用 ANTHROPIC_API_KEY 的環境)→ 不拷貝,靠 env key 認證 */
    }
    const q = query({
      prompt:
        `Generate a concise conversation title (3-6 words, no quotes, same language as the message) for a ` +
        `conversation that opens with this user message:\n\n"${firstUserText.slice(0, 800)}"\n\n` +
        `Reply with ONLY the title text.`,
      options: {
        model: "haiku",
        cwd: workDir(),
        ...(claudeBinIsAbsolute() ? { pathToClaudeCodeExecutable: resolveClaudeBin() } : {}),
        permissionMode: "bypassPermissions", // 純文本、不用工具;免審批卡
        env: { ...process.env, CLAUDE_CONFIG_DIR: tmpCfg } as Record<string, string>, // 隔離 transcript
      },
    });
    let out = "";
    for await (const m of q as AsyncIterable<any>) {
      if (m.type === "result" && typeof m.result === "string") out = m.result;
    }
    return cleanTitle(out) || fallback;
  } catch (e) {
    console.error(`[titles] summary 生成失敗,回退截斷: ${(e as Error).message}`);
    return fallback;
  } finally {
    rmSync(tmpCfg, { recursive: true, force: true });
  }
}
