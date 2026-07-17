/**
 * 健康上報 + 鏡像看門狗（對齊 Hermes/OpenClaw 連接器）。
 * Claude Code 無常駐 gateway（SDK 按需 spawn CLI）→ gatewayAlive = transcript 目錄可讀 + CLI 在位。
 */
import { gcAttachments } from "./cc/attachments";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { LinkBClient } from "./linkb/client";
import type { Drive } from "./cc/drive";
import type { Mirror } from "./cc/mirror";
import { projectsDir } from "./cc/transcripts";
import { checkCompat } from "./cc/compat";
import { resolveClaudeBin } from "./cc/claude-bin";

const HEALTH_INTERVAL_MS = Number(process.env.MACCHIATO_HEALTH_INTERVAL_MS) || 60_000;
const MIRROR_STUCK_MS = Number(process.env.MACCHIATO_MIRROR_STUCK_MS) || 120_000;
/** #259 CLI 版本重探節流:CLI 自動升級後不能永遠用啟動時的舊值(env 可調)。 */
const CLI_REPROBE_MS = Number(process.env.MACCHIATO_CLI_REPROBE_MS) || 3_600_000;

export interface HealthSnapshot {
  gatewayAlive: boolean;
  compatOk: boolean;
  mirrorLastPollAgeS: number;
  lastError: string | null;
  kind: "claude-code";
  connectorVersion: string;
  /** #89：無本地 STT——server 據此把語音輸入直接路由到雲端 BYOK STT（不再下達音頻）。 */
  stt: false;
  cliVersion?: string;
  /** #10:累計計數(進程生命週期)——鏡像條數/nack/驅動錯誤,一次性的丟/重複才看得見。 */
  counters?: Record<string, number>;
}

export class HealthLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cliVersion: string | undefined;
  private cliFound = false;
  private lastProbeAt = 0;

  constructor(
    private readonly linkb: LinkBClient,
    private readonly mirror: Mirror,
    private readonly version: string,
    private readonly drive?: Drive, // #10:驅動錯誤計數來源
  ) {}

  start(): void {
    this.probeCli();
    this.timer = setInterval(() => this.tick(), HEALTH_INTERVAL_MS);
    console.log(`· Health reporting started (${HEALTH_INTERVAL_MS / 1000}s)`);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private probeCli(): void {
    this.lastProbeAt = Date.now();
    // 用解析出的絕對路徑,不靠進程 PATH(systemd 服務常缺 ~/.local/bin → 誤報降級)。
    execFile(resolveClaudeBin(), ["--version"], { timeout: 15_000 }, (err, stdout) => {
      if (!err) {
        this.cliFound = true;
        this.cliVersion = stdout.trim().split(/\s+/)[0]; // "2.1.201 (Claude Code)" → "2.1.201"
      } else {
        console.error(`[health] claude --version 失敗(${resolveClaudeBin()}): ${err.message}`);
      }
    });
  }

  tick(): void {
    gcAttachments(); // #151 入站附件 TTL GC(節流在函數內)
    if (Date.now() - this.lastProbeAt >= CLI_REPROBE_MS) this.probeCli(); // #259 CLI 升級後重探版本
    const ageS = Math.round((Date.now() - this.mirror.lastPollAt) / 1000);
    // #76 兼容自檢:版本門檻 + 最新 transcript 解析冒煙。不兼容 → compatOk=false(app 顯示降級),
    // 並把原因併入 lastError,別讓 CLI 升級悄悄破壞解析後靜默丟消息。
    const compat = checkCompat(this.cliVersion);
    const h: HealthSnapshot = {
      gatewayAlive: this.cliFound && existsSync(projectsDir()),
      compatOk: this.cliFound && compat.ok,
      mirrorLastPollAgeS: ageS,
      lastError: compat.ok ? this.mirror.lastError : (compat.reason ?? "兼容自檢失敗"),
      kind: "claude-code",
      connectorVersion: this.version,
      stt: false,
      ...(this.cliVersion ? { cliVersion: this.cliVersion } : {}),
      counters: { ...this.mirror.counters, ...(this.drive?.counters ?? {}) }, // #10
    };
    if (ageS * 1000 > MIRROR_STUCK_MS) {
      console.error(`⚠️ Mirror poll stalled for ${ageS}s → restarting mirror`);
      this.mirror.restart();
      h.lastError = `mirror stuck ${ageS}s → restarted`;
    }
    if (this.linkb.isReady) {
      this.linkb.send({ t: "connector_health", agentLinkId: this.linkb.agentLinkId, health: h });
    }
  }
}
