/**
 * Link B 憑證：配對後拿到的 connector_token + agentLinkId。
 * 路徑按 ConnectorKind 分開（~/.macchiato/<kind>-connector.json），互不覆蓋。
 * #248 fail-safe 解析 + #254 原子 tmp+chmod+rename。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type ConnectorKind, credPath } from "../identity";

export interface Creds {
  serverUrl: string;
  connectorToken: string;
  agentLinkId: string;
  label?: string;
}

export const DEFAULT_SERVER_URL = "wss://api.macchiato.chat/connector";
export const DEFAULT_WEB_URL = "https://macchiato.chat";

function serverUrl(fromFile?: string): string {
  return process.env.MACCHIATO_SERVER_URL || fromFile || DEFAULT_SERVER_URL;
}

/** 讀憑證；未配對返回 null。token/agentLinkId 只認憑證文件。 */
export function loadCreds(kind: ConnectorKind): Creds | null {
  const p = credPath(kind);
  if (!existsSync(p)) return null;
  // #248 此前裸 JSON.parse:壞 JSON 拋到 main → process.exit(1) → systemd 無限崩潰循環。
  // 改為 fail-safe:壞檔視為「未配對」返回 null(引導重新配對),不崩服務。
  let c: Partial<Creds>;
  try {
    c = JSON.parse(readFileSync(p, "utf8")) as Partial<Creds>;
  } catch (e) {
    console.error(`[creds] ${p} 損壞(${(e as Error).message})→ 視為未配對,請重新配對`);
    return null;
  }
  if (!c.connectorToken || !c.agentLinkId) return null;
  return {
    serverUrl: serverUrl(c.serverUrl),
    connectorToken: c.connectorToken,
    agentLinkId: c.agentLinkId,
    label: c.label,
  };
}

/** #387 app 解綁後隔離憑證:改名 .revoked(留痕)。服務被 supervisor 拉起時因無憑證進入
 * 等待配對,不再拿死 token 空轉;重跑安裝命令即重新配對。返回隔離後路徑(無憑證/失敗 null)。 */
export function quarantineCreds(kind: ConnectorKind): string | null {
  const p = credPath(kind);
  if (!existsSync(p)) return null;
  const q = p + ".revoked";
  try {
    renameSync(p, q);
    return q;
  } catch {
    return null;
  }
}

/** 寫憑證（0600）。#248/#254:tmp 先建 0600 再 chmod 再 rename——消除「先寫 0644 後 chmod」的
 * 窗口(含 connector_token 的文件在 chmod 前世界可讀),照 e2e/keys.ts 原子模式。 */
export function saveCreds(kind: ConnectorKind, c: Creds): void {
  const p = credPath(kind);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600); // umask 可能削弱 create mode → 顯式收緊
  renameSync(tmp, p);
}
