/**
 * #94 路 A:OpenClaw AI 重命名——讀 OpenClaw 的 OpenRouter key(~/.openclaw/secrets.json 的
 * `models/openrouter`,SecretRef 解析後的明文)→ 調 OpenRouter(OpenAI 兼容)生成摘要標題。
 * 成本:按 token 計費(用戶自己的 OpenRouter key;罕見手動操作,可忽略)。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 從 secrets.json 取 OpenRouter key(env MACCHIATO_OPENROUTER_KEY 優先,便於覆蓋/測試)。 */
export function openRouterKey(): string | null {
  if (process.env.MACCHIATO_OPENROUTER_KEY) return process.env.MACCHIATO_OPENROUTER_KEY;
  try {
    const s = JSON.parse(readFileSync(join(homedir(), ".openclaw/secrets.json"), "utf8"));
    const k = s?.models?.openrouter ?? s?.authProfiles?.openrouter;
    return typeof k === "string" && k ? k : null;
  } catch {
    return null;
  }
}

/** 清洗模型輸出:首行、去引號/前綴、截長。 */
function clean(raw: string): string {
  return (raw.split("\n")[0] ?? "")
    .replace(/^["'`「」《》\s]+|["'`「」《》\s]+$/g, "")
    .replace(/^(title|標題|标题)[:：]\s*/i, "")
    .slice(0, 60)
    .trim();
}

const TITLE_MODEL = process.env.MACCHIATO_TITLE_MODEL || "google/gemini-2.5-flash";

/** 生成標題;無 key/失敗 → 空(調用側回退截斷)。 */
export async function generateTitle(firstUserText: string): Promise<string> {
  const key = openRouterKey();
  if (!key) {
    console.error("[titles] 無 OpenRouter key,跳過 AI 重命名");
    return "";
  }
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: TITLE_MODEL,
        max_tokens: 32,
        messages: [
          {
            role: "user",
            content:
              `Generate a concise conversation title (3-6 words, no quotes, same language as the message) ` +
              `for a conversation opening with:\n\n"${firstUserText}"\n\nReply with ONLY the title.`,
          },
        ],
      }),
    });
    if (!res.ok) {
      console.error(`[titles] OpenRouter HTTP ${res.status}`);
      return "";
    }
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return clean(j.choices?.[0]?.message?.content ?? "");
  } catch (e) {
    console.error(`[titles] 生成失敗: ${(e as Error).message}`);
    return "";
  }
}
