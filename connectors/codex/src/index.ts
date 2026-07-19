/**
 * Codex 連接器入口：
 *   憑證（未配對則先配對）→ 連 Macchiato Link B → 啟動鏡像 + 驅動 + 健康。
 * 跑：pnpm --filter @macchiato/codex-connector start
 */
import { spawn } from "node:child_process";
import { loadCreds } from "./linkb/creds";
import { LinkBClient } from "./linkb/client";
import { runPairing } from "./linkb/pairing";
import { E2EKeyStore } from "./e2e/keys";
import { Mirror } from "./codex/mirror";
import { announceImportAvailable, runImport } from "./codex/history-import";
import { Drive, workDir } from "./codex/drive";
import { gcTitlegenResidue } from "./codex/titles";
import { AppServerClient } from "./codex/appserver";
import { Projects } from "./codex/projects";
import { ModelsReporter } from "./codex/models";
import { AppServerDrive } from "./codex/drive-appserver";
import { HealthLoop } from "./health";
import { runVerifiedSelfUpdate } from "./selfupdate";

// §update 連接器發布版本:對齊 packages/protocol CONNECTOR_VERSION。⚠️ 發版必須**五處同步 bump**:
// 四連接器常量(cc/codex/openclaw 各自 src/index.ts + hermes connector.py)+ protocol link.ts 全局。
// 全局是 server 判 updateAvailable 的標尺——bump 全局漏任何一家=該家 app 永亮「更新」
// (本機與公開用戶一起亮,重啟無用;2026-07-20 實踩);全局上生產後應儘快 sync-public 發版閉環。
const CONNECTOR_VERSION = "1.5.31";

function runSelfUpdate(): void {
  // #1 供應鏈加固:簽名清單驗證鏈全過才執行(見 selfupdate.ts;舊版是 curl|bash 裸跑)。
  runVerifiedSelfUpdate("codex", CONNECTOR_VERSION).catch((e) =>
    console.error("[self_update failed]", (e as Error).message),
  );
}

async function main(): Promise<void> {
  let creds = loadCreds();
  if (!creds) {
    console.log("Not paired — starting pairing (enter the code below at macchiato.chat):");
    creds = await runPairing();
  }
  if (process.env.MACCHIATO_PAIR_ONLY) {
    console.log("Pairing complete (MACCHIATO_PAIR_ONLY) — exiting; start the service to run.");
    process.exit(0);
  }

  const linkb = new LinkBClient(creds);
  const e2e = new E2EKeyStore();
  const mirror = new Mirror(linkb, e2e);
  // #132 引擎選擇:默認 app-server v2(token delta/遠程審批/steer/原生圖片),initialize 握手
  // 探活失敗(老 codex 無此子命令/experimental 漂移)→ 回退 exec v1(功能同 1.5.x,不斷服務)。
  // env MACCHIATO_CODEX_ENGINE=exec 強制走 v1(逃生門)。
  const projects = new Projects(linkb); // #227 備案目錄:project_op + 回合末惰性版本化
  projects.wire();
  let drive: Drive | AppServerDrive;
  let modelsClient: AppServerClient | undefined; // #231 app-server 才有 model/list
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
      drive = new AppServerDrive(appClient, linkb, mirror, e2e, projects);
      modelsClient = appClient;
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
  void new ModelsReporter(linkb, modelsClient).start(); // #231 model/effort 清單上報(exec 無 client → 空)

  linkb.onFrame((msg) => {
    if (msg.t === "mirror_nack" && typeof msg.batchId === "number") mirror.handleNack(msg.batchId);
    else if (msg.t === "import_start") runImport(linkb, Array.isArray(msg.projects) ? (msg.projects as string[]) : undefined); // #154 可按 project 過濾
    else if (msg.t === "self_update") runSelfUpdate();
    else if (msg.t === "e2e_wrap_request" && typeof msg.hermesSessionId === "string") {
      const wrapped = e2e.wrapForDevices(msg.hermesSessionId, (msg.devices as any[]) ?? []);
      linkb.send({ t: "e2e_key", agentLinkId: linkb.agentLinkId, hermesSessionId: msg.hermesSessionId, wrapped });
      console.log(`· E2E: session ${msg.hermesSessionId} — wrapped K_S for ${wrapped.length} device(s)`);
      if (msg.backfill) void mirror.backfillE2E(msg.hermesSessionId as string);
    } else if (msg.t === "e2e_disable_request" && typeof msg.hermesSessionId === "string") {
      void mirror.backfillE2E(msg.hermesSessionId as string, "disable");
    }
  });
  await linkb.start();

  drive.flushAbandonedTurns(); // #200 上個進程死於回合中途 → 提示重發(消滅靜默無響應)

  gcTitlegenResidue(); // #267 清掃殘留的 codex-titlegen-* 臨時目錄(SIGKILL 時 auth.json 副本殘留)
  announceImportAvailable(linkb); // app 的「導入」入口據此顯示
  mirror.start();

  const health = new HealthLoop(linkb, mirror, CONNECTOR_VERSION, drive, modelsClient); // #10 計數 + #260 v2 引擎狀態
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

main().catch((e) => {
  console.error("Connector failed to start:", e);
  process.exit(1);
});
