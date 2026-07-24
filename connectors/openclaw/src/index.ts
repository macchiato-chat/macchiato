/**
 * OpenClaw 連接器入口：
 *   憑證（未配對則先配對）→ 連 OpenClaw gateway + Macchiato Link B → 啟動鏡像。
 * 跑：pnpm --filter @macchiato/openclaw-connector start
 */
import { loadCreds, quarantineCreds } from "./linkb/creds";
import { LinkBClient } from "./linkb/client";
import { runPairing } from "./linkb/pairing";
import { resolveGatewayConfig } from "./openclaw/config";
import { applyReadyE2EIdentityState, Drive } from "./openclaw/drive";
import { OpenClawGateway } from "./openclaw/gateway";
import { announceImportAvailable, runImport } from "./openclaw/history-import";
import { isCommittedE2EBackfillResult, Mirror } from "./openclaw/mirror";
import { PushHandler } from "./push/handler";
import { E2EKeyStore, E2EKeyStoreStateError, settleE2EBackfillAck } from "./e2e/keys";
import { authorizeE2EDisableResume } from "./e2e/control";
import { CommandsReporter } from "./openclaw/commands";
import { HealthLoop } from "./health";
import { runVerifiedSelfUpdate } from "./selfupdate";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// §update 連接器發布版本:對齊 packages/protocol CONNECTOR_VERSION。⚠️ 發版必須**五處同步 bump**:
// 四連接器常量(cc/codex/openclaw 各自 src/index.ts + hermes connector.py)+ protocol link.ts 全局。
// 全局是 server 判 updateAvailable 的標尺——bump 全局漏任何一家=該家 app 永亮「更新」
// (本機與公開用戶一起亮,重啟無用;2026-07-20 實踩);全局上生產後應儘快 sync-public 發版閉環。
const CONNECTOR_VERSION = "1.5.50";

/** §update：收到 self_update → 後台跑安裝腳本（拉最新版 + 重啟服務，配對保留）。 */
function runSelfUpdate(): void {
  // #1 供應鏈加固:簽名清單驗證鏈全過才執行(見 selfupdate.ts;舊版是 curl|bash 裸跑)。
  runVerifiedSelfUpdate("openclaw", CONNECTOR_VERSION).catch((e) =>
    console.error("[self_update failed]", (e as Error).message),
  );
}

async function main(): Promise<void> {
  // 1. 憑證 / 配對
  let creds = loadCreds();
  if (!creds) {
    console.log("Not paired — starting pairing (enter the code below at macchiato.chat):");
    creds = await runPairing();
  }
  if (process.env.MACCHIATO_PAIR_ONLY) {
    console.log("Pairing complete (MACCHIATO_PAIR_ONLY) — exiting; start the service to run.");
    process.exit(0);
  }

  // #347 密鑰檔先於任何 agent/gateway 事件校驗；損壞時直接離線退出，沒有明文退化窗口。
  const e2e = new E2EKeyStore();

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
      const q = quarantineCreds();
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
  // #256:OpenClaw **不是 project-capable**(gateway 無 per-session cwd 通道;web PROJECT_CAPABLE_KINDS
  // 已排除)。不接線 project_op handler——否則 server 被攻破可驅動這個本不該存在的路徑,往任意目錄
  // 寫 AGENTS.md/CLAUDE.md(持久化 prompt injection)。project_op 幀無 handler = 直接忽略(server
  // 只在 ready 對 openclaw 發空 registry、fire-and-forget,無回應期待)。Projects 走 cc/codex/hermes。
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
    try {
    if (msg.t === "mirror_nack" && typeof msg.batchId === "number") mirror.handleNack(msg.batchId);
    else if (msg.t === "import_start") void runIdentitySafeImport(); // web「re-import」→ 身份對賬後回灌全量歷史
    else if (msg.t === "self_update") runSelfUpdate(); // §update：一鍵更新
    else if (msg.t === "e2e_wrap_request" && typeof msg.hermesSessionId === "string") {
      const sid = msg.hermesSessionId;
      try {
        // 首次 enable 才可生成 K_S；新設備補封缺 key 必須失敗，不能偷偷换成无法解旧历史的 K₂。
        if (msg.backfill) {
          e2e.beginEnable(sid, msg.disableReceipt);
          drive.assertE2EIdentitySafe();
        }
        const wrapped = msg.backfill
          ? e2e.wrapForEnable(sid, (msg.devices as any[]) ?? [])
          : e2e.wrapExistingForDevices(sid, (msg.devices as any[]) ?? []);
        linkb.send({ t: "e2e_key", agentLinkId: linkb.agentLinkId, hermesSessionId: sid, wrapped });
        console.log(`· E2E: session ${sid} — wrapped K_S for ${wrapped.length} device(s)`);
        if (msg.backfill) {
          void mirror.backfillE2E(sid).catch((error) => {
            console.error(`[E2E enable backfill fatal ${sid}] ${(error as Error).message}`);
            linkb.close();
            linkb.onFatal();
          });
        }
      } catch (error) {
        if (!(error instanceof E2EKeyStoreStateError)) throw error;
        console.error(`[E2E wrap rejected ${sid}] ${(error as Error).message}`);
      }
    } else if (msg.t === "e2e_disable_request" && typeof msg.hermesSessionId === "string") {
      // 裸帧只恢复 connector 本地已持久化的 authenticated pending-disable；stable
      // 状态下一律拒绝，server 不能单方面触发明文历史回灌。
      try {
        if (!authorizeE2EDisableResume(e2e, linkb, msg.hermesSessionId)) {
          console.error(
            `[E2E raw disable rejected ${msg.hermesSessionId}] no authenticated local pending-disable`,
          );
          return;
        }
        e2e.markServerE2E(msg.hermesSessionId, "disable");
        drive.assertE2EIdentitySafe();
        mirror.assertE2EIdentitySafe();
        void mirror.backfillE2E(msg.hermesSessionId, "disable").catch((error) => {
          console.error(`[E2E disable backfill fatal ${msg.hermesSessionId}] ${(error as Error).message}`);
          linkb.close();
          linkb.onFatal();
        });
      } catch (error) {
        if (!(error instanceof E2EKeyStoreStateError)) throw error;
        console.error(`[E2E disable rejected ${msg.hermesSessionId}] ${(error as Error).message}`);
      }
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
      }
      // 只有 store 确认 ACK 仍对应当前转换后，水位线才可提交；迟到 ACK 按失败解锁旧 pending。
      mirror.handleE2EBackfillResult(msg.hermesSessionId, msg.mode, accepted);
      if (!accepted) {
        console.error(
          `· E2E backfill rejected/inconsistent: ${msg.hermesSessionId} mode=${msg.mode} ` +
            `ok=${String(msg.ok)} e2e=${String(msg.e2e)} (${String(msg.error ?? "unknown")})`,
        );
      }
    }
    } catch (error) {
      console.error("[E2E/control frame fatal]", (error as Error).message);
      linkb.close();
      linkb.onFatal();
    }
  });
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
  const health = new HealthLoop(gw, linkb, mirror, CONNECTOR_VERSION, drive); // #10:計數上報
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

main().catch((e) => {
  console.error("Connector failed to start:", e);
  process.exit(1);
});
