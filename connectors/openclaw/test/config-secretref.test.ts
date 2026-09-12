import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGatewayConfig } from "../src/openclaw/config";

// vite 5 的 builtin 名單早於 node:sqlite——跟源碼同款走 createRequire，繞過打包解析。
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

/**
 * #1030 SecretRef 解析：file（既有）與 store（OpenClaw 2.0 新裝）兩條路。
 * store 契約對照上游 readSecretStoreValue：state/openclaw.sqlite 的
 * secret_store_entries，scope_kind='team'、scope_id=''、deleted_at_ms IS NULL。
 */
describe("resolveGatewayConfig SecretRef", () => {
  let home: string;

  function writeConfig(token: unknown) {
    writeFileSync(join(home, "openclaw.json"), JSON.stringify({ gateway: { port: 19999, auth: { token } } }));
  }

  function seedStore(rows: Array<{ name: string; value: string; scopeKind?: string; scopeId?: string; deleted?: boolean }>) {
    mkdirSync(join(home, "state"), { recursive: true });
    const db = new DatabaseSync(join(home, "state", "openclaw.sqlite"));
    db.exec(`CREATE TABLE IF NOT EXISTS secret_store_entries (
      scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, name TEXT NOT NULL,
      value TEXT NOT NULL, kind TEXT, created_at_ms INTEGER, updated_at_ms INTEGER,
      updated_by TEXT, deleted_at_ms INTEGER, allowed_hosts TEXT)`);
    const ins = db.prepare(
      "INSERT INTO secret_store_entries (scope_kind, scope_id, name, value, kind, deleted_at_ms) VALUES (?, ?, ?, ?, 'secret', ?)",
    );
    for (const r of rows) ins.run(r.scopeKind ?? "team", r.scopeId ?? "", r.name, r.value, r.deleted ? Date.now() : null);
    db.close();
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "occ-cfg-"));
    process.env.OPENCLAW_STATE_DIR = home;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_PORT;
  });
  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    rmSync(home, { recursive: true, force: true });
  });

  it("字面量 token 原樣返回", () => {
    writeConfig("tok-literal");
    expect(resolveGatewayConfig().token).toBe("tok-literal");
  });

  it("file SecretRef 沿 id 路徑取 secrets.json（既有行為不回歸）", () => {
    writeConfig({ source: "file", id: "/gateway/authToken" });
    writeFileSync(join(home, "secrets.json"), JSON.stringify({ gateway: { authToken: "tok-file" } }));
    expect(resolveGatewayConfig().token).toBe("tok-file");
  });

  it("store SecretRef 從 state/openclaw.sqlite 取值（2.0 新裝）", () => {
    writeConfig({ source: "store", id: "OPENCLAW_GATEWAY_TOKEN" });
    seedStore([{ name: "OPENCLAW_GATEWAY_TOKEN", value: "tok-store" }]);
    expect(resolveGatewayConfig().token).toBe("tok-store");
  });

  it("store：只認 team/'' 作用域的未刪除行", () => {
    writeConfig({ source: "store", id: "OPENCLAW_GATEWAY_TOKEN" });
    seedStore([
      { name: "OPENCLAW_GATEWAY_TOKEN", value: "tok-dead", deleted: true },
      { name: "OPENCLAW_GATEWAY_TOKEN", value: "tok-other-scope", scopeKind: "identity", scopeId: "u1" },
    ]);
    expect(() => resolveGatewayConfig()).toThrow(/gateway token/);
  });

  it("store：sqlite 不存在 → 報既有錯誤而不是崩", () => {
    writeConfig({ source: "store", id: "OPENCLAW_GATEWAY_TOKEN" });
    expect(() => resolveGatewayConfig()).toThrow(/OPENCLAW_GATEWAY_TOKEN/);
  });

  it("env OPENCLAW_GATEWAY_TOKEN 永遠優先", () => {
    writeConfig({ source: "store", id: "OPENCLAW_GATEWAY_TOKEN" });
    process.env.OPENCLAW_GATEWAY_TOKEN = "tok-env";
    expect(resolveGatewayConfig().token).toBe("tok-env");
  });
});
