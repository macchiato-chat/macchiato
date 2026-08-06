/**
 * 健康上報 + 看門狗（對齊 Hermes 連接器）：
 *  - 每 HEALTH_INTERVAL_MS 發 connector_health（server 讀 gatewayAlive/compatOk/mirrorLastPollAgeS/lastError,
 *    據此顯示「在線但降級」）。
 *  - 鏡像 watchdog：poll 停擺超過 MIRROR_STUCK_MS → 重啟鏡像自愈。
 *
 * 形狀對齊 `ConnectorHealthState` core+optional（#492）——不發 Hermes 專屬觀測字段。
 */
import type { ConnectorHealthState } from "./linkb/proto";
import type { LinkBClient } from "./_core/linkb/client";
import type { HeartbeatWriter } from "./_core/heartbeat";
import type { OpenClawGateway } from "./openclaw/gateway";
import type { Drive } from "./openclaw/drive";
import type { Mirror } from "./openclaw/mirror";
import { smokeParseLatest } from "./openclaw/history-import";
import { selfUpdatePendingRestartNotice } from "./_core/selfupdate";

const HEALTH_INTERVAL_MS = Number(process.env.MACCHIATO_HEALTH_INTERVAL_MS) || 60_000;
const MIRROR_STUCK_MS = Number(process.env.MACCHIATO_MIRROR_STUCK_MS) || 120_000;

/** 本連接器 health 上報體 = protocol core + 本家 optional。 */
export interface HealthSnapshot extends ConnectorHealthState {
  kind: "openclaw";
  connectorVersion: string; // §update：server 據此判 updateAvailable（欄位名對齊 protocol）
  /** 本家總是發 number（mirror off → 0）。 */
  mirrorLastPollAgeS: number;
  /** #89：無本地 STT——server 據此把語音輸入直接路由到雲端 BYOK STT（不再下達音頻）。 */
  stt: false;
}

/**
 * #112 依賴的 gateway 方法(hello-ok features.methods 能力位校驗)。注意:sessions.steer 實測可用
 * 但**不在**廣告方法表裡(§18 方案 D,2026-07-11 活測 191 個方法無它)——列入會誤報降級,故排除。
 */
const REQUIRED_METHODS = [
  "chat.send",
  "sessions.list",
  "sessions.preview",
  "sessions.abort",
  "sessions.send",
  "sessions.messages.subscribe",
] as const;

/** #112 深度兼容自檢(對齊 CC checkCompat):協議版本 + 能力位 + transcript 解析冒煙。 */
export function checkCompat(gw: OpenClawGateway): { ok: boolean; reason?: string } {
  const hello = gw.helloOk;
  if (!hello) return { ok: false, reason: "gateway 未完成握手" };
  if (hello.protocol !== 4) return { ok: false, reason: `gateway 協議 v${hello.protocol} ≠ 4` };
  const methods = hello.features?.methods;
  if (Array.isArray(methods)) {
    const missing = REQUIRED_METHODS.filter((m) => !methods.includes(m));
    if (missing.length) return { ok: false, reason: `gateway 缺方法: ${missing.join(", ")}(OpenClaw 升級改了 API?)` };
  }
  return smokeParseLatest();
}

export function buildHealth(gw: OpenClawGateway, mirror: Mirror, version: string, drive?: Drive): HealthSnapshot {
  // #112:compat 失敗原因併入 lastError——app 顯示「降級 + 為什麼」,而非一個沉默的布爾。
  const compat = checkCompat(gw);
  // #3 gateway 連不上時,把「連了多少次」上浮(gatewayAlive=false 只說降級,不說為什麼)。
  const gwDown =
    !gw.isConnected && (gw.reconnectFailures ?? 0) >= 3
      ? `gateway 連續 ${gw.reconnectFailures} 次重連失敗(OpenClaw 沒在跑?)`
      : null;
  // #210 殭屍 gateway(自動更新後未重啟)——最高優先:比「連不上」更可操作。
  const stale = gw.staleInstall ? "OpenClaw 已自動更新,gateway 需重啟(ERR_MODULE_NOT_FOUND)" : null;
  return {
    gatewayAlive: gw.isConnected,
    compatOk: compat.ok,
    // #308 mirror off:輪詢本來就不跑,恆報 0——否則 server 60s 後誤判 degraded、tick 看門狗無限「自愈」。
    mirrorLastPollAgeS: mirror.disabled ? 0 : Math.round((Date.now() - mirror.lastPollAt) / 1000),
    // #773 尾部再兜一句「新版已裝好、等重啟」——僵屍 gateway / gateway 連不上 / 兼容失敗 /
    // 鏡像錯誤都排在它前面,信息位絕不蓋掉真問題(#348 靜默凍結的教訓)。
    lastError:
      stale ??
      gwDown ??
      (compat.ok ? mirror.lastError : (compat.reason ?? "兼容自檢失敗")) ??
      selfUpdatePendingRestartNotice(),
    kind: "openclaw",
    connectorVersion: version,
    stt: false,
    counters: { ...mirror.counters, ...(drive?.counters ?? {}) }, // #10
  };
}

export class HealthLoop {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly gw: OpenClawGateway,
    private readonly linkb: LinkBClient,
    private readonly mirror: Mirror,
    private readonly version: string,
    private readonly drive?: Drive, // #10:重投/驅動錯誤計數來源
    /** #669 本地心跳(自帶時鐘、早於 linkb.start());這裡只餵最新上報體。 */
    private readonly heartbeat?: HeartbeatWriter,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), HEALTH_INTERVAL_MS);
    console.log(`· Health reporting started (${HEALTH_INTERVAL_MS / 1000}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  tick(): void {
    const h = buildHealth(this.gw, this.mirror, this.version, this.drive);
    // 鏡像看門狗：poll 停擺 → 重啟自愈（interval 丟失/異常鏈斷裂等）
    if (h.mirrorLastPollAgeS * 1000 > MIRROR_STUCK_MS) {
      console.error(`⚠️ Mirror poll stalled for ${h.mirrorLastPollAgeS}s → restarting mirror`);
      this.mirror.restart();
      h.lastError = `mirror stuck ${h.mirrorLastPollAgeS}s → restarted`;
    }
    // #669 把最新上報體餵給心跳文件(它自己有時鐘,連不上 server 時照樣寫)。
    // 只擴文件、不擴 wire:下面發出去的 connector_health 形狀一個字節都沒動。
    this.heartbeat?.setSnapshot(h as unknown as Record<string, unknown>);
    if (this.linkb.isReady) {
      this.linkb.send({ t: "connector_health", agentLinkId: this.linkb.agentLinkId, health: h });
    }
  }
}
