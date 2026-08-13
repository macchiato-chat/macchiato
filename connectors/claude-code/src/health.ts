/**
 * 健康上報 + 鏡像看門狗（對齊 Hermes/OpenClaw 連接器）。
 * Claude Code 無常駐 gateway（SDK 按需 spawn CLI）→ gatewayAlive = transcript 目錄可讀 + CLI 在位。
 *
 * 形狀對齊 `ConnectorHealthState` core+optional（#492）——不發 Hermes 專屬觀測字段。
 */
import type { ConnectorHealthState } from "./linkb/proto";
import { gcAttachments } from "./cc/attachments";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { LinkBClient } from "./_core/linkb/client";
import type { HeartbeatWriter } from "./_core/heartbeat";
import type { Drive } from "./cc/drive";
import type { Mirror } from "./cc/mirror";
import { projectsDir } from "./cc/transcripts";
import { checkCompat } from "./cc/compat";
import { resolveClaudeBin } from "./cc/claude-bin";
import {
  selfUpdateFailureNotice,
  selfUpdatePendingRestartNotice,
} from "./_core/selfupdate";
import { runtimeFaultNotice } from "./_core/runtime-faults";
import { reportInstalledVersion } from "./_core/disk-version";

const HEALTH_INTERVAL_MS = Number(process.env.MACCHIATO_HEALTH_INTERVAL_MS) || 60_000;
const MIRROR_STUCK_MS = Number(process.env.MACCHIATO_MIRROR_STUCK_MS) || 120_000;
/** #259 CLI 版本重探節流:CLI 自動升級後不能永遠用啟動時的舊值(env 可調)。 */
const CLI_REPROBE_MS = Number(process.env.MACCHIATO_CLI_REPROBE_MS) || 3_600_000;

/** 本連接器 health 上報體 = protocol core + 本家 optional/擴展。 */
export interface HealthSnapshot extends ConnectorHealthState {
  kind: "claude-code";
  connectorVersion: string;
  /** 本家總是發 number（mirror off → 0）。 */
  mirrorLastPollAgeS: number;
  /** #89：無本地 STT——server 據此把語音輸入直接路由到雲端 BYOK STT（不再下達音頻）。 */
  stt: false;
  /** 擴展：CLI 版本字串（server 不解析）。 */
  cliVersion?: string;
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
    /** #669 本地心跳(自帶時鐘、早於 linkb.start());這裡只餵最新上報體。 */
    private readonly heartbeat?: HeartbeatWriter,
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
    // #308 mirror off:輪詢本來就不跑,ageS 恆報 0——否則 server 60s 後誤判 degraded、下面看門狗無限「自愈」。
    const ageS = this.mirror.disabled ? 0 : Math.round((Date.now() - this.mirror.lastPollAt) / 1000);
    // #76 兼容自檢:版本門檻 + 最新 transcript 解析冒煙。不兼容 → compatOk=false(app 顯示降級),
    // 並把原因併入 lastError,別讓 CLI 升級悄悄破壞解析後靜默丟消息。
    const compat = checkCompat(this.cliVersion);
    const h: HealthSnapshot = {
      gatewayAlive: this.cliFound && existsSync(projectsDir()),
      compatOk: this.cliFound && compat.ok,
      mirrorLastPollAgeS: ageS,
      // #773 沒有真錯誤時,才把「新版已裝好、等重啟」這句人話放出來——真錯誤(鏡像卡住/丟批、
      // 兼容失敗)永遠優先,絕不能被一條信息位蓋掉(#348 靜默凍結的教訓)。
      // #888 但自更新**失敗**不是信息位,是用戶剛按下按鈕、正盯着結果的那個真錯誤,必須排最前:
      // 此前它和 pending-restart 一起掛在 `??` 的最尾端,於是只要鏡像有一條 sticky lastError
      // (黏到下一批被 server 提交為止),自更新失敗的真原因就永遠到不了 app。
      lastError:
        selfUpdateFailureNotice() ??
        // #893 進程級故障(已兜住的 rejection / 剛因 uncaught 重啟過)排在自更新失敗之後、
        // sticky 鏡像錯誤之前——理由同 #888:真問題不許被黏住的舊錯誤擋在門口。
        runtimeFaultNotice() ??
        (compat.ok ? this.mirror.lastError : (compat.reason ?? "兼容自檢失敗")) ??
        selfUpdatePendingRestartNotice(),
      kind: "claude-code",
      connectorVersion: this.version,
      // #768 磁盤版（裝完未重啟時 > 進程版）
      installedVersion: reportInstalledVersion(this.version, "claude-code"),
      stt: false,
      ...(this.cliVersion ? { cliVersion: this.cliVersion } : {}),
      authOk: !this.drive?.authFailed, // #310:auth 失效上浮降級,成功回合自動恢復
      counters: { ...this.mirror.counters, ...(this.drive?.counters ?? {}) }, // #10
    };
    if (ageS * 1000 > MIRROR_STUCK_MS) {
      console.error(`⚠️ Mirror poll stalled for ${ageS}s → restarting mirror`);
      this.mirror.restart();
      h.lastError = `mirror stuck ${ageS}s → restarted`;
    }
    // #669 把最新上報體餵給心跳文件(它自己有時鐘,連不上 server 時照樣寫)。
    // 只擴文件、不擴 wire:下面發出去的 connector_health 形狀一個字節都沒動。
    this.heartbeat?.setSnapshot(h as unknown as Record<string, unknown>);
    if (this.linkb.isReady) {
      this.linkb.send({ t: "connector_health", agentLinkId: this.linkb.agentLinkId, health: h });
    }
  }
}
