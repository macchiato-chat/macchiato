/**
 * 健康上報 + 鏡像看門狗（對齊 Hermes/OpenClaw 連接器）。
 * Codex 無常駐 gateway（每回合 spawn codex exec）→ gatewayAlive = sessions 目錄可讀 + CLI 在位。
 *
 * 形狀對齊 `ConnectorHealthState` core+optional（#492）——不發 Hermes 專屬觀測字段。
 */
import type { ConnectorHealthState } from "./linkb/proto";
import { gcAttachments } from "./codex/attachments";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { LinkBClient } from "./_core/linkb/client";
import type { HeartbeatWriter } from "./_core/heartbeat";
import type { Mirror } from "./codex/mirror";
import { sessionsRoot } from "./codex/transcripts";
import { checkCompat } from "./codex/compat";
import { resolveCodexBin } from "./codex/codex-bin";
import { selfUpdatePendingRestartNotice } from "./_core/selfupdate";

const HEALTH_INTERVAL_MS = Number(process.env.MACCHIATO_HEALTH_INTERVAL_MS) || 60_000;
const MIRROR_STUCK_MS = Number(process.env.MACCHIATO_MIRROR_STUCK_MS) || 120_000;

/** 本連接器 health 上報體 = protocol core + 本家 optional/擴展。 */
export interface HealthSnapshot extends ConnectorHealthState {
  kind: "codex";
  connectorVersion: string;
  /** 本家總是發 number（mirror off → 0）。 */
  mirrorLastPollAgeS: number;
  /** #89：無本地 STT——server 據此把語音輸入直接路由到雲端 BYOK STT（不再下達音頻）。 */
  stt: false;
  /** 擴展：CLI 版本字串（server 不解析）。 */
  cliVersion?: string;
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
    private readonly drive?: {
      counters: Record<string, number>;
      authFailed?: boolean;
      /** #669 心跳活體信號(v1/v2 皆可;缺省按不忙處理)。 */
      readonly busy?: boolean;
      readonly hasPendingApproval?: boolean;
    }, // #10 計數 + #310 登錄態(v1/v2 皆可)
    /** #260 app-server v2 引擎狀態(exec v1 為 undefined)——重啟風暴/死活上浮 health。 */
    private readonly appServer?: { readonly restartFailures: number; readonly isReady: boolean },
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
      // #773 尾部再兜一句「新版已裝好、等重啟」——真錯誤(app-server 未就緒、鏡像卡住、兼容失敗)
      // 與 #258 升版告警都排在它前面,信息位絕不蓋掉真問題(#348 靜默凍結的教訓)。
      lastError:
        (compat.ok
          ? this.appServer && !this.appServer.isReady
            ? `app-server 未就緒(重啟失敗 ${this.appServer.restartFailures} 次)`
            : (this.mirror.lastError ?? compat.advisory ?? null) // #258 無錯時把升版告警上浮
          : (compat.reason ?? "兼容自檢失敗")) ?? selfUpdatePendingRestartNotice(),
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
    // #669 把最新上報體餵給心跳文件(它自己有時鐘,連不上 server 時照樣寫)。
    // 只擴文件、不擴 wire:下面發出去的 connector_health 形狀一個字節都沒動。
    this.heartbeat?.setSnapshot(h as unknown as Record<string, unknown>);
    if (this.linkb.isReady) {
      this.linkb.send({ t: "connector_health", agentLinkId: this.linkb.agentLinkId, health: h });
    }
  }
}
