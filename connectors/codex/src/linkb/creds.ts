/**
 * Link B 憑證：配對後拿到的 connector_token + agentLinkId, 存 ~/.macchiato/codex-connector.json。
 * 每個連接器獨立配對,憑證各自分開(hermes/openclaw/claude-code/codex)。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  return process.env.MACCHIATO_CODEX_CRED || join(homedir(), ".macchiato/codex-connector.json");
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

/** 寫憑證（0600）。 */
export function saveCreds(c: Creds): void {
  const p = credPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(c, null, 2));
  chmodSync(p, 0o600);
}
