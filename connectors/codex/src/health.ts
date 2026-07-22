/**
 * 健康上報 + 鏡像看門狗（對齊 Hermes/OpenClaw 連接器）。
 * Codex 無常駐 gateway（每回合 spawn codex exec）→ gatewayAlive = sessions 目錄可讀 + CLI 在位。
 */
import { gcAttachments } from "./codex/attachments";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { LinkBClient } from "./linkb/client";
import type { Mirror } from "./codex/mirror";
import { sessionsRoot } from "./codex/transcripts";
import { checkCompat } from "./codex/compat";
import { resolveCodexBin } from "./codex/codex-bin";

const HEALTH_INTERVAL_MS = Number(process.env.MACCHIATO_HEALTH_INTERVAL_MS) || 60_000;
const MIRROR_STUCK_MS = Number(process.env.MACCHIATO_MIRROR_STUCK_MS) || 120_000;

export interface HealthSnapshot {
  gatewayAlive: boolean;
  compatOk: boolean;
  mirrorLastPollAgeS: number;
  lastError: string | null;
  kind: "codex";
  connectorVersion: string;
  /** #89：無本地 STT——server 據此把語音輸入直接路由到雲端 BYOK STT（不再下達音頻）。 */
  stt: false;
  cliVersion?: string;
  /** #310 登錄態:false=最近驅動回合認證失敗(app 顯「需重新登錄」);成功回合恢復 true。 */
  authOk?: boolean;
  /** #10:累計計數(進程生命週期)。 */
  counters?: Record<string, number>;
  /** #260 引擎 + app-server v2 狀態(exec v1 省略):重啟風暴/死活可見。 */
  engine?: "app-server" | "exec";
  appServerReady?: boolean;
  appServerRestartFailures?: number;
}

/** #259 CLI 版本重探節流:CLI 自動升級後不能永遠用啟動時的舊值(env 可調)。 */
const CLI_REPROBE_MS = Number(process.env.MACCHIATO_CLI_REPROBE_MS) || 3_600_000;

export class HealthLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cliVersion: string | undefined;
  private cliFound = false;
  private lastProbeAt = 0;

  constructor(
    private readonly linkb: LinkBClient,
    private readonly mirror: Mirror,
    private readonly version: string,
    private readonly drive?: { counters: Record<string, number>; authFailed?: boolean }, // #10 計數 + #310 登錄態(v1/v2 皆可)
    /** #260 app-server v2 引擎狀態(exec v1 為 undefined)——重啟風暴/死活上浮 health。 */
    private readonly appServer?: { readonly restartFailures: number; readonly isReady: boolean },
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
    execFile(resolveCodexBin(), ["--version"], { timeout: 15_000 }, (err, stdout) => {
      if (!err) {
        this.cliFound = true;
        this.cliVersion = (stdout.trim().match(/\d+\.\d+\.\d+/) || [stdout.trim()])[0]; // "2.1.201 (Claude Code)" → "2.1.201"
      } else {
        console.error(`[health] codex --version 失敗(${resolveCodexBin()}): ${err.message}`);
      }
    });
  }

  tick(): void {
    gcAttachments(); // #151 入站附件 TTL GC(節流在函數內)
    if (Date.now() - this.lastProbeAt >= CLI_REPROBE_MS) this.probeCli(); // #259 CLI 升級後重探版本
    // #308 mirror off:輪詢本來就不跑,ageS 恆報 0——否則 server 60s 後誤判 degraded、下面看門狗無限「自愈」。
    const ageS = this.mirror.disabled ? 0 : Math.round((Date.now() - this.mirror.lastPollAt) / 1000);
    // #76 兼容自檢:版本門檻 + 最新 transcript 解析冒煙。不兼容 → compatOk=false(app 顯示降級),
    // 並把原因併入 lastError,別讓 CLI 升級悄悄破壞解析後靜默丟消息。
    const compat = checkCompat(this.cliVersion);
    // #260 v2:app-server 未就緒(重啟中)也算 gateway 不活;restartFailures 上浮(重啟風暴 app 不再一片綠)。
    const appOk = this.appServer ? this.appServer.isReady : true;
    const h: HealthSnapshot = {
      gatewayAlive: this.cliFound && existsSync(sessionsRoot()) && appOk,
      compatOk: this.cliFound && compat.ok,
      mirrorLastPollAgeS: ageS,
      lastError: compat.ok
        ? this.appServer && !this.appServer.isReady
          ? `app-server 未就緒(重啟失敗 ${this.appServer.restartFailures} 次)`
          : (this.mirror.lastError ?? compat.advisory ?? null) // #258 無錯時把升版告警上浮
        : (compat.reason ?? "兼容自檢失敗"),
      kind: "codex",
      connectorVersion: this.version,
      stt: false,
      ...(this.cliVersion ? { cliVersion: this.cliVersion } : {}),
      authOk: !this.drive?.authFailed, // #310:auth 失效上浮降級,成功回合自動恢復
      counters: { ...this.mirror.counters, ...(this.drive?.counters ?? {}) }, // #10
      engine: this.appServer ? "app-server" : "exec",
      ...(this.appServer ? { appServerReady: this.appServer.isReady, appServerRestartFailures: this.appServer.restartFailures } : {}),
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
