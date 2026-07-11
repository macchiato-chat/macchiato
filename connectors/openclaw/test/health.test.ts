import { beforeEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHealth, checkCompat, HealthLoop } from "../src/health";
import { smokeParseLatest } from "../src/openclaw/history-import";

// #112:冒煙讀 OPENCLAW_STATE_DIR——測試一律隔離到臨時目錄,不碰真機 ~/.openclaw
function freshStateDir(): string {
  const d = mkdtempSync(join(tmpdir(), "oc-health-"));
  mkdirSync(join(d, "agents/main/sessions"), { recursive: true });
  process.env.OPENCLAW_STATE_DIR = d;
  return join(d, "agents/main/sessions");
}
beforeEach(() => void freshStateDir());

function fakes(pollAgeMs: number, gwConnected = true) {
  const gw: any = { isConnected: gwConnected, helloOk: { protocol: 4 } };
  const mirror: any = { lastPollAt: Date.now() - pollAgeMs, lastError: null, restarted: 0, restart() { this.restarted++; } };
  const sent: any[] = [];
  const linkb: any = { isReady: true, agentLinkId: "al1", send: (m: any) => sent.push(m) };
  return { gw, mirror, linkb, sent };
}

describe("health（上報 + 看門狗）", () => {
  it("buildHealth：字段對齊 server 期望（gatewayAlive/compatOk/mirrorLastPollAgeS/lastError）", () => {
    const { gw, mirror } = fakes(3000);
    const h = buildHealth(gw, mirror, "0.1.0");
    expect(h.gatewayAlive).toBe(true);
    expect(h.compatOk).toBe(true);
    expect(h.mirrorLastPollAgeS).toBeGreaterThanOrEqual(3);
    expect(h.kind).toBe("openclaw");
  });

  it("tick：正常 → 發 connector_health、不重啟", () => {
    const { gw, mirror, linkb, sent } = fakes(2000);
    new HealthLoop(gw, linkb, mirror, "0.1.0").tick();
    expect(sent[0].t).toBe("connector_health");
    expect(sent[0].health.gatewayAlive).toBe(true);
    expect(mirror.restarted).toBe(0);
  });

  it("tick：鏡像停擺 > 閾值 → 重啟自愈 + lastError 標記", () => {
    const { gw, mirror, linkb, sent } = fakes(300_000);
    new HealthLoop(gw, linkb, mirror, "0.1.0").tick();
    expect(mirror.restarted).toBe(1);
    expect(sent[0].health.lastError).toMatch(/mirror stuck/);
  });

  it("gateway 斷開 → gatewayAlive=false（server 顯示降級）", () => {
    const { gw, mirror, linkb, sent } = fakes(1000, false);
    new HealthLoop(gw, linkb, mirror, "0.1.0").tick();
    expect(sent[0].health.gatewayAlive).toBe(false);
  });
});

describe("#112 深度兼容自檢", () => {
  const FULL_METHODS = ["chat.send", "sessions.list", "sessions.preview", "sessions.abort", "sessions.send", "sessions.messages.subscribe"];

  it("checkCompat:未握手/協議不對/缺方法 → 失敗且 reason 說清為什麼", () => {
    expect(checkCompat({ helloOk: null } as any)).toMatchObject({ ok: false, reason: expect.stringContaining("握手") });
    expect(checkCompat({ helloOk: { protocol: 3 } } as any)).toMatchObject({ ok: false, reason: expect.stringContaining("v3") });
    const missing = checkCompat({ helloOk: { protocol: 4, features: { methods: FULL_METHODS.filter((m) => m !== "chat.send") } } } as any);
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain("chat.send");
  });

  it("checkCompat:方法齊全(或 hello 無方法表)→ 通過;sessions.steer 不要求(廣告表裡本就沒有)", () => {
    expect(checkCompat({ helloOk: { protocol: 4, features: { methods: FULL_METHODS } } } as any).ok).toBe(true);
    expect(checkCompat({ helloOk: { protocol: 4 } } as any).ok).toBe(true); // 無方法表 → 不誤報
  });

  it("smokeParseLatest:無文件/空文件 → 通過;正常 transcript → 通過;非空但解析零產出 → 降級", () => {
    const sdir = freshStateDir();
    expect(smokeParseLatest().ok).toBe(true); // 無文件
    writeFileSync(join(sdir, "empty.jsonl"), "");
    expect(smokeParseLatest().ok).toBe(true); // 空文件
    writeFileSync(join(sdir, "good.jsonl"), JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "問題" }], timestamp: 1 } }) + "\n");
    expect(smokeParseLatest().ok).toBe(true); // 正常格式
    const sdir2 = freshStateDir();
    writeFileSync(join(sdir2, "drift.jsonl"), JSON.stringify({ type: "totally_new_format", data: { blah: 1 } }) + "\n");
    const r = smokeParseLatest();
    expect(r.ok).toBe(false); // 非空但零產出 = 格式漂移
    expect(r.reason).toContain("drift.jsonl");
  });

  it("buildHealth:compat 失敗 → compatOk=false 且 lastError 帶原因(app 顯示降級+為什麼)", () => {
    const { mirror } = fakes(1000);
    const gw: any = { isConnected: true, helloOk: { protocol: 4, features: { methods: ["sessions.list"] } } };
    const h = buildHealth(gw, mirror, "0.1.0");
    expect(h.compatOk).toBe(false);
    expect(h.lastError).toContain("缺方法");
  });

  it("#3 gateway 連不上 ≥3 次 → lastError 上浮重連失敗次數;連著不誤報", () => {
    const { mirror } = fakes(1000);
    const gw: any = { isConnected: false, helloOk: { protocol: 4 }, reconnectFailures: 7 };
    const h = buildHealth(gw, mirror, "0.1.0");
    expect(h.gatewayAlive).toBe(false);
    expect(h.lastError).toContain("7 次重連失敗");
    const gw2: any = { isConnected: true, helloOk: { protocol: 4 }, reconnectFailures: 7 };
    expect(buildHealth(gw2, mirror, "0.1.0").lastError).toBeNull();
  });
});
