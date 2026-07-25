/**
 * #94/#113/#376 Macchiato 發起的 Codex 會話自動標題。
 *
 * #376 安全邊界:未可信首句**絕不**再送進第二個 codex 回合。舊版為隔離 `codex exec` 而把
 * `~/.codex` 下的登錄憑證拷進臨時 CODEX_HOME——這制造了一份**可獨立刷新的 OAuth 副本**,
 * 刷新會輪換伺服器端 token、作廢用戶主登錄(CLAUDE.md 2026-07-22 鐵律);而 `-s read-only`
 * 只限制寫入,擋不住 prompt injection 讀取憑證/文件並把內容當標題回傳。
 *
 * Codex `exec` CLI 在當前用法下**無法證明**同時滿足「零工具 + 不複製憑證 + 不污染真實 store」
 * (CC 的 Agent SDK 能——見 cc/titles.ts 的 tools:[]/mcpServers:{}/settingSources:[]…),
 * 故按 #376 驗收標準移除 summary 路徑:只保留本地截斷,零 LLM、零子進程、零憑證接觸。
 * env `MACCHIATO_CODEX_TITLE_MODE`:firstmsg(默認,截斷)/ off(不生成)。summary 已移除。
 */
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #267/#376 啟動清掃殘留的 codex-titlegen-* 臨時目錄。舊版標題會把登錄憑證拷進 /tmp,
 * SIGKILL 時 finally 不跑會殘留憑證副本;現版本已不再複製,但升級後仍要清掉舊殘留。
 * 啟動時掃一次,best-effort。
 */
export function gcTitlegenResidue(): void {
  try {
    for (const name of readdirSync(tmpdir())) {
      if (name.startsWith("codex-titlegen-")) {
        try {
          rmSync(join(tmpdir(), name), { recursive: true, force: true });
        } catch {
          /* 單個失敗不擋其餘 */
        }
      }
    }
  } catch {
    /* tmpdir 讀失敗無妨 */
  }
}

export type TitleMode = "firstmsg" | "off";

export function titleMode(): TitleMode {
  const m = process.env.MACCHIATO_CODEX_TITLE_MODE;
  if (m === "firstmsg" || m === "off") return m;
  if (m === "summary")
    console.error(
      `[titles] MACCHIATO_CODEX_TITLE_MODE=summary 已因安全原因移除(#376),回退 firstmsg 截斷`,
    );
  else if (m) console.error(`[titles] 忽略非法 MACCHIATO_CODEX_TITLE_MODE=${m}(firstmsg/off)`);
  return "firstmsg"; // #376 安全默認:不把未可信首句送進另一個 codex 回合
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

/** 生成標題:firstmsg 直接截斷;off 返回空。永不 spawn codex、永不接觸憑證。 */
export async function generateTitle(firstUserText: string): Promise<string> {
  if (titleMode() === "off") return "";
  return fallbackTitle(firstUserText);
}
