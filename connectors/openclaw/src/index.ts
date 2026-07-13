/**
 * OpenClaw 連接器入口：
 *   憑證（未配對則先配對）→ 連 OpenClaw gateway + Macchiato Link B → 啟動鏡像。
 * 跑：pnpm --filter @macchiato/openclaw-connector start
 */
import { loadCreds } from "./linkb/creds";
import { LinkBClient } from "./linkb/client";
import { runPairing } from "./linkb/pairing";
import { resolveGatewayConfig } from "./openclaw/config";
import { Drive } from "./openclaw/drive";
import { OpenClawGateway } from "./openclaw/gateway";
import { announceImportAvailable, runImport } from "./openclaw/history-import";
import { Mirror } from "./openclaw/mirror";
import { PushHandler } from "./push/handler";
import { E2EKeyStore } from "./e2e/keys";
import { HealthLoop } from "./health";
import { runVerifiedSelfUpdate } from "./selfupdate";
import { spawn } from "node:child_process";

// §update 連接器發布版本：對齊 packages/protocol CONNECTOR_VERSION（發版三處同步 bump）。
const CONNECTOR_VERSION = "1.5.11";

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

  // 2. OpenClaw gateway（驅動 + 索引）
  const gw = new OpenClawGateway(resolveGatewayConfig());
  await gw.start();
  console.log(`✓ Connected to OpenClaw gateway (protocol ${gw.helloOk?.protocol}）`);

  // 3. Macchiato Link B
  const linkb = new LinkBClient(creds);
  const e2e = new E2EKeyStore();
  const mirror = new Mirror(gw, linkb, e2e);
  const drive = new Drive(gw, linkb, mirror, e2e);
  drive.wire(); // tui 幀（prompt.submit/interrupt）+ OpenClaw 事件 → 流式回傳
  linkb.onFrame((msg) => {
    if (msg.t === "mirror_nack" && typeof msg.batchId === "number") mirror.handleNack(msg.batchId);
    else if (msg.t === "import_start") void runImport(gw, linkb); // web「re-import」→ 回灌全量歷史
    else if (msg.t === "self_update") runSelfUpdate(); // §update：一鍵更新
    else if (msg.t === "e2e_wrap_request" && typeof msg.hermesSessionId === "string") {
      // §19：iOS 開啟 E2E / 新設備 → 生成/取 K_S、封裝給各設備、回 e2e_key
      const wrapped = e2e.wrapForDevices(msg.hermesSessionId, (msg.devices as any[]) ?? []);
      linkb.send({ t: "e2e_key", agentLinkId: linkb.agentLinkId, hermesSessionId: msg.hermesSessionId, wrapped });
      console.log(`· E2E: session ${msg.hermesSessionId} — wrapped K_S for ${wrapped.length} device(s)`);
      // §19 D2 新開啟：全量歷史重加密回灌, server 原地替換明文
      if (msg.backfill) void mirror.backfillE2E(msg.hermesSessionId);
    } else if (msg.t === "e2e_disable_request" && typeof msg.hermesSessionId === "string") {
      // §19 關閉：明文回灌（server 恢復可讀+投影）→ 成功後刪本地 K_S
      void mirror.backfillE2E(msg.hermesSessionId, "disable");
    }
  });
  await linkb.start();

  // #202 啟動對賬:連接器停機窗內 driven 會話漏投的行(含 #200 類「進程死於回合中途」的 final)
  // 靠 chat.history(穩定 id+seq)補齊;已投+已回填 srcId 的撞唯一索引被 server 吃掉,不雙投。
  void drive.reconcileAll("startup").catch((e) => console.error("[#202 startup reconcile]", (e as Error).message));

  // 4. 上報可導入歷史數（app 的「導入」入口據此顯示）
  await announceImportAvailable(gw, linkb).catch((e) => console.error("import_available failed:", e));

  // 5. 鏡像（OpenClaw → Macchiato, 增量）
  mirror.start();

  // 6. 主動投遞 socket（OpenClaw macchiato channel 插件 → connector_push）
  const push = new PushHandler(linkb);
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
