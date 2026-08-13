/**
 * Link B 配對（design.md §5）：把這台機綁到你的 Macchiato 帳戶。
 *   開 WS → pair_request → server 回一次性 code（打印）→ 你在 web 輸入 → server 回 paired（長期憑證）。
 * #252 重連指數退避(3s→60s+抖動)。kind / displayName / default label 由呼叫方注入。
 * #832 終端純庫 QR + 按 expiresAt 自動換碼重打（不再依賴系統 qrencode / 固定 6.5min）。
 */
import { hostname } from "node:os";
import WebSocket from "ws";
import { LINK_B_PROTO } from "../../linkb/proto";
import { backoffMs } from "../backoff";
import {
  type ConnectorKind,
  DISPLAY_NAME,
  defaultPairLabel,
} from "../identity";
import { type Creds, DEFAULT_SERVER_URL, DEFAULT_WEB_URL, saveCreds } from "./creds";
import { formatPairingToken, generateDeviceAuthSecret } from "../e2e/device-auth";
import { printQrTerminal } from "./qr-terminal";

/** 整段配對窗口（重連+換碼都在此內）。 */
const WINDOW_MS = 30 * 60 * 1000;
/**
 * 沒拿到 expiresAt 時的兜底刷新間隔。
 * server #832 起 TTL=20min；留 90s 餘量在過期前主動換，避免用戶掃到已失效碼。
 */
const FALLBACK_REFRESH_MS = (18 * 60 + 30) * 1000;
/** 距過期至少提前這麼久換新碼（並立刻重打終端）。 */
const REFRESH_BEFORE_EXPIRY_MS = 90 * 1000;
/** 刷新間隔下限，避免異常 expiresAt 造成熱循環。 */
const MIN_REFRESH_MS = 30 * 1000;

export interface PairOptions {
  kind: ConnectorKind;
  serverUrl?: string;
  webUrl?: string;
  label?: string;
  windowMs?: number;
  /** 覆蓋 DISPLAY_NAME / MACCHIATO_PAIR_GROUP（測試用）。 */
  displayName?: string;
}

/**
 * #731：配對碼**保持純數字**；device-auth secret 另起一行、標明可選。
 *
 * 為什麼不把 secret 拼進配對碼（初版做法，已撤）——那條碼是**所有人都要走**的通道，
 * 而 secret 只有想開 E2E 的人用得上。把它拼進去的代價：
 *  - **十個**腳本用 `/>>>\s*(\d{6,16})\s*<<</` 抠碼（九個回歸 + `scripts/localchain/run.mjs`），
 *    捕獲組只吃數字 → 全部匹配不上。localchain 在 CI 的 `checks-run` 裡，等於 CI 也紅；
 *    `run-install-smoke`/`run-selfupdate-e2e`/`run-autoupdate-e2e` 還是狗糧機的步驟。
 *  - 存量 iOS 的輸碼框有 `filter(\.isNumber)`，粘貼整串會把 secret 裡的數字拼進碼 → 配對失敗。
 *  - 手輸用戶要從 12 位變成看着 ~56 個字符找「點號在哪」。
 *
 * 現在的分工：**文本行給人和腳本讀（純數字）；QR 給手機讀（帶完整 token）**。
 * 沒有任何腳本解析 QR（全倉 grep 過），所以 QR 帶 secret 是免費的——iOS 掃碼仍是零額外步驟。
 */
function showCode(
  code: string,
  webUrl: string,
  fresh: boolean,
  displayName: string,
  deviceAuthSecret: string,
  expiresAt?: Date | null,
): void {
  const line = "=".repeat(54);
  const token = formatPairingToken(code, deviceAuthSecret);
  console.log(`\n${line}`);
  // ⚠️ 回歸契約:scripts/regression/*、scripts/localchain/run.mjs 與 run-folders-e2e.mjs 斷言
  // 「>>> <純數字碼> <<<」(folders-e2e 還靠上行「code」字樣定位)——這一行**只准放數字**。
  const who = process.env.MACCHIATO_PAIR_GROUP || displayName;
  console.log(`  Pairing code for ${who}${fresh ? " (refreshed)" : ""}:`);
  console.log(`        >>>  ${code}  <<<`);
  if (expiresAt && Number.isFinite(expiresAt.getTime())) {
    // 同 refreshDelayMs：本機時鐘可能偏，封頂到「最晚也會自動換碼」的那個時刻，別報出
    // 「Expires in ~80 min」這種讓人放心離開一小時的假數字。
    const remainMs = Math.min(
      expiresAt.getTime() - Date.now(),
      FALLBACK_REFRESH_MS + REFRESH_BEFORE_EXPIRY_MS,
    );
    const remainMin = Math.max(1, Math.round(remainMs / 60_000));
    console.log(`  Expires in ~${remainMin} min (a new code will appear automatically before then).`);
  }
  console.log(`  Sign in at ${webUrl} → \"Pair connector\" → enter this code.`);
  // #731 只有想開端到端加密的人才需要下面這行；掃 QR 的話它已經在碼裡，無需手動處理。
  console.log(`\n  Optional — end-to-end encryption device key (iOS only; scanning the QR covers this):`);
  console.log(`        ${deviceAuthSecret}`);
  // #388 一碼多綁:同批安裝的其餘 agent 免碼自動綁定(安裝器設 MACCHIATO_PAIR_BATCH_MANY)
  if (process.env.MACCHIATO_PAIR_BATCH && process.env.MACCHIATO_PAIR_BATCH_MANY) {
    console.log("  Other agents from this install will pair automatically with this code.");
  }
  // #832 終端 QR：純庫渲染（不依賴 qrencode）。#731 帶完整 token（含 e2eAuth）。
  printQrTerminal(token);
  console.log(`${line}\nWaiting for you to claim it…`);
}

/**
 * 根據 server 給的 expiresAt 算下次 pair_request 延遲；趕在過期前 REFRESH_BEFORE_EXPIRY_MS 換新。
 *
 * ⚠️ 上限必須鉗到 FALLBACK_REFRESH_MS：`expiresAt` 是 server 的**絕對**時間，而這裡拿它跟
 * 本機時鐘相減。剛裝好的機器 / VM 時鐘慢一小時是常事——不鉗的話會算出「78 分鐘後再換」，
 * 可碼 20 分鐘就死了，中間用戶掃到的全是死碼（舊實現用本機固定間隔，天然不受時鐘影響，
 * 換成絕對時間就得自己補上這道）。
 */
export function refreshDelayMs(expiresAtIso: string | undefined, now = Date.now()): number {
  if (expiresAtIso) {
    const exp = Date.parse(expiresAtIso);
    if (Number.isFinite(exp)) {
      const delay = exp - now - REFRESH_BEFORE_EXPIRY_MS;
      if (delay >= MIN_REFRESH_MS) return Math.min(delay, FALLBACK_REFRESH_MS);
      // 已很接近過期：盡快換，但仍守下限避免熱循環
      return MIN_REFRESH_MS;
    }
  }
  return FALLBACK_REFRESH_MS;
}

/** 一次配對嘗試：paired → resolve(Creds)；auth_error → reject("PAIR_REJECTED")；斷線 → reject("PAIR_CLOSED")。 */
function attempt(
  kind: ConnectorKind,
  serverUrl: string,
  webUrl: string,
  label: string,
  fresh: boolean,
  displayName: string,
  deviceAuthSecret: string,
): Promise<Creds> {
  return new Promise((resolve, reject) => {
    // #380 pairing 幀極小；仍顯式封頂，避免沿用 ws 默認 100MiB。
    const ws = new WebSocket(serverUrl, { handshakeTimeout: 20000, maxPayload: 1 * 1024 * 1024 });
    let seenFirst = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const sendPair = (): void =>
      ws.send(
        JSON.stringify({
          t: "pair_request",
          proto: LINK_B_PROTO,
          label,
          kind,
          ...(process.env.MACCHIATO_PAIR_BATCH ? { batch: process.env.MACCHIATO_PAIR_BATCH } : {}),
        }),
      );
    const clearRefresh = (): void => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    };
    /** #832 按本碼 expiresAt 排程下一次 pair_request（過期前自動換新並重打終端）。 */
    const scheduleRefresh = (expiresAtIso: string | undefined): void => {
      clearRefresh();
      const delay = refreshDelayMs(expiresAtIso);
      refreshTimer = setTimeout(() => {
        if (settled || ws.readyState !== WebSocket.OPEN) return;
        sendPair();
      }, delay);
    };
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearRefresh();
      ws.close();
      fn();
    };

    ws.on("open", () => {
      sendPair();
    });
    ws.on("message", (raw: WebSocket.RawData) => {
      let msg: {
        t?: string;
        code?: string;
        expiresAt?: string;
        reason?: string;
        connectorToken?: string;
        agentLinkId?: string;
      };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.t === "pair_pending") {
        const exp = msg.expiresAt ? new Date(msg.expiresAt) : null;
        showCode(
          msg.code ?? "",
          webUrl,
          fresh || seenFirst,
          displayName,
          deviceAuthSecret,
          exp && Number.isFinite(exp.getTime()) ? exp : null,
        );
        seenFirst = true;
        scheduleRefresh(msg.expiresAt);
      } else if (msg.t === "auth_error") {
        // ⚠️ 回歸契約:scripts/regression/* 以「FAIL:」識別安裝/配對失敗(install.log),改動需同步
        console.error(`FAIL: ${msg.reason}`);
        done(() => reject(new Error("PAIR_REJECTED")));
      } else if (msg.t === "paired" && msg.connectorToken && msg.agentLinkId) {
        // #731 secret 只在**本進程真的把它展示出去過**時才落盤。
        // ⚠️ #388 一碼多綁是**每個 agent 一個獨立進程**（安裝器逐個起 MACCHIATO_PAIR_ONLY=1），
        // 每個進程各自 generateDeviceAuthSecret()。只有首個進程 seenFirst=true、把 `碼.secret`
        // 打給了用戶；其餘進程靜默 paired，它們的 secret **從未被任何人看見**。若照樣落盤，
        // 這些 agent 會 hasDeviceAuth()=true 卻永遠等不到能對上的 proof → wrap 全跳過 →
        // E2E 對它們永久不可用且零提示。故：沒展示過 = 不存 secret = 走降級（同舊配對）。
        const showedSecret = seenFirst;
        const creds: Creds = {
          serverUrl,
          connectorToken: msg.connectorToken,
          agentLinkId: msg.agentLinkId,
          label,
          ...(showedSecret ? { deviceAuthSecret } : {}),
        };
        saveCreds(kind, creds);
        // #388 一碼多綁:沒展示過碼就 paired = 同批安裝免碼自動綁定(server 認 batch)
        if (!seenFirst) {
          console.log(`\n✓ Paired automatically — claimed with the same code as the first agent in this install.`);
          console.log("  (E2E device auth: this agent has no pairing secret — pair it on its own to enable it.)");
        }
        console.log(`\n✓ Paired! agent_link=${msg.agentLinkId}`);
        console.log("  Credentials saved (connector_token shown in plaintext only this once).");
        done(() => resolve(creds));
      }
    });
    ws.on("close", () => done(() => reject(new Error("PAIR_CLOSED"))));
    ws.on("error", () => {
      /* close 隨後觸發 */
    });
  });
}

/** 跑配對, 成功返回憑證（已落盤）。窗口內反覆重連 + 換新碼。 */
export async function runPairing(opts: PairOptions): Promise<Creds> {
  const { kind } = opts;
  const serverUrl = opts.serverUrl || process.env.MACCHIATO_SERVER_URL || DEFAULT_SERVER_URL;
  const webUrl = opts.webUrl || process.env.MACCHIATO_WEB_URL || DEFAULT_WEB_URL;
  const displayName = opts.displayName || DISPLAY_NAME[kind];
  const label = opts.label || process.env.MACCHIATO_LABEL || defaultPairLabel(kind, hostname());
  // #731：整個配對窗口共用一把 secret（換碼不換 secret），避免用戶掃到舊碼 secret 對不上。
  const deviceAuthSecret = generateDeviceAuthSecret();
  const deadline = Date.now() + (opts.windowMs ?? WINDOW_MS);
  let fresh = false;
  let failures = 0;
  while (Date.now() < deadline) {
    console.log(`· connecting to ${serverUrl} …`);
    try {
      return await attempt(kind, serverUrl, webUrl, label, fresh, displayName, deviceAuthSecret);
    } catch (e) {
      if ((e as Error).message === "PAIR_REJECTED") throw new Error("Pairing rejected by server");
      fresh = true;
      // #252 此前 connection-refused 立即重試 = 熱循環(server 不可達時 30 分鐘窗口空轉燒 CPU)。
      // 加指數退避(3s→60s+抖動,同 Link B 重連);窗口剩餘時間不足退避則直接結束。
      failures += 1;
      const wait = backoffMs(failures - 1);
      if (Date.now() + wait >= deadline) break;
      console.error(`· 連接斷開, ${Math.round(wait / 1000)}s 後重連並換新碼…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error("配對窗口超時未認領, 請重跑。");
}
