/**
 * 健康上報 + 看門狗（對齊 Hermes 連接器）：
 *  - 每 HEALTH_INTERVAL_MS 發 connector_health（server 讀 gatewayAlive/compatOk/mirrorLastPollAgeS/lastError, 
 *    據此顯示「在線但降級」）。
 *  - 鏡像 watchdog：poll 停擺超過 MIRROR_STUCK_MS → 重啟鏡像自愈。
 */
import type { LinkBClient } from "./linkb/client";
import type { OpenClawGateway } from "./openclaw/gateway";
import type { Mirror } from "./openclaw/mirror";

const HEALTH_INTERVAL_MS = Number(process.env.MACCHIATO_HEALTH_INTERVAL_MS) || 60_000;
const MIRROR_STUCK_MS = Number(process.env.MACCHIATO_MIRROR_STUCK_MS) || 120_000;

export interface HealthSnapshot {
  gatewayAlive: boolean;
  compatOk: boolean;
  mirrorLastPollAgeS: number;
  lastError: string | null;
  kind: "openclaw";
  version: string;
}

export function buildHealth(gw: OpenClawGateway, mirror: Mirror, version: string): HealthSnapshot {
  return {
    gatewayAlive: gw.isConnected,
    compatOk: gw.helloOk?.protocol === 4, // 握手協議版本 = 兼容性信號
    mirrorLastPollAgeS: Math.round((Date.now() - mirror.lastPollAt) / 1000),
    lastError: mirror.lastError,
    kind: "openclaw",
    version,
  };
}

export class HealthLoop {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly gw: OpenClawGateway,
    private readonly linkb: LinkBClient,
    private readonly mirror: Mirror,
    private readonly version: string,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), HEALTH_INTERVAL_MS);
    console.log(`· Health reporting started (${HEALTH_INTERVAL_MS / 1000}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  tick(): void {
    const h = buildHealth(this.gw, this.mirror, this.version);
    // 鏡像看門狗：poll 停擺 → 重啟自愈（interval 丟失/異常鏈斷裂等）
    if (h.mirrorLastPollAgeS * 1000 > MIRROR_STUCK_MS) {
      console.error(`⚠️ Mirror poll stalled for ${h.mirrorLastPollAgeS}s → restarting mirror`);
      this.mirror.restart();
      h.lastError = `mirror stuck ${h.mirrorLastPollAgeS}s → restarted`;
    }
    if (this.linkb.isReady) {
      this.linkb.send({ t: "connector_health", agentLinkId: this.linkb.agentLinkId, health: h });
    }
  }
}
