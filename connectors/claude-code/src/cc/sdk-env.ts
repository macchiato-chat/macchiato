/**
 * #389 傳給 Agent SDK 子進程的環境變量。
 *
 * **為什麼需要**:Claude Code 的 `/resume` 選擇器按 transcript 行內的 `entrypoint` 字段濾掉
 * 「programmatic」會話。判定是一個**三元素黑名單**(SDK 0.3.201 `sdk.mjs`:
 * `new Set(["sdk-cli","sdk-ts","sdk-py"])`,另加 `sessionKind` 為 daemon/daemon-worker),
 * 公開 API `ListSessionsOptions.includeProgrammatic` 的註釋明說「IDE session pickers pass
 * `false` for parity with terminal /resume」。SDK 默認把自己標成 `sdk-ts` → 命中黑名單 →
 * Macchiato 驅動的會話在用戶終端 `claude --resume` 裡**看不見**。
 *
 * `entrypoint` 來自環境變量 `CLAUDE_CODE_ENTRYPOINT`,且 SDK **只在調用方沒設時才填默認值**
 * (`if(!ft.CLAUDE_CODE_ENTRYPOINT) ft.CLAUDE_CODE_ENTRYPOINT="sdk-ts"`)——這是留給嵌入方
 * 聲明身份的刻意設計,既有先例是 VSCode 擴展的 `claude-vscode`。故我們聲明 `macchiato`:
 * 黑名單外 → picker 可見,且語義誠實——Macchiato 是真人在用的另一個前端(同 vscode),
 * 不是腳本(`sdk-py`),**也不冒充 `cli`**。
 *
 * ⚠️ **必須展開 `process.env`**。SDK 文檔原文:「When set, this value REPLACES the subprocess
 * environment entirely — it is not merged with `process.env`」。只傳這兩個變量會清空 PATH /
 * HOME / 認證相關,子進程直接廢掉。`sdk-env.test.ts` 守這條不變量。
 *
 * **為什麼是覆蓋而非沿用 ambient 值**(2026-07-24 被單測抓出來的坑):連接器很可能從一個
 * **本身就設了 `CLAUDE_CODE_ENTRYPOINT` 的環境**裡啟動——VSCode 集成終端、或某個 Claude Code
 * 會話內(實測本機該變量即為 `claude-vscode`)。若沿用 ambient 值,所有 Macchiato 會話會被誤標成
 * VSCode 的,且連接器行為隨「怎麼啟動的」漂移。我們是嵌入方,**必須權威聲明自己的身份**。
 *
 * **逃生門**走 Macchiato 自己的命名空間(同 `MACCHIATO_CLAUDE_BIN` / `MACCHIATO_CC_WORKDIR` 慣例):
 * 設 `MACCHIATO_CC_ENTRYPOINT=sdk-ts` 即退回舊行為,**不用發版**。失敗模式良性:最壞是會話重新從
 * picker 消失,回到 #389 之前的狀態,不影響回寫與 resume-by-id。
 */
import { CONNECTOR_VERSION } from "../linkb/proto";

/**
 * SDK 判定為 programmatic 的 entrypoint 黑名單(`sdk.mjs` 內部實現的鏡像)。
 * 僅供單測做回歸守衛——別拿它做運行時邏輯,上游改了我們不會知道。
 */
export const SDK_PROGRAMMATIC_ENTRYPOINTS = ["sdk-cli", "sdk-ts", "sdk-py"] as const;

/** 我們向 Claude Code 聲明的身份。黑名單外 → 會話出現在終端 `/resume`。 */
export const MACCHIATO_ENTRYPOINT = "macchiato";

/**
 * 構造 `query({ options: { env } })` 的值。
 * @param base 基礎環境(默認 `process.env`;單測注入)。
 */
export function sdkEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    // 展開放最前:SDK 是整份替換,漏了 PATH/HOME/認證就全丟(見文件頭 ⚠️)。
    ...base,
    // **覆蓋** ambient 值(見文件頭):從 VSCode 終端/CC 會話裡啟動時 ambient 是 claude-vscode,
    // 沿用會把 Macchiato 會話誤標。逃生門走 MACCHIATO_ 命名空間,不吃 ambient。
    CLAUDE_CODE_ENTRYPOINT: base.MACCHIATO_CC_ENTRYPOINT || MACCHIATO_ENTRYPOINT,
    // 文檔化選項:進 User-Agent,供上游識別是哪個 app 在驅動。同樣不沿用 ambient。
    CLAUDE_AGENT_SDK_CLIENT_APP: `macchiato/${CONNECTOR_VERSION}`,
  };
}
