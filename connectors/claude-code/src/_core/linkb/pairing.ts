/**
 * Link B 配對（design.md §5）：把這台機綁到你的 Macchiato 帳戶。
 *   開 WS → pair_request → server 回一次性 code（打印）→ 你在 web 輸入 → server 回 paired（長期憑證）。
 * #252 重連指數退避(3s→60s+抖動)。kind / displayName / default label 由呼叫方注入。
 */
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import WebSocket from "ws";
import { LINK_B_PROTO } from "../../linkb/proto";
import { backoffMs } from "../backoff";
import {
  type ConnectorKind,
  DISPLAY_NAME,
  defaultPairLabel,
} from "../identity";
import { type Creds, DEFAULT_SERVER_URL, DEFAULT_WEB_URL, saveCreds } from "./creds";

const REFRESH_MS = (6 * 60 + 30) * 1000; // 趕在 server 8-min code TTL 前換新
const WINDOW_MS = 30 * 60 * 1000; // 整體配對窗口

export interface PairOptions {
  kind: ConnectorKind;
  serverUrl?: string;
  webUrl?: string;
  label?: string;
  windowMs?: number;
  /** 覆蓋 DISPLAY_NAME / MACCHIATO_PAIR_GROUP（測試用）。 */
  displayName?: string;
}

function showCode(code: string, webUrl: string, fresh: boolean, displayName: string): void {
  const line = "=".repeat(54);
  console.log(`\n${line}`);
  // ⚠️ 回歸契約:scripts/regression/* 與 run-folders-e2e.mjs 斷言「>>> <碼> <<<」
  // (folders-e2e 還靠上行「code」字樣定位),改動需同步
  const who = process.env.MACCHIATO_PAIR_GROUP || displayName;
  console.log(`  Pairing code for ${who}${fresh ? " (refreshed)" : ""}:`);
  console.log(`        >>>  ${code}  <<<`);
  console.log(`  Sign in at ${webUrl} → \"Pair connector\" → enter this code.`);
  // #388 一碼多綁:同批安裝的其餘 agent 免碼自動綁定(安裝器設 MACCHIATO_PAIR_BATCH_MANY)
  if (process.env.MACCHIATO_PAIR_BATCH && process.env.MACCHIATO_PAIR_BATCH_MANY) {
    console.log("  Other agents from this install will pair automatically with this code.");
  }
  // #388 終端 QR(可選增強):qrencode 在則打 ANSI 碼——iOS app 的掃碼配對直接掃終端。
  try {
    const qr = spawnSync("qrencode", ["-t", "ANSIUTF8", "-m", "2", code], { encoding: "utf8", timeout: 3000 });
    if (qr.status === 0 && qr.stdout) console.log(`\n${qr.stdout}  (scan with the Macchiato iOS app)`);
  } catch {
    /* 無 qrencode / 失敗:純視覺增強,靜默跳過 */
  }
  console.log(`${line}\nWaiting for you to claim it…`);
}

/** 一次配對嘗試：paired → resolve(Creds)；auth_error → reject("PAIR_REJECTED")；斷線 → reject("PAIR_CLOSED")。 */
function attempt(
  kind: ConnectorKind,
  serverUrl: string,
  webUrl: string,
  label: string,
  fresh: boolean,
  displayName: string,
): Promise<Creds> {
  return new Promise((resolve, reject) => {
    // #380 pairing 幀極小；仍顯式封頂，避免沿用 ws 默認 100MiB。
    const ws = new WebSocket(serverUrl, { handshakeTimeout: 20000, maxPayload: 1 * 1024 * 1024 });
    let seenFirst = false;
    let refresher: ReturnType<typeof setInterval> | null = null;
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
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (refresher) clearInterval(refresher);
      ws.close();
      fn();
    };

    ws.on("open", () => {
      sendPair();
      refresher = setInterval(sendPair, REFRESH_MS);
    });
    ws.on("message", (raw: WebSocket.RawData) => {
      let msg: { t?: string; code?: string; reason?: string; connectorToken?: string; agentLinkId?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.t === "pair_pending") {
        showCode(msg.code ?? "", webUrl, fresh || seenFirst, displayName);
        seenFirst = true;
      } else if (msg.t === "auth_error") {
        // ⚠️ 回歸契約:scripts/regression/* 以「FAIL:」識別安裝/配對失敗(install.log),改動需同步
        console.error(`FAIL: ${msg.reason}`);
        done(() => reject(new Error("PAIR_REJECTED")));
      } else if (msg.t === "paired" && msg.connectorToken && msg.agentLinkId) {
        const creds: Creds = { serverUrl, connectorToken: msg.connectorToken, agentLinkId: msg.agentLinkId, label };
        saveCreds(kind, creds);
        // #388 一碼多綁:沒展示過碼就 paired = 同批安裝免碼自動綁定(server 認 batch)
        if (!seenFirst) console.log(`\n✓ Paired automatically — claimed with the same code as the first agent in this install.`);
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
  const deadline = Date.now() + (opts.windowMs ?? WINDOW_MS);
  let fresh = false;
  let failures = 0;
  while (Date.now() < deadline) {
    console.log(`· connecting to ${serverUrl} …`);
    try {
      return await attempt(kind, serverUrl, webUrl, label, fresh, displayName);
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
