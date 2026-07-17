/**
 * #94/#113 Macchiato 發起的 Codex 會話自動標題——經**用戶自己的 codex**(其訂閱/配置的模型;
 * 零 hardcode provider/model,CLAUDE.md 鐵律)。用臨時 CODEX_HOME 隔離:titlegen 的 rollout
 * 落臨時目錄,不污染真實 ~/.codex(否則鏡像會把它當幽靈會話,CC #94 踩過)。
 * env MACCHIATO_CODEX_TITLE_MODE:summary(默認)/ firstmsg(截斷,零調用)/ off。
 */
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexBin } from "./codex-bin";

/** #267 啟動清掃殘留的 codex-titlegen-* 臨時目錄(v1 標題把 auth.json 拷進 /tmp;SIGKILL 時
 * finally 不跑會殘留憑證副本)。啟動時掃一次,best-effort。 */
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

export type TitleMode = "summary" | "firstmsg" | "off";

export function titleMode(): TitleMode {
  const m = process.env.MACCHIATO_CODEX_TITLE_MODE;
  if (m === "firstmsg" || m === "off") return m;
  if (m && m !== "summary") console.error(`[titles] 忽略非法 MACCHIATO_CODEX_TITLE_MODE=${m}(summary/firstmsg/off)`);
  return "summary";
}

export function fallbackTitle(firstUserText: string): string {
  return firstUserText.replace(/\s+/g, " ").trim().slice(0, 56) || "新會話";
}

export function cleanTitle(raw: string): string {
  return raw
    .split("\n")[0]!
    .replace(/^["'`「」『』《》\s]+|["'`「」『』《》\s]+$/g, "")
    .replace(/^(title|標題|标题)[:：]\s*/i, "")
    .slice(0, 60)
    .trim();
}

function timeoutMs(): number {
  const v = Number(process.env.MACCHIATO_CODEX_TITLE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 45_000;
}

/** 生成標題:summary 經隔離的 codex exec(失敗/超時回退截斷);firstmsg 截斷;off 空。 */
export async function generateTitle(firstUserText: string): Promise<string> {
  const mode = titleMode();
  if (mode === "off") return "";
  const fallback = fallbackTitle(firstUserText);
  if (mode === "firstmsg") return fallback;

  const home = mkdtempSync(join(tmpdir(), "codex-titlegen-"));
  try {
    try {
      copyFileSync(join(homedir(), ".codex/auth.json"), join(home, "auth.json")); // 帶登錄
    } catch {
      return fallback; // 未登錄 → 截斷兜底
    }
    const prompt =
      `Generate a concise title (max 8 words, same language as the message) for a conversation ` +
      `that starts with:\n"""\n${firstUserText.slice(0, 500)}\n"""\n` +
      `Reply with ONLY the title — no quotes, no explanations, no tool use.`;
    const out = await new Promise<string>((resolve) => {
      const proc = spawn(
        resolveCodexBin(),
        ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "-C", home, prompt],
        { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, CODEX_HOME: home } },
      );
      let buf = "";
      let answer = "";
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve(answer);
      }, timeoutMs());
      proc.stdout.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          try {
            const ev = JSON.parse(line);
            if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") {
              answer = ev.item.text;
            }
          } catch {
            /* 非 JSON 行 */
          }
        }
      });
      proc.on("close", () => {
        clearTimeout(timer);
        resolve(answer);
      });
      proc.on("error", () => {
        clearTimeout(timer);
        resolve("");
      });
    });
    return cleanTitle(out) || fallback;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
