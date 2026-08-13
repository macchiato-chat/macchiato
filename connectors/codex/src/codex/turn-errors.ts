/**
 * Codex 回合錯誤 → 用戶可見文案。
 *
 * 原則(Agents.md)：失敗說人話 + 給下一步；不甩 JSON / 協議術語 / 誤導用戶升級 Macchiato。
 * 已知類（#310 auth、模型需更新 CLI、ENOENT / 原生二進制損壞 #692）→ 可行動文案；其餘只剝掉 JSON 殼再截斷。
 */
import { CODEX_AUTH_ERR_RE } from "./state";

/** 從 app-server / CLI 各種錯誤形狀抽出純文本。 */
export function unwrapCodexErrorText(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (typeof o.detail === "string" && o.detail.trim()) return o.detail.trim();
    if (typeof o.message === "string" && o.message.trim()) return o.message.trim();
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  let s = String(raw).trim();
  // app-server 常包成 `app-server error: {"code":..,"message":".."}` 或整段 `{"detail":".."}`
  const jsonStart = s.indexOf("{");
  if (jsonStart >= 0) {
    const candidate = s.slice(jsonStart);
    try {
      const j = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof j.detail === "string" && j.detail.trim()) return j.detail.trim();
      if (typeof j.message === "string" && j.message.trim()) return j.message.trim();
    } catch {
      /* 非 JSON，用原文 */
    }
  }
  return s;
}

/** `The 'gpt-5.6-sol' model requires a newer version of Codex...` */
const MODEL_NEEDS_NEWER_CLI_RE =
  /['"]([^'"]+)['"]\s+model requires a newer version of (?:Codex|the Codex)/i;

/**
 * #692：npm `@openai/codex` JS 包裝在，但其 vendor 原生二進制缺失。
 * 真實 stderr 形狀：
 *   Error: spawn
 *   /opt/homebrew/.../node_modules/@openai/codex-darwin-arm64/vendor/.../codex/codex ENOENT
 *   at ChildProcess._handle.onexit ...
 */
const CODEX_NATIVE_MISSING_RE =
  /codex-(?:darwin|linux|win)|[/\\]vendor[/\\][^\n]*[/\\]codex/i;

const ENOENT_RE = /\bENOENT\b/i;
/** spawn 與路徑可能換行（Node 預設對長路徑會斷行）。 */
const SPAWN_ENOENT_RE = /spawn[\s\S]{0,500}?ENOENT/i;

/** 是否為「原生二進制缺失 / 安裝損壞」（包裝在、vendor 不在）。 */
export function isCodexNativeBinMissing(text: string): boolean {
  if (!ENOENT_RE.test(text) && !SPAWN_ENOENT_RE.test(text)) return false;
  return CODEX_NATIVE_MISSING_RE.test(text);
}

/** 是否為 spawn / ENOENT 類（找不到命令或原生二進制）。 */
export function isCodexEnoent(text: string): boolean {
  return ENOENT_RE.test(text) || SPAWN_ENOENT_RE.test(text);
}

/** health / 日誌用：無 ❌ 前綴的可行動短句。 */
export function humanizeCodexProbeError(raw: unknown): string {
  const text = unwrapCodexErrorText(raw);
  if (isCodexNativeBinMissing(text)) {
    return (
      "Codex CLI 安裝損壞（原生二進制缺失）。" +
      "請在連接器主機執行：npm install -g @openai/codex（或先 uninstall 再 install），然後重啟連接器"
    );
  }
  if (isCodexEnoent(text)) {
    return "本機找不到 Codex 命令。請安裝：npm i -g @openai/codex ，然後重啟連接器";
  }
  const short = text.slice(0, 160).replace(/\s+/g, " ").trim();
  return short || "codex CLI 探測失敗";
}

export function parseModelNeedsNewerCli(raw: unknown): { model: string; text: string } | null {
  const text = unwrapCodexErrorText(raw);
  const m = MODEL_NEEDS_NEWER_CLI_RE.exec(text);
  if (!m?.[1]) return null;
  return { model: m[1], text };
}

/**
 * 把原始錯誤收成一句（或一小段）用戶可執行的中文提示。
 * 不包含前綴標點策略以外的業務邏輯（是否自動重試由 drive 決定）。
 */
export function formatCodexTurnError(raw: unknown): string {
  const text = unwrapCodexErrorText(raw);
  const need = parseModelNeedsNewerCli(text);
  if (need) {
    return (
      `❌ 模型 ${need.model} 需要更新本機的 Codex CLI（不是 Macchiato 網頁/App）。\n` +
      `在連接器所在電腦執行：npm i -g @openai/codex@latest\n` +
      `升級後重試；也可先在下方換一個其他模型。`
    );
  }
  if (CODEX_AUTH_ERR_RE.test(text)) {
    return "❌ Codex 登錄已失效——請在連接器主機終端跑 `codex login` 重新登錄後重試";
  }
  // #692：區分「原生二進制壞了」vs「根本找不到 codex 命令」——都不要甩 spawn 堆棧
  if (isCodexNativeBinMissing(text)) {
    return (
      "❌ Codex CLI 安裝損壞（原生二進制缺失）。\n" +
      "請在連接器主機執行：npm install -g @openai/codex（或先 uninstall 再 install），然後重啟連接器。"
    );
  }
  if (isCodexEnoent(text)) {
    return (
      "❌ 本機找不到 Codex 命令。請在連接器主機安裝：npm i -g @openai/codex ，然後重啟連接器。"
    );
  }
  const short = text.slice(0, 200) || "unknown";
  return `❌ 回合失敗：${short}`;
}
