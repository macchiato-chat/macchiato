/**
 * Codex 連接器入口：
 *   憑證（未配對則先配對）→ 連 Macchiato Link B → 啟動鏡像 + 驅動 + 健康。
 * 跑：pnpm --filter @macchiato/codex-connector start
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCreds, quarantineCreds, saveCreds } from "./_core/linkb/creds";
import { LinkBClient } from "./_core/linkb/client";
import { runPairing } from "./_core/linkb/pairing";
import {
  E2EKeyStore,
  E2EKeyStoreStateError,
  settleE2EBackfillAck,
  type WrappedDeviceKey,
} from "./_core/e2e/keys";
import { deviceAuthConfigFromCreds } from "./_core/e2e/device-auth";
import { authorizeE2EDisableResume } from "./_core/e2e/control";
import { e2eStorePath } from "./_core/identity";
import { Mirror } from "./codex/mirror";
import { announceImportAvailable, runImport } from "./codex/history-import";
import { Drive, workDir } from "./codex/drive";
import { gcTitlegenResidue } from "./codex/titles";
import { AppServerClient } from "./codex/appserver";
import { Projects } from "./_core/projects";
import { ModelsReporter } from "./codex/models";
import { SkillsReporter } from "./codex/skills";
import { AppServerDrive } from "./codex/drive-appserver";
import { LoginFlow } from "./codex/login";
import { HealthLoop } from "./health";
import { HeartbeatWriter } from "./_core/heartbeat";
import { installProcessFaultHandlers } from "./_core/runtime-faults";
import { CONNECTOR_VERSION } from "./linkb/proto";
import { runVerifiedSelfUpdate } from "./_core/selfupdate";
import { KIND } from "./identity";

// §update 連接器發布版本:單源自 packages/protocol 的 CONNECTOR_VERSION(#526 起 TS 三家不再
// 各持副本——2026-07-20「bump 漏一家 → 該家永亮更新」與 2026-07-28 三連事故的同類根子都是
// 手工多份)。公開樹由 sync-public 重寫為 ./linkb/proto(常量再生,不漂移)。bump 用
// scripts/release/bump-connector-version.mjs(改 protocol + hermes.py + well-known 三處)。

function runSelfUpdate(): void {
  // #1 供應鏈加固:簽名清單驗證鏈全過才執行(見 selfupdate.ts;舊版是 curl|bash 裸跑)。
  runVerifiedSelfUpdate("codex", CONNECTOR_VERSION).catch((e) =>
    console.error("[self_update failed]", (e as Error).message),
  );
}

type E2EControlLink = Pick<LinkBClient, "agentLinkId" | "send"> &
  Partial<Pick<LinkBClient, "unblockSession">>;
type E2EBackfiller = Pick<Mirror, "backfillE2E"> & {
  acceptsE2EBackfillResult?: Mirror["acceptsE2EBackfillResult"];
  handleE2EBackfillResult: (...args: any[]) => void;
};
type E2ELocalSessionResolver = {
  localSessionIdFor(sid: string): string | undefined;
  beginE2ETransition?(sid: string, mode: "enable" | "disable"): void;
  releaseE2EQuiesce?(sid: string, mode?: "enable" | "disable", requestId?: string): void;
};

function startE2EBackfill(
  mirror: E2EBackfiller,
  sessions: E2ELocalSessionResolver,
  sid: string,
  mode: "enable" | "disable",
): void {
  void mirror.backfillE2E(sid, sessions.localSessionIdFor(sid), mode).catch((error) => {
    console.error(`[E2E ${mode} backfill failed]`, (error as Error).message);
  });
}

/** #817 生產配線必須轉發 pending-enable 白名單；`() => drive.assertE2EIdentitySafe()` 會丟參數。 */
export function bindE2EIdentityAssert(
  drive: { assertE2EIdentitySafe(allowMissingSids?: ReadonlySet<string>): void },
): (allowMissingSids?: ReadonlySet<string>) => void {
  return (sids) => drive.assertE2EIdentitySafe(sids);
}

/** #347 E2E 控制幀狀態機；導出供 connector 端 roundtrip 測試。 */
export function handleE2EControlFrame(
  msg: Record<string, unknown>,
  linkb: E2EControlLink,
  e2e: E2EKeyStore,
  mirror: E2EBackfiller,
  sessions: E2ELocalSessionResolver,
  assertIdentitySafe: (allowMissingSids?: ReadonlySet<string>) => void = () => {},
): boolean {
  const sid = typeof msg.hermesSessionId === "string" ? msg.hermesSessionId : undefined;

  if (msg.t === "e2e_wrap_request" && sid) {
    // ⚠️ 內層 catch 是硬要求（與 cc / openclaw / hermes 對稱，#366 驗收項）：
    // 狀態級拒絕（畸形 devices、指紋不符、缺 K_S…）只能軟拒絕該幀。若讓它冒泡到外層的
    // linkb.close() + onFatal() → process.exit(1)，server 會在重連後的 bootstrapE2E 重發
    // 同一幀 → 再退出，一幀畸形請求即可讓連接器永久起不來。持久化/poison 錯誤仍照舊上拋。
    try {
      const devices = Array.isArray(msg.devices) ? (msg.devices as any[]) : [];
      const isEnable = msg.backfill === true;
      let wrapped: WrappedDeviceKey[];
      if (isEnable) {
        // 首次 enable 是唯一允許建 K_S 的路徑。
        sessions.beginE2ETransition?.(sid, "enable");
        e2e.beginEnable(sid, msg.disableReceipt);
        // #687 pending-enable 允許該 sid 暫缺 ULID→UUID map，不得 strict assert → onFatal。
        assertIdentitySafe(new Set([sid]));
        wrapped = e2e.wrapForEnable(sid, devices);
      } else {
        // 新設備補封必須沿用既有 K_S，缺鑰時 fail closed，絕不生成 K₂。
        wrapped = e2e.wrapExistingForDevices(sid, devices);
      }
      // #731 未授權設備要讓用戶知道:跳過本身是靜默的,不回報就只剩一個永遠轉圈的 Updating。
      const deviceAuthRejected = e2e.takeDeviceAuthRejections();
      linkb.send({
        t: "e2e_key",
        agentLinkId: linkb.agentLinkId,
        hermesSessionId: sid,
        wrapped,
        ...(deviceAuthRejected.length ? { deviceAuthRejected } : {}),
      });
      console.log(`· E2E: session ${sid} — wrapped K_S for ${wrapped.length} device(s)`);
      if (isEnable) startE2EBackfill(mirror, sessions, sid, "enable");
    } catch (error) {
      // StateError + 身份閘：只軟拒本幀（#687；身份 Error 不得 onFatal 殺進程）。
      if (
        error instanceof E2EKeyStoreStateError ||
        (error instanceof Error &&
          /identity map unavailable|identity persistence is poisoned/i.test(error.message))
      ) {
        console.error(`[E2E wrap rejected ${sid}] ${(error as Error).message}`);
        return true;
      }
      throw error;
    }
    return true;
  }

  if (msg.t === "e2e_disable_request" && sid) {
    // 裸帧只用于 connector 重启后恢复“本地已由签封控制持久化”的 pending-disable。
    // server 无权从 stable 状态发起降级，否则可强迫明文历史回灌。
    try {
      if (!authorizeE2EDisableResume(e2e, linkb, sid)) {
        console.error(`[E2E raw disable rejected ${sid}] no authenticated local pending-disable`);
        return true;
      }
      sessions.beginE2ETransition?.(sid, "disable");
      e2e.markServerE2E(sid, "disable");
      // 缺 map 時軟拒絕本幀，絕不 onFatal（#687）。
      try {
        assertIdentitySafe();
      } catch (identityError) {
        console.error(
          `[E2E disable rejected ${sid}] identity unsafe: ${
            identityError instanceof Error ? identityError.message : String(identityError)
          }`,
        );
        return true;
      }
      startE2EBackfill(mirror, sessions, sid, "disable");
    } catch (error) {
      if (!(error instanceof E2EKeyStoreStateError)) throw error;
      console.error(`[E2E disable rejected ${sid}] ${(error as Error).message}`);
    }
    return true;
  }

  if (msg.t === "e2e_backfill_result" && sid) {
    if (msg.mode !== "enable" && msg.mode !== "disable") {
      console.error(`⚠️ E2E backfill result mode 無效，session ${sid} 狀態不變`);
      return true;
    }
    if (
      mirror.acceptsE2EBackfillResult &&
      !mirror.acceptsE2EBackfillResult(sid, msg.mode, msg.batchId)
    ) {
      console.error(`⚠️ E2E backfill stale/mismatched ACK ignored: ${sid} batch=${String(msg.batchId)}`);
      return true;
    }
    const committed =
      msg.ok === true &&
      ((msg.mode === "enable" && msg.e2e === true) || (msg.mode === "disable" && msg.e2e === false));
    let accepted = false;
    if (committed) {
      // 只有 StateError 被視為 stale ACK；persistence/poison 會重拋到外層 close/onFatal。
      accepted = settleE2EBackfillAck(e2e, sid, msg.mode, msg.disableReceipt);
      if (accepted) {
        if (msg.mode === "enable") linkb.unblockSession?.(sid);
        else console.log(`· E2E disable ACK: ${sid} — K_S removed`);
      }
    } else if (msg.mode === "disable" && msg.ok === false) {
      // found:false/明确拒绝且 receipt 尚未释放：撤销旧 intent，保留 K_S，允许设备重新签请求。
      e2e.cancelDisableBeforeRelease(sid);
    } else if (msg.mode === "enable" && msg.ok === false && msg.e2e === false) {
      // #818：server 已回滚 pending-enable → 按权威收敛丢钥。
      if (e2e.abortIncompleteEnable(sid)) {
        linkb.unblockSession?.(sid);
        accepted = true;
        console.log(`· E2E enable aborted by server: ${sid} — K_S dropped, plaintext resumed`);
      }
    }
    if (mirror.acceptsE2EBackfillResult) {
      mirror.handleE2EBackfillResult(sid, msg.mode, msg.batchId, accepted);
    } else {
      mirror.handleE2EBackfillResult(sid, msg.mode, accepted);
    }
    sessions.releaseE2EQuiesce?.(sid, msg.mode);
    if (!accepted) {
      console.error(
        `⚠️ E2E backfill 未確認提交，session ${sid} mode=${msg.mode} ` +
          `ok=${String(msg.ok)} e2e=${String(msg.e2e)}；保持 E2E/K_S`,
      );
    }
    return true;
  }

  if (msg.t === "e2e_enable_aborted" && sid) {
    // #818 live 路径：server 权威中止 pending-enable。
    if (e2e.abortIncompleteEnable(sid)) {
      linkb.unblockSession?.(sid);
      sessions.releaseE2EQuiesce?.(sid, "enable");
      console.log(`· E2E enable aborted (live): ${sid} — K_S dropped, plaintext resumed`);
    } else {
      console.error(
        `· E2E enable_aborted ignored for ${sid}（非 pending-enable，fail-closed 保留 K_S）`,
      );
    }
    return true;
  }

  return false;
}

async function main(): Promise<void> {
  let creds = loadCreds(KIND);
  if (!creds) {
    console.log("Not paired — starting pairing (enter the code below at macchiato.chat):");
    creds = await runPairing({ kind: KIND });
  }
  if (process.env.MACCHIATO_PAIR_ONLY) {
    console.log("Pairing complete (MACCHIATO_PAIR_ONLY) — exiting; start the service to run.");
    process.exit(0);
  }

  const e2e = new E2EKeyStore(e2eStorePath(KIND));
  // #731 設備授權：有配對 secret 才 enforce wrap proof；舊配對降級。
  e2e.configureDeviceAuth(
    deviceAuthConfigFromCreds({
      ...creds,
      persist: (authorized) => {
        const latest = loadCreds(KIND) ?? creds;
        saveCreds(KIND, { ...latest, authorizedDevices: authorized });
      },
    }),
  );
  let drive!: Drive | AppServerDrive;
  const linkb = new LinkBClient(
    creds,
    (state) => {
      const blocked = e2e.applyServerState(state);
      const sessions =
        (state as {
          sessions?: Array<{
            hermesSessionId: string;
            pendingOp: "enable" | "disable" | null;
          }>;
        }).sessions ?? [];
      drive.applyE2EQuiesceState(sessions);
      // #687 pending-enable 可暫缺 ULID→thread map；不得因此拒絕 ready → 永久 Offline。
      const pendingEnables = new Set(
        sessions
          .filter((session) => session.pendingOp === "enable")
          .map((session) => session.hermesSessionId),
      );
      try {
        drive.assertE2EIdentitySafe(pendingEnables);
      } catch (error) {
        console.error(
          `[E2E identity] ready continuing with isolation — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return blocked;
    },
    undefined,
    (sid) => e2e.isE2E(sid),
  );
  // #387 app 解綁(revoked)→ 隔離憑證 + exit 78(EX_CONFIG):新版 unit 憑
  // RestartPreventExitStatus=78 停止拉起;舊 unit 重啟後無憑證進入等待配對,不再空轉。
  linkb.onFatal = (kind) => {
    if (kind === "revoked") {
      const q = quarantineCreds(KIND);
      console.error(
        `✗ Unpaired from the Macchiato app — local credentials retired${q ? ` (${q})` : ""}. ` +
          "Re-run the install command to pair again.",
      );
      process.exit(78);
    }
    process.exit(1);
  };
  const mirror = new Mirror(
    linkb,
    e2e,
    (localSid) => drive.e2eWireSessionIdFor(localSid),
    () => drive.plaintextLocalMirrorAllowed(),
  );
  // #132 引擎選擇:默認 app-server v2(token delta/遠程審批/steer/原生圖片),initialize 握手
  // 探活失敗(老 codex 無此子命令/experimental 漂移)→ 回退 exec v1(功能同 1.5.x,不斷服務)。
  // env MACCHIATO_CODEX_ENGINE=exec 強制走 v1(逃生門)。
  const projects = new Projects(linkb, KIND); // #227 備案目錄:project_op + 回合末惰性版本化
  projects.wire();
  let modelsClient: AppServerClient | undefined; // #231 app-server 才有 model/list
  let skills: SkillsReporter | undefined; // #317 app-server 才有 skills/list;exec/降級 → 空上報清緩存
  if (process.env.MACCHIATO_CODEX_ENGINE === "exec") {
    drive = new Drive(linkb, mirror, e2e, projects);
    // ⚠️ 回歸契約:scripts/regression/run-codex-regression.mjs 斷言「引擎:app-server v2|exec v1」格式,改動需同步
    console.log("· 引擎:exec v1(MACCHIATO_CODEX_ENGINE=exec 強制)");
  } else {
    const appClient = new AppServerClient();
    // #250 運行期 app-server 連續重啟失敗到 FATAL 閾值 → 優雅退出,交 systemd 重啟(重走上面的
    // 啟動探活:app-server 仍壞則自動降級 exec v1)。此前運行期壞死無回退、活躍回合永久懸空。
    appClient.onFatal = (failures) => {
      console.error(`· codex app-server 無法恢復(${failures} 次重啟失敗)→ 退出交 systemd 重啟重走探活`);
      process.exit(1);
    };
    try {
      await appClient.start();
      skills = new SkillsReporter(linkb, appClient);
      drive = new AppServerDrive(appClient, linkb, mirror, e2e, projects, skills);
      modelsClient = appClient;
      linkb.declareRewind = true; // #473:thread/fork 在,才對 server 宣告 rewind
      linkb.declarePromptModes = true; // #552:turn/steer+turn/interrupt 在,三模式才宣告
      // ⚠️ 回歸契約:scripts/regression/run-codex-regression.mjs 斷言「引擎:app-server v2|exec v1」格式,改動需同步
      console.log("· 引擎:app-server v2(#132,握手成功)");
    } catch (e) {
      appClient.close();
      // #268 日誌帶「引擎:exec v1」統一格式,回歸腳本據此斷言引擎(此前「回退 exec v1」regex 抓不到、
      // v2 靜默降級只能靠超時發現)。
      // ⚠️ 回歸契約:scripts/regression/run-codex-regression.mjs 斷言「引擎:app-server v2|exec v1」格式,改動需同步
      console.error(`· 引擎:exec v1(app-server 探活失敗回退:${(e as Error).message.slice(0, 150)})`);
      drive = new Drive(linkb, mirror, e2e, projects);
    }
  }
  drive.wire();
  const localE2EStatus = () => drive.localSessionE2EStatus();
  void new ModelsReporter(linkb, modelsClient).start(); // #231 model/effort 清單上報(exec 無 client → 空)
  void (skills ?? new SkillsReporter(linkb)).start(); // #317 `/` 菜單數據源(skills/list;exec/降級 → 空)

  // #313 遠程重登錄:app 觸發 → `codex login --device-auth` → URL+一次性碼上送,CLI 自輪詢完成。
  const login = new LoginFlow();
  const loginEvents = {
    onUrl: (url: string, userCode?: string) =>
      linkb.send({ t: "auth_login_update", agentLinkId: linkb.agentLinkId, phase: "url", url, ...(userCode ? { userCode } : {}), needsCode: false }),
    onResult: (ok: boolean, error?: string) => {
      if (ok) drive.authFailed = false; // 登錄成功 → health 立即恢復 authOk
      linkb.send({ t: "auth_login_result", agentLinkId: linkb.agentLinkId, ok, ...(error ? { error } : {}) });
      console.log(ok ? "✓ #313 遠程重登錄完成" : `✗ #313 遠程重登錄失敗:${error}`);
    },
  };
  linkb.onFrame((msg) => {
    if (
      msg.t === "e2e_quiesce" &&
      typeof msg.hermesSessionId === "string" &&
      (msg.mode === "enable" || msg.mode === "disable") &&
      typeof msg.requestId === "string"
    ) {
      void drive
        .quiesceE2E(msg.hermesSessionId, msg.mode, msg.requestId)
        .then((ok) =>
          linkb.send({
            t: "e2e_quiesce_result",
            agentLinkId: linkb.agentLinkId,
            hermesSessionId: msg.hermesSessionId,
            mode: msg.mode,
            requestId: msg.requestId,
            ok,
            ...(!ok ? { error: "busy_timeout" as const } : {}),
          }),
        )
        .catch((error) => {
          linkb.send({
            t: "e2e_quiesce_result",
            agentLinkId: linkb.agentLinkId,
            hermesSessionId: msg.hermesSessionId,
            mode: msg.mode,
            requestId: msg.requestId,
            ok: false,
            error: "quiesce_failed",
          });
        });
      return;
    }
    if (
      msg.t === "e2e_quiesce_release" &&
      typeof msg.hermesSessionId === "string" &&
      (msg.mode === "enable" || msg.mode === "disable")
    ) {
      drive.releaseE2EQuiesce(
        msg.hermesSessionId,
        msg.mode,
        typeof msg.requestId === "string" ? msg.requestId : undefined,
      );
      return;
    }
    try {
      if (handleE2EControlFrame(msg, linkb, e2e, mirror, drive, bindE2EIdentityAssert(drive))) return;
    } catch (error) {
      // LinkB 的一般 frame handler 會隔離例外；E2E 狀態錯誤不可被吞掉後繼續運行。
      console.error("[E2E control frame rejected]", (error as Error).message);
      linkb.close();
      linkb.onFatal();
      return;
    }
    if (
      msg.t === "mirror_nack" &&
      (typeof msg.batchId === "number" || typeof msg.batchId === "string")
    ) {
      mirror.handleNack(
        msg.batchId,
        typeof msg.error === "string" ? msg.error : undefined,
        typeof (msg as { code?: unknown }).code === "string"
          ? ((msg as { code: string }).code)
          : undefined,
      );
    } else if (
      msg.t === "mirror_ack" &&
      (typeof msg.batchId === "number" || typeof msg.batchId === "string")
    ) {
      mirror.handleAck(msg.batchId);
    }
    else if (msg.t === "import_start") {
      // #154 可按 project 過濾。#874 枚舉拋錯會被 onFrame 靜默吞掉（app 那邊只看見「正在導入」乾轉）——
      // 至少在連接器日誌裡響一聲；狀態由 server 的殭屍導入回收兜住。
      try {
        runImport(linkb, localE2EStatus(), Array.isArray(msg.projects) ? (msg.projects as string[]) : undefined);
      } catch (e) {
        console.error(`[#874 歷史導入失敗] ${(e as Error).message}`);
      }
    }
    else if (msg.t === "self_update") runSelfUpdate();
    else if (msg.t === "auth_login_start") login.start(loginEvents);
  });
  // #669 心跳必須在 `linkb.start()` **之前**起：那個 await 只在首次 ready 才返回，連不上 server
  // 的機器會永遠停在這行——而那恰好是本心跳唯一要觀測的故障（#210 同形狀）。
  const heartbeat = new HeartbeatWriter(KIND, () => ({
    version: CONNECTOR_VERSION,
    linkConnected: linkb.isReady,
    lastConnectedAtMs: linkb.lastConnectedAtMs,
    busy: drive?.busy ?? false,
    pendingApproval: drive?.hasPendingApproval ?? false,
  }));
  heartbeat.start();
  // #893 進程級故障地板:掛在心跳之後(此刻才有東西可落盤)、linkb.start() 之前。
  // 啟動段本身由文件末尾的 main().catch 兜住,故這裡不必更早。
  installProcessFaultHandlers({ flushHealth: () => heartbeat.writeNow() });

  await linkb.start();

  drive.flushAbandonedTurns(); // #200+#489 F-12:優先只讀補撈已落盤 agent;失敗才「請重發」(絕不自動重跑)

  gcTitlegenResidue(); // #267/#376 清掃殘留的 codex-titlegen-* 臨時目錄(舊版標題留下的憑證副本)
  announceImportAvailable(linkb, localE2EStatus()); // app 的「導入」入口據此顯示
  mirror.start();

  const health = new HealthLoop(linkb, mirror, CONNECTOR_VERSION, drive, modelsClient, heartbeat); // #10 計數 + #260 v2 引擎狀態 + #669 心跳
  health.start();

  console.log(`✓ Codex connector running (workdir for new sessions: ${workDir()})`);

  const shutdown = (): void => {
    console.log("\n· Shutting down…");
    drive.dispose(); // #118 回收全部長活通道(CLI 進程)
    mirror.stop();
    health.stop();
    linkb.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// 允許測試只導入 E2E 控制狀態機；直接執行 src/index.ts 時行為不變。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((e) => {
    console.error("Connector failed to start:", e);
    process.exit(1);
  });
}
