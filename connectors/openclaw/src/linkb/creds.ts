/**
 * Link B 憑證：配對後拿到的 connector_token + agentLinkId, 存 ~/.macchiato/openclaw-connector.json。
 * 與 Hermes 連接器的 connector.json **分開**——OpenClaw 是另一個獨立配對的連接器。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Creds {
  serverUrl: string;
  connectorToken: string;
  agentLinkId: string;
  label?: string;
}

export const DEFAULT_SERVER_URL = "wss://api.macchiato.chat/connector";
export const DEFAULT_WEB_URL = "https://macchiato.chat";

/** 憑證文件路徑（每次讀 env, 便於測試覆蓋）。 */
export function credPath(): string {
  return process.env.MACCHIATO_OPENCLAW_CRED || join(homedir(), ".macchiato/openclaw-connector.json");
}

function serverUrl(fromFile?: string): string {
  return process.env.MACCHIATO_SERVER_URL || fromFile || DEFAULT_SERVER_URL;
}

/** 讀憑證；未配對返回 null。token/agentLinkId 只認憑證文件（避免與 Hermes 的環境變量撞）。 */
export function loadCreds(): Creds | null {
  const p = credPath();
  if (!existsSync(p)) return null;
  const c = JSON.parse(readFileSync(p, "utf8")) as Partial<Creds>;
  if (!c.connectorToken || !c.agentLinkId) return null;
  return {
    serverUrl: serverUrl(c.serverUrl),
    connectorToken: c.connectorToken,
    agentLinkId: c.agentLinkId,
    label: c.label,
  };
}

/** 寫憑證（0600）。#254:tmp 先建 0600 再 chmod 再 rename——消除「先寫 0644 後 chmod」的窗口
 * (含 connector_token 的文件在 chmod 前世界可讀),照 e2e/keys.ts 原子模式。 */
export function saveCreds(c: Creds): void {
  const p = credPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600); // umask 可能削弱 create mode → 顯式收緊
  renameSync(tmp, p);
}
