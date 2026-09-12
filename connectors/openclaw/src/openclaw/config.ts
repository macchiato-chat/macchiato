/**
 * OpenClaw gateway 連接配置：從 ~/.openclaw 解析 url + token（含 SecretRef）。
 * 可被環境變量覆蓋（OPENCLAW_GATEWAY_URL / OPENCLAW_GATEWAY_TOKEN / OPENCLAW_GATEWAY_PORT）。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require_ = createRequire(import.meta.url);

export interface GatewayConfig {
  url: string;
  token: string;
}

function openclawHome(): string {
  return process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
}

/**
 * #1030 OpenClaw 2.0 新裝把 gateway token 寫進 sqlite secret store：
 * {source:"store", id:"OPENCLAW_GATEWAY_TOKEN"} → state/openclaw.sqlite 的
 * secret_store_entries，上游契約（resolveStoreRefs → readSecretStoreValue）＝
 * scope_kind='team'、scope_id=''、按 name 取未刪除行的明文 value。
 * 用 node:sqlite（Node ≥22.5 內建）零新依賴；讀不了（老 Node / 檔缺 / 表缺）返回
 * undefined，落回既有的報錯與 OPENCLAW_GATEWAY_TOKEN env 逃生門。
 */
function readStoreSecret(home: string, name: string): string | undefined {
  let DatabaseSync: new (
    path: string,
    opts: { readOnly: boolean },
  ) => {
    prepare(sql: string): { get(...args: unknown[]): { value?: unknown } | undefined };
    close(): void;
  };
  try {
    ({ DatabaseSync } = require_("node:sqlite"));
  } catch {
    return undefined;
  }
  try {
    const db = new DatabaseSync(join(home, "state", "openclaw.sqlite"), { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT value FROM secret_store_entries WHERE scope_kind = 'team' AND scope_id = '' AND name = ? AND deleted_at_ms IS NULL",
        )
        .get(name);
      return typeof row?.value === "string" ? row.value : undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/** 解析 OpenClaw SecretRef：{source:"file", id:"/gateway/authToken"} → 沿 id 路徑取 secrets.json 的值。 */
function resolveSecret(ref: unknown, home: string): string | undefined {
  if (typeof ref === "string") return ref;
  if (ref && typeof ref === "object" && (ref as { source?: string }).source === "file") {
    const id = (ref as { id: string }).id; // e.g. "/gateway/authToken"
    const secrets = JSON.parse(readFileSync(join(home, "secrets.json"), "utf8"));
    return id
      .split("/")
      .filter(Boolean)
      .reduce<unknown>((o, k) => (o == null ? o : (o as Record<string, unknown>)[k]), secrets) as
      | string
      | undefined;
  }
  if (ref && typeof ref === "object" && (ref as { source?: string }).source === "store") {
    const id = (ref as { id?: string }).id; // e.g. "OPENCLAW_GATEWAY_TOKEN"
    return id ? readStoreSecret(home, id) : undefined;
  }
  return undefined;
}

export function resolveGatewayConfig(): GatewayConfig {
  const home = openclawHome();
  const cfg = JSON.parse(readFileSync(join(home, "openclaw.json"), "utf8"));
  const port = process.env.OPENCLAW_GATEWAY_PORT || cfg.gateway?.port || 18789;
  const url = process.env.OPENCLAW_GATEWAY_URL || `ws://127.0.0.1:${port}`;
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || resolveSecret(cfg.gateway?.auth?.token, home);
  if (!token) {
    throw new Error(
      "Could not resolve the OpenClaw gateway token (checked the SecretRef in openclaw.json against secrets.json / state/openclaw.sqlite; set OPENCLAW_GATEWAY_TOKEN to override)",
    );
  }
  return { url, token };
}
