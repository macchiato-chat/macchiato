import { describe, it, expect } from "vitest";
import { buildHealth, HealthLoop } from "../src/health";

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
