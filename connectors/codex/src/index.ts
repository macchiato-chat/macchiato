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
import { AppServerClient } from "./codex/appserver";
import { Projects } from "./codex/projects";
import { AppServerDrive } from "./codex/drive-appserver";
import { HealthLoop } from "./health";
import { runVerifiedSelfUpdate } from "./selfupdate";

// §update 連接器發布版本：對齊 packages/protocol CONNECTOR_VERSION（發版三處同步 bump）。
const CONNECTOR_VERSION = "1.5.18";

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
  if (process.env.MACCHIATO_CODEX_ENGINE === "exec") {
    drive = new Drive(linkb, mirror, e2e, projects);
    console.log("· 引擎:exec v1(MACCHIATO_CODEX_ENGINE=exec 強制)");
  } else {
    const appClient = new AppServerClient();
    try {
      await appClient.start();
      drive = new AppServerDrive(appClient, linkb, mirror, e2e, projects);
      console.log("· 引擎:app-server v2(#132,握手成功)");
    } catch (e) {
      appClient.close();
      console.error(`· app-server 探活失敗(${(e as Error).message.slice(0, 150)})→ 回退 exec v1`);
      drive = new Drive(linkb, mirror, e2e, projects);
    }
  }
  drive.wire();

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

  announceImportAvailable(linkb); // app 的「導入」入口據此顯示
  mirror.start();

  const health = new HealthLoop(linkb, mirror, CONNECTOR_VERSION, drive); // #10:計數上報
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
