import { describe, it, expect } from "vitest";
import { OpenClawGateway } from "../src/openclaw/gateway";
import { resolveGatewayConfig, type GatewayConfig } from "../src/openclaw/config";

/**
 * 集成測試：對**真 OpenClaw gateway**（只讀：握手 + sessions.list）。
 * 無 OpenClaw 配置 / gateway 不可達 → 優雅跳過（不讓 CI 紅）。
 */
let cfg: GatewayConfig | null = null;
try {
  cfg = resolveGatewayConfig();
} catch {
  cfg = null;
}

describe("OpenClawGateway（對真 gateway，只讀）", () => {
  it.skipIf(!cfg)("握手 + sessions.list（gateway 在跑才驗）", async () => {
    const gw = new OpenClawGateway(cfg!);
    const connected = await Promise.race([
      gw.start().then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
    ]);
    if (!connected) {
      gw.close();
      console.warn("OpenClaw gateway 不可達 → 跳過集成斷言");
      return;
    }
    try {
      expect(gw.helloOk?.protocol).toBe(4);
      expect(gw.helloOk?.features?.methods).toContain("sessions.list");
      const r = await gw.sessionsList();
      expect(Array.isArray(r.sessions)).toBe(true);
    } finally {
      gw.close();
    }
  });
});
