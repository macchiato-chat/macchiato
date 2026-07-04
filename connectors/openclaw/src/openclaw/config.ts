/**
 * OpenClaw gateway 連接配置：從 ~/.openclaw 解析 url + token（含 SecretRef）。
 * 可被環境變量覆蓋（OPENCLAW_GATEWAY_URL / OPENCLAW_GATEWAY_TOKEN / OPENCLAW_GATEWAY_PORT）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GatewayConfig {
  url: string;
  token: string;
}

function openclawHome(): string {
  return process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
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
  return undefined;
}

export function resolveGatewayConfig(): GatewayConfig {
  const home = openclawHome();
  const cfg = JSON.parse(readFileSync(join(home, "openclaw.json"), "utf8"));
  const port = process.env.OPENCLAW_GATEWAY_PORT || cfg.gateway?.port || 18789;
  const url = process.env.OPENCLAW_GATEWAY_URL || `ws://127.0.0.1:${port}`;
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || resolveSecret(cfg.gateway?.auth?.token, home);
  if (!token) {
    throw new Error("Could not resolve the OpenClaw gateway token (check the SecretRef in ~/.openclaw or set OPENCLAW_GATEWAY_TOKEN)");
  }
  return { url, token };
}
