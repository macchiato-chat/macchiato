/**
 * Link B 配對（design.md §5）：把這台機綁到你的 Macchiato 帳戶。
 *   開 WS → pair_request → server 回一次性 code（打印）→ 你在 web 輸入 → server 回 paired（長期憑證）。
 * socket 要保活到認領；server code ~8min TTL, 故定期換新碼；斷線則重連換新。照搬 hermes-connector/pair.py。
 */
import { hostname } from "node:os";
import WebSocket from "ws";
import { LINK_B_PROTO } from "./proto";
import { backoffMs } from "../backoff";
import { type Creds, DEFAULT_SERVER_URL, DEFAULT_WEB_URL, saveCreds } from "./creds";

const REFRESH_MS = (6 * 60 + 30) * 1000; // 趕在 server 8-min code TTL 前換新
const WINDOW_MS = 30 * 60 * 1000; // 整體配對窗口

export interface PairOptions {
  serverUrl?: string;
  webUrl?: string;
  label?: string;
  windowMs?: number;
}

function showCode(code: string, webUrl: string, fresh: boolean): void {
  const line = "=".repeat(54);
  console.log(`\n${line}`);
  // ⚠️ 回歸契約:scripts/regression/run-regression.mjs 從 install.log 斷言「>>> <碼> <<<」,改動需同步
  console.log(`  Pairing code for OpenClaw${fresh ? " (refreshed)" : ""}:`);
  console.log(`        >>>  ${code}  <<<`);
  console.log(`  Sign in at ${webUrl} → \"Pair connector\" → enter this code.`);
  // #388 一碼多綁:同批安裝的其餘 agent 免碼自動綁定(安裝器設 MACCHIATO_PAIR_BATCH_MANY)
  if (process.env.MACCHIATO_PAIR_BATCH && process.env.MACCHIATO_PAIR_BATCH_MANY) {
    console.log("  Other agents from this install will pair automatically with this code.");
  }
  console.log(`${line}\nWaiting for you to claim it…`);
}

/** 一次配對嘗試：paired → resolve(Creds)；auth_error → reject("PAIR_REJECTED")；斷線 → reject("PAIR_CLOSED")。 */
function attempt(serverUrl: string, webUrl: string, label: string, fresh: boolean): Promise<Creds> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(serverUrl, { handshakeTimeout: 20000 });
    let seenFirst = false;
    let refresher: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    const sendPair = (): void => ws.send(JSON.stringify({ t: "pair_request", proto: LINK_B_PROTO, label, kind: "openclaw", ...(process.env.MACCHIATO_PAIR_BATCH ? { batch: process.env.MACCHIATO_PAIR_BATCH } : {}) }));
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
        showCode(msg.code ?? "", webUrl, fresh || seenFirst);
        seenFirst = true;
      } else if (msg.t === "auth_error") {
        // ⚠️ 回歸契約:scripts/regression/run-regression.mjs 以「FAIL:」識別安裝/配對失敗(install.log),改動需同步
        console.error(`FAIL: ${msg.reason}`);
        done(() => reject(new Error("PAIR_REJECTED")));
      } else if (msg.t === "paired" && msg.connectorToken && msg.agentLinkId) {
        const creds: Creds = { serverUrl, connectorToken: msg.connectorToken, agentLinkId: msg.agentLinkId, label };
        saveCreds(creds);
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
export async function runPairing(opts: PairOptions = {}): Promise<Creds> {
  const serverUrl = opts.serverUrl || process.env.MACCHIATO_SERVER_URL || DEFAULT_SERVER_URL;
  const webUrl = opts.webUrl || process.env.MACCHIATO_WEB_URL || DEFAULT_WEB_URL;
  const label = opts.label || process.env.MACCHIATO_LABEL || `OpenClaw (${hostname()})`;
  const deadline = Date.now() + (opts.windowMs ?? WINDOW_MS);
  let fresh = false;
  let failures = 0;
  while (Date.now() < deadline) {
    console.log(`· connecting to ${serverUrl} …`);
    try {
      return await attempt(serverUrl, webUrl, label, fresh);
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
