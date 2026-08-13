/**
 * Claude Code 連接器入口：
 *   憑證（未配對則先配對）→ 連 Macchiato Link B → 啟動鏡像 + 驅動 + 健康。
 * 跑：pnpm --filter @macchiato/claude-code-connector start
 */
import { spawn } from "node:child_process";
import { loadCreds, quarantineCreds, saveCreds } from "./_core/linkb/creds";
import { LinkBClient } from "./_core/linkb/client";
import { runPairing } from "./_core/linkb/pairing";
import { E2EKeyStore, E2EKeyStoreStateError, settleE2EBackfillAck } from "./_core/e2e/keys";
import { deviceAuthConfigFromCreds } from "./_core/e2e/device-auth";
import { e2eStorePath } from "./_core/identity";
import { authorizeE2EDisableResume } from "./_core/e2e/control";
import { isCommittedE2EBackfillResult, Mirror } from "./cc/mirror";
import { CommandsReporter } from "./cc/commands";
import { ModelsReporter } from "./cc/models";
import { Projects } from "./_core/projects";
import { announceImportAvailable, runImport } from "./cc/history-import";
import { Drive, workDir } from "./cc/drive";
import { LoginFlow } from "./cc/login";
import { HealthLoop } from "./health";
import { HeartbeatWriter } from "./_core/heartbeat";
import { installProcessFaultHandlers } from "./_core/runtime-faults";
import { CONNECTOR_VERSION } from "./linkb/proto";
import { runVerifiedSelfUpdate } from "./_core/selfupdate";
import { KIND } from "./identity";
import { cleanupTitlegenResidue } from "./cc/titles";

// §update 連接器發布版本:單源自 packages/protocol 的 CONNECTOR_VERSION(#526 起 TS 三家不再
// 各持副本——2026-07-20「bump 漏一家 → 該家永亮更新」與 2026-07-28 三連事故的同類根子都是
// 手工多份)。公開樹由 sync-public 重寫為 ./linkb/proto(常量再生,不漂移)。bump 用
// scripts/release/bump-connector-version.mjs(改 protocol + hermes.py + well-known 三處)。

function runSelfUpdate(): void {
  // #1 供應鏈加固:簽名清單驗證鏈全過才執行(見 selfupdate.ts;舊版是 curl|bash 裸跑)。
  runVerifiedSelfUpdate("claude-code", CONNECTOR_VERSION).catch((e) =>
    console.error("[self_update failed]", (e as Error).message),
  );
}

async function main(): Promise<void> {
  cleanupTitlegenResidue(); // #346 清掉舊版異常退出後遺留的 titlegen 認證副本
  let creds = loadCreds(KIND);
  if (!creds) {
    console.log("Not paired — starting pairing (enter the code below at macchiato.chat):");
    creds = await runPairing({ kind: KIND });
  }
  if (process.env.MACCHIATO_PAIR_ONLY) {
    console.log("Pairing complete (MACCHIATO_PAIR_ONLY) — exiting; start the service to run.");
    process.exit(0);
  }

  // #347 先加载/校验本地密钥；Link B ready 必须套 server E2E 快照后才能 flush 出站缓冲。
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
  let drive!: Drive;
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
      // #687 pending-enable 可暫缺 wire↔CC map（App ULID 在首次 init 前本來就沒映射）。
      // 不得因此拒絕整條 ready——否則 onFatal 殺進程後 e2e floor 已落盤 → 永久 Offline。
      const pendingEnables = new Set(
        sessions
          .filter((session) => session.pendingOp === "enable")
          .map((session) => session.hermesSessionId),
      );
      try {
        drive.assertE2EIdentitySafe(pendingEnables);
      } catch (error) {
        // 穩定態身份壞了：隔離保護會話、連上 server 讓用戶能更新/重配；內容面仍 fail-closed。
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
  // CC：SDK 固定具備 rewind/fork/三模式——hello 誠實宣告。
  linkb.declareRewind = true;
  linkb.declareFork = true;
  linkb.declarePromptModes = true;
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
    // #395：任意 wire（明文 ULID / E2E）都要能從 local CLI uuid 反查——終端續聊掛回原會話。
    (localSid) => drive.wireSessionIdFor(localSid),
    (localSid) => drive.plaintextLocalMirrorAllowed(localSid),
  );
  const commands = new CommandsReporter(linkb); // #199 命令/技能清單上報(/菜單數據源)
  const projects = new Projects(linkb, KIND); // #227 備案目錄:project_op + 回合末惰性版本化
  projects.wire();
  drive = new Drive(linkb, mirror, e2e, commands, projects);
  // #658 掐點 steer 扣留:鏡像發批前查 Drive 待配池,命中的 user 行有界扣留給 srcId 回填讓路。
  mirror.pendingUserTexts = (localSid) => drive.pendingUserTextsForLocal(localSid);
  const modelsReporter = new ModelsReporter(linkb); // #231/#553 建在 drive 後、start 在 ready 段
  drive.modelsIndex = modelsReporter; // #553 resolveEffort 兜底 high 的閘(當前 model 支持 effort 才下發)
  drive.wire();
  const startE2EBackfill = (
    sid: string,
    mode: "enable" | "disable",
  ): void => {
    void mirror.backfillE2E(sid, drive.localSessionIdFor(sid), mode).catch((error) => {
      console.error(`[E2E ${mode} backfill failed ${sid}] ${(error as Error).message}`);
    });
  };
  const localE2EStatus = () => drive.localSessionE2EStatus();

  // #223 fork ACK:server 在 await,ok 必帶新會話身份。
  drive.onForkResult = (r) =>
    linkb.send({
      t: "fork_result",
      agentLinkId: linkb.agentLinkId,
      hermesSessionId: r.hermesSessionId,
      requestId: r.requestId,
      ok: r.ok,
      ...(r.ok ? { forkedHermesSessionId: r.forkedHermesSessionId } : { error: r.error ?? "failed" }),
    });

  // #473 rewind ACK：server 只有收到 ok 才刪自己的消息行，所以這條出口不能少。
  drive.onRewindResult = (r) =>
    linkb.send({
      t: "rewind_result",
      agentLinkId: linkb.agentLinkId,
      hermesSessionId: r.hermesSessionId,
      requestId: r.requestId,
      ok: r.ok,
      ...(r.ok ? { rewound: r.dropped ?? 0 } : { error: r.error ?? "failed" }),
    });

  // #313 遠程重登錄:app 觸發 → 起 `claude auth login`(PTY)→ URL 上送 → code 回傳餵 stdin。
  const login = new LoginFlow();
  const loginEvents = {
    onUrl: (url: string) => linkb.send({ t: "auth_login_update", agentLinkId: linkb.agentLinkId, phase: "url", url, needsCode: true }),
    onResult: (ok: boolean, error?: string) => {
      if (ok) drive.authFailed = false; // 登錄成功 → health 立即恢復 authOk(不等下個回合)
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
    else if (msg.t === "auth_login_code" && typeof msg.code === "string") login.submitCode(msg.code);
    else if (msg.t === "e2e_wrap_request" && typeof msg.hermesSessionId === "string") {
      const sid = msg.hermesSessionId;
      try {
        // 只有首次 enable(backfill=true) 可生成 K_S；普通新设备补封必须沿用现有 key。
        const enabling = msg.backfill === true;
        if (enabling) {
          drive.beginE2ETransition(sid, "enable");
          e2e.beginEnable(sid, msg.disableReceipt);
          // #687：pending-enable 允許該 sid 暫缺 map；不得 strict assert → onFatal。
          // wrap/backfill 不依賴 map；無本地 transcript 時 backfill 回 found:false（server #604 可回滾）。
          drive.assertE2EIdentitySafe(new Set([sid]));
        }
        const wrapped = enabling
          ? e2e.wrapForEnable(sid, (msg.devices as any[]) ?? [])
          : e2e.wrapExistingForDevices(sid, (msg.devices as any[]) ?? []);
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
        if (enabling) startE2EBackfill(sid, "enable");
      } catch (error) {
        // StateError + 身份閘：只軟拒本幀。#687 前身份 Error 會冒泡 onFatal → 永久 Offline。
        if (
          error instanceof E2EKeyStoreStateError ||
          (error instanceof Error &&
            /identity map unavailable|identity persistence is poisoned/i.test(error.message))
        ) {
          console.error(`[E2E wrap rejected ${sid}] ${(error as Error).message}`);
          return;
        }
        throw error;
      }
    } else if (msg.t === "e2e_disable_request" && typeof msg.hermesSessionId === "string") {
      const sid = msg.hermesSessionId;
      try {
        if (!authorizeE2EDisableResume(e2e, linkb, sid)) {
          console.error(`[E2E raw disable rejected ${sid}] no authenticated local pending-disable`);
          return;
        }
        drive.beginE2ETransition(sid, "disable");
        e2e.markServerE2E(sid, "disable");
        // disable 需要本地 transcript 身份；缺 map 時軟拒絕本幀，絕不 onFatal 殺整條 link。
        try {
          drive.assertE2EIdentitySafe();
        } catch (identityError) {
          console.error(
            `[E2E disable rejected ${sid}] identity unsafe: ${
              identityError instanceof Error ? identityError.message : String(identityError)
            }`,
          );
          return;
        }
        startE2EBackfill(sid, "disable");
      } catch (error) {
        if (!(error instanceof E2EKeyStoreStateError)) throw error;
        console.error(`[E2E disable rejected ${sid}] ${(error as Error).message}`);
      }
    } else if (
      msg.t === "e2e_backfill_result" &&
      typeof msg.hermesSessionId === "string" &&
      (msg.mode === "enable" || msg.mode === "disable")
    ) {
      const sid = msg.hermesSessionId;
      if (!mirror.acceptsE2EBackfillResult(sid, msg.mode, msg.batchId)) {
        console.error(
          `· E2E stale/mismatched backfill ACK ignored: ${sid} batch=${String(msg.batchId)}`,
        );
        return;
      }
      const committed = isCommittedE2EBackfillResult(msg.mode, msg.ok, msg.e2e);
      let accepted = false;
      if (committed) {
        accepted = settleE2EBackfillAck(
          e2e,
          sid,
          msg.mode,
          msg.disableReceipt,
        );
        if (accepted) {
          if (msg.mode === "enable") linkb.unblockSession(sid);
          else console.log(`· E2E disable ACK: ${sid} — K_S removed`);
        }
      } else if (msg.mode === "disable" && msg.ok === false) {
        // found:false/明确拒绝且 receipt 尚未释放：撤销旧 intent，保留 K_S，允许设备重新签请求。
        e2e.cancelDisableBeforeRelease(sid);
      } else if (msg.mode === "enable" && msg.ok === false && msg.e2e === false) {
        // #818：server 已回滚 pending-enable（found:false 等）→ 按权威收敛丢钥。
        if (e2e.abortIncompleteEnable(sid)) {
          linkb.unblockSession(sid);
          accepted = true;
          console.log(`· E2E enable aborted by server: ${sid} — K_S dropped, plaintext resumed`);
        }
      }
      mirror.handleE2EBackfillResult(sid, msg.mode, msg.batchId, accepted);
      drive.releaseE2EQuiesce(sid, msg.mode);
      if (!accepted) {
        console.error(
          `· E2E backfill rejected/inconsistent: ${sid} mode=${msg.mode} ` +
            `ok=${String(msg.ok)} e2e=${String(msg.e2e)} (${String(msg.error ?? "unknown")})`,
        );
      }
    } else if (
      msg.t === "e2e_enable_aborted" &&
      typeof msg.hermesSessionId === "string"
    ) {
      // #818 live 路径：client abort / 设备授权全拒 等把 DB 翻回明文后的权威通知。
      const sid = msg.hermesSessionId;
      if (e2e.abortIncompleteEnable(sid)) {
        linkb.unblockSession(sid);
        drive.releaseE2EQuiesce(sid, "enable");
        console.log(`· E2E enable aborted (live): ${sid} — K_S dropped, plaintext resumed`);
      } else {
        console.error(
          `· E2E enable_aborted ignored for ${sid}（非 pending-enable，fail-closed 保留 K_S）`,
        );
      }
    }
    } catch (error) {
      console.error("[E2E/control frame fatal]", (error as Error).message);
      linkb.close();
      linkb.onFatal();
    }
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
  announceImportAvailable(linkb, localE2EStatus()); // app 的「導入」入口據此顯示
  mirror.start();
  void commands.start(workDir()); // #199 枚舉+上報(短命 CLI;失敗只缺菜單,不阻啟動)
  void modelsReporter.start(workDir()); // #231 model/effort 清單上報(chip 數據源)

  const health = new HealthLoop(linkb, mirror, CONNECTOR_VERSION, drive, heartbeat); // #10:計數上報 + #669 心跳
  health.start();

  console.log(`✓ Claude Code connector running (workdir for new sessions: ${workDir()})`);

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

main().catch((e) => {
  console.error("Connector failed to start:", e);
  process.exit(1);
});
