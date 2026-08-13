/**
 * OpenClaw 連接器入口：
 *   憑證（未配對則先配對）→ 連 OpenClaw gateway + Macchiato Link B → 啟動鏡像。
 * 跑：pnpm --filter @macchiato/openclaw-connector start
 */
import { loadCreds, quarantineCreds, saveCreds } from "./_core/linkb/creds";
import { LinkBClient } from "./_core/linkb/client";
import { runPairing } from "./_core/linkb/pairing";
import { resolveGatewayConfig } from "./openclaw/config";
import { applyReadyE2EIdentityState, Drive } from "./openclaw/drive";
import { OpenClawGateway } from "./openclaw/gateway";
import { announceImportAvailable, runImport } from "./openclaw/history-import";
import { isCommittedE2EBackfillResult, Mirror } from "./openclaw/mirror";
import { PushHandler } from "./push/handler";
import { E2EKeyStore, E2EKeyStoreStateError, settleE2EBackfillAck } from "./_core/e2e/keys";
import { deviceAuthConfigFromCreds } from "./_core/e2e/device-auth";
import { e2eStorePath } from "./_core/identity";
import { authorizeE2EDisableResume } from "./_core/e2e/control";
import { CommandsReporter } from "./openclaw/commands";
import { HealthLoop } from "./health";
import { HeartbeatWriter } from "./_core/heartbeat";
import { installProcessFaultHandlers } from "./_core/runtime-faults";
import { CONNECTOR_VERSION } from "./linkb/proto";
import { runVerifiedSelfUpdate } from "./_core/selfupdate";
import { KIND } from "./identity";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// §update 連接器發布版本:單源自 packages/protocol 的 CONNECTOR_VERSION(#526 起 TS 三家不再
// 各持副本——2026-07-20「bump 漏一家 → 該家永亮更新」與 2026-07-28 三連事故的同類根子都是
// 手工多份)。公開樹由 sync-public 重寫為 ./linkb/proto(常量再生,不漂移)。bump 用
// scripts/release/bump-connector-version.mjs(改 protocol + hermes.py + well-known 三處)。

type E2EControlLink = Pick<LinkBClient, "agentLinkId" | "send">;

/**
 * #687 wrap/disable 狀態機；導出供測試。身份 Error 只軟拒，不得冒泡 onFatal。
 * 生產 onFrame 外層仍 catch 非身份錯誤 → close + onFatal。
 */
export function handleE2EWrapOrDisable(
  msg: Record<string, unknown>,
  linkb: E2EControlLink,
  e2e: E2EKeyStore,
  drive: Pick<Drive, "beginE2ETransition" | "assertE2EIdentitySafe">,
  mirror: Pick<Mirror, "assertE2EIdentitySafe" | "backfillE2E">,
): void {
  const sid = typeof msg.hermesSessionId === "string" ? msg.hermesSessionId : undefined;
  if (!sid) return;

  if (msg.t === "e2e_wrap_request") {
    try {
      // 首次 enable 才可生成 K_S；新設備補封缺 key 必須失敗，不能偷偷换成无法解旧历史的 K₂。
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
      if (enabling) {
        void mirror.backfillE2E(sid).catch((error) => {
          // #817：單會話回灌失敗保持 pending + transition lock，交給 Retry/Cancel/重連收斂。
          // 殺整個 connector 只會在同一份持久壞狀態上形成永久 Offline crash loop。
          console.error(
            `[E2E enable backfill failed ${sid}] ${(error as Error).message}; waiting for Retry/Cancel`,
          );
        });
      }
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
    return;
  }

  if (msg.t === "e2e_disable_request") {
    // 裸帧只恢复 connector 本地已持久化的 authenticated pending-disable；stable
    // 状态下一律拒绝，server 不能单方面触发明文历史回灌。
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
        mirror.assertE2EIdentitySafe();
      } catch (identityError) {
        console.error(
          `[E2E disable rejected ${sid}] identity unsafe: ${
            identityError instanceof Error ? identityError.message : String(identityError)
          }`,
        );
        return;
      }
      void mirror.backfillE2E(sid, "disable").catch((error) => {
        console.error(
          `[E2E disable backfill failed ${sid}] ${(error as Error).message}; ` +
            "K_S kept, waiting for Retry/Cancel",
        );
      });
    } catch (error) {
      if (!(error instanceof E2EKeyStoreStateError)) throw error;
      console.error(`[E2E disable rejected ${sid}] ${(error as Error).message}`);
    }
  }
}

/** §update：收到 self_update → 後台跑安裝腳本（拉最新版 + 重啟服務，配對保留）。 */
function runSelfUpdate(): void {
  // #1 供應鏈加固:簽名清單驗證鏈全過才執行(見 selfupdate.ts;舊版是 curl|bash 裸跑)。
  runVerifiedSelfUpdate("openclaw", CONNECTOR_VERSION).catch((e) =>
    console.error("[self_update failed]", (e as Error).message),
  );
}

async function main(): Promise<void> {
  // 1. 憑證 / 配對
  let creds = loadCreds(KIND);
  if (!creds) {
    console.log("Not paired — starting pairing (enter the code below at macchiato.chat):");
    creds = await runPairing({ kind: KIND });
  }
  if (process.env.MACCHIATO_PAIR_ONLY) {
    console.log("Pairing complete (MACCHIATO_PAIR_ONLY) — exiting; start the service to run.");
    process.exit(0);
  }

  // #347 密鑰檔先於任何 agent/gateway 事件校驗；損壞時直接離線退出，沒有明文退化窗口。
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

  // 2. OpenClaw gateway（驅動 + 索引）
  const gw = new OpenClawGateway(resolveGatewayConfig());
  await gw.start();
  console.log(`✓ Connected to OpenClaw gateway (protocol ${gw.helloOk?.protocol}）`);

  // 3. Macchiato Link B
  let drive!: Drive;
  let mirror!: Mirror;
  const linkb = new LinkBClient(
    creds,
    (state) => applyReadyE2EIdentityState(e2e, drive, mirror, state),
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
  // #154/#248 首裝採樣:主檔**或 .bak**任一存在都不算首裝——此前只看主檔,兩段 rename 間崩潰
  // (主檔缺、.bak 在)會誤判首裝 → 觸發自動全量導入、重置用戶手改的標題。
  const mirrorMain = process.env.MACCHIATO_OPENCLAW_MIRROR || join(homedir(), ".macchiato/openclaw-mirror.json");
  const freshInstall = !existsSync(mirrorMain) && !existsSync(mirrorMain + ".bak");
  mirror = new Mirror(gw, linkb, e2e);
  // #256 / F-14 #498:OpenClaw **故意不做 Projects**(產品+安全邊界,見 docs/projects.md §3.1)。
  // gateway 無 per-session cwd 通道;web PROJECT_CAPABLE_KINDS 已排除。**不**接線 project_op
  // handler——否則 server 被攻破可驅動本不該存在的路徑,往任意目錄寫 AGENTS.md/CLAUDE.md
  // (持久化 prompt injection)。project_op 幀無 handler = 直接忽略;server ready 時若該 link
  // 無綁定 project 則不下發 registry。Projects 只走 cc/codex/hermes。
  drive = new Drive(gw, linkb, mirror, e2e);
  const localE2EStatus = () => mirror.localSessionE2EStatus();
  const preflightIdentity = async (reason: string): Promise<void> => {
    try {
      await mirror.reconcileIdentityPreflight();
    } catch (error) {
      // flag 保持 false；後續 import 即使繼續枚舉也會全擋，不會因 gateway/磁碟故障降明文。
      console.error(`[E2E identity preflight failed:${reason}] ${(error as Error).message}`);
    }
  };
  const runIdentitySafeImport = async (): Promise<void> => {
    await preflightIdentity("import");
    await runImport(gw, linkb, localE2EStatus());
  };
  drive.wire(); // tui 幀（prompt.submit/interrupt）+ OpenClaw 事件 → 流式回傳
  // #261 首連顯式訂閱 session 事件流(onGatewayConnected 只在重連 fire;wire 已註冊 onEvent → 不漏事件)。
  void drive.subscribeSessionEvents();
  new CommandsReporter(gw, linkb).start(); // #199 skill 清單上報(/菜單數據源;失敗只缺菜單)
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
          ? (msg as { code: string }).code
          : undefined,
      );
    } else if (
      msg.t === "mirror_ack" &&
      (typeof msg.batchId === "number" || typeof msg.batchId === "string")
    ) {
      mirror.handleAck(msg.batchId);
    }
    // web「re-import」→ 身份對賬後回灌全量歷史。#874 失敗要在日誌裡響一聲（此前 rejection 直接漏出去，
    // app 那邊只看見「正在導入」乾轉）；狀態由 server 的殭屍導入回收兜住。
    else if (msg.t === "import_start") void runIdentitySafeImport().catch((e) => console.error(`[#874 歷史導入失敗] ${(e as Error).message}`));
    else if (msg.t === "self_update") runSelfUpdate(); // §update：一鍵更新
    else if (msg.t === "e2e_wrap_request" || msg.t === "e2e_disable_request") {
      handleE2EWrapOrDisable(msg, linkb, e2e, drive, mirror);
    } else if (
      msg.t === "e2e_backfill_result" &&
      typeof msg.hermesSessionId === "string" &&
      (msg.mode === "enable" || msg.mode === "disable")
    ) {
      const committed = isCommittedE2EBackfillResult(msg.mode, msg.ok, msg.e2e);
      let accepted = false;
      if (committed) {
        accepted = settleE2EBackfillAck(
          e2e,
          msg.hermesSessionId,
          msg.mode,
          msg.disableReceipt,
        );
        if (accepted) {
          if (msg.mode === "enable") linkb.unblockSession(msg.hermesSessionId);
          else console.log(`· E2E disable ACK: ${msg.hermesSessionId} — K_S removed`);
        }
      } else if (msg.mode === "disable" && msg.ok === false) {
        // found:false/明确拒绝且 receipt 尚未释放：撤销旧 intent，保留 K_S，允许设备重新签请求。
        e2e.cancelDisableBeforeRelease(msg.hermesSessionId);
      } else if (msg.mode === "enable" && msg.ok === false && msg.e2e === false) {
        // #818：server 已回滚 pending-enable → 按权威收敛丢钥。
        if (e2e.abortIncompleteEnable(msg.hermesSessionId)) {
          linkb.unblockSession(msg.hermesSessionId);
          accepted = true;
          console.log(
            `· E2E enable aborted by server: ${msg.hermesSessionId} — K_S dropped, plaintext resumed`,
          );
        }
      }
      // 只有 store 确认 ACK 仍对应当前转换后，水位线才可提交；迟到 ACK 按失败解锁旧 pending。
      mirror.handleE2EBackfillResult(msg.hermesSessionId, msg.mode, accepted);
      drive.releaseE2EQuiesce(msg.hermesSessionId, msg.mode);
      if (!accepted) {
        console.error(
          `· E2E backfill rejected/inconsistent: ${msg.hermesSessionId} mode=${msg.mode} ` +
            `ok=${String(msg.ok)} e2e=${String(msg.e2e)} (${String(msg.error ?? "unknown")})`,
        );
      }
    } else if (
      msg.t === "e2e_enable_aborted" &&
      typeof msg.hermesSessionId === "string"
    ) {
      // #818 live 路径：server 权威中止 pending-enable。
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
  // OpenClaw 可在 connector 停機時 rotation 同一 key 的 transcript UUID；任何 announce/import/
  // mirror.start 前先同步保存 current+aliases。失敗時 preflight flag 保持 false，local import 全擋。
  await preflightIdentity("startup");

  // #202 啟動對賬:連接器停機窗內 driven 會話漏投的行(含 #200 類「進程死於回合中途」的 final)
  // 靠 chat.history(穩定 id+seq)補齊;已投+已回填 srcId 的撞唯一索引被 server 吃掉,不雙投。
  void drive.reconcileAll("startup").catch((e) => console.error("[#202 startup reconcile]", (e as Error).message));

  // 4. 上報可導入歷史數（app 的「導入」入口據此顯示）
  await announceImportAvailable(gw, linkb, localE2EStatus()).catch((e) => console.error("import_available failed:", e));
  // #154 首裝自動全量導入(拍板:Hermes/OpenClaw 不請示):鏡像水位線文件從未存在 = 首次安裝
  // → 自動回灌全部歷史(等價點「導入」;server dedup_key 去重)。既有安裝不觸發——自動 replace
  // 會重置手動改過的標題。freshInstall 在 mirror.start() 建檔**前**採樣;進程內只跑一次。
  // #308 mirror off 時跳過自動導入——自動吸入終端歷史同屬「終端側活動進 app」語義;
  // app 裡的「導入」按鈕(import_start)是用戶顯式動作,保留不動。
  if (freshInstall && !mirror.disabled) {
    console.log("· #154 首裝偵測 → 自動全量導入歷史(無需請示)");
    void runImport(gw, linkb, localE2EStatus()).catch((e) => console.error("[#154 自動導入失敗(手動導入入口仍在)]", (e as Error).message));
  }

  // 5. 鏡像（OpenClaw → Macchiato, 增量）
  mirror.start();

  // 6. 主動投遞 socket（OpenClaw macchiato channel 插件 → connector_push）
  const push = new PushHandler(linkb, e2e);
  push.start();

  // 7. 健康上報 + 鏡像看門狗
  const health = new HealthLoop(gw, linkb, mirror, CONNECTOR_VERSION, drive, heartbeat); // #10:計數上報 + #669 心跳
  health.start();

  const shutdown = (): void => {
    console.log("\n· Shutting down…");
    mirror.stop();
    health.stop();
    push.stop();
    linkb.close();
    gw.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// 允許測試只導入 wrap/disable 狀態機；直接執行 src/index.ts 時行為不變。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((e) => {
    console.error("Connector failed to start:", e);
    process.exit(1);
  });
}
