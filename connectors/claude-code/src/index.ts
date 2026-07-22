/**
 * Claude Code 連接器入口：
 *   憑證（未配對則先配對）→ 連 Macchiato Link B → 啟動鏡像 + 驅動 + 健康。
 * 跑：pnpm --filter @macchiato/claude-code-connector start
 */
import { spawn } from "node:child_process";
import { loadCreds } from "./linkb/creds";
import { LinkBClient } from "./linkb/client";
import { runPairing } from "./linkb/pairing";
import { E2EKeyStore } from "./e2e/keys";
import { Mirror } from "./cc/mirror";
import { CommandsReporter } from "./cc/commands";
import { ModelsReporter } from "./cc/models";
import { Projects } from "./cc/projects";
import { announceImportAvailable, runImport } from "./cc/history-import";
import { Drive, workDir } from "./cc/drive";
import { LoginFlow } from "./cc/login";
import { HealthLoop } from "./health";
import { runVerifiedSelfUpdate } from "./selfupdate";

// §update 連接器發布版本:對齊 packages/protocol CONNECTOR_VERSION。⚠️ 發版必須**五處同步 bump**:
// 四連接器常量(cc/codex/openclaw 各自 src/index.ts + hermes connector.py)+ protocol link.ts 全局。
// 全局是 server 判 updateAvailable 的標尺——bump 全局漏任何一家=該家 app 永亮「更新」
// (本機與公開用戶一起亮,重啟無用;2026-07-20 實踩);全局上生產後應儘快 sync-public 發版閉環。
const CONNECTOR_VERSION = "1.5.37";

function runSelfUpdate(): void {
  // #1 供應鏈加固:簽名清單驗證鏈全過才執行(見 selfupdate.ts;舊版是 curl|bash 裸跑)。
  runVerifiedSelfUpdate("claude-code", CONNECTOR_VERSION).catch((e) =>
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
  const commands = new CommandsReporter(linkb); // #199 命令/技能清單上報(/菜單數據源)
  const projects = new Projects(linkb); // #227 備案目錄:project_op + 回合末惰性版本化
  projects.wire();
  const drive = new Drive(linkb, mirror, e2e, commands, projects);
  drive.wire();

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
    if (msg.t === "mirror_nack" && typeof msg.batchId === "number") mirror.handleNack(msg.batchId);
    else if (msg.t === "import_start") runImport(linkb, Array.isArray(msg.projects) ? (msg.projects as string[]) : undefined); // #154 可按 project 過濾
    else if (msg.t === "self_update") runSelfUpdate();
    else if (msg.t === "auth_login_start") login.start(loginEvents);
    else if (msg.t === "auth_login_code" && typeof msg.code === "string") login.submitCode(msg.code);
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

  drive.flushAbandonedTurns(); // #200 對上個進程死時被殺的在途回合回「請重發」提示(消滅靜默無響應)
  announceImportAvailable(linkb); // app 的「導入」入口據此顯示
  mirror.start();
  void commands.start(workDir()); // #199 枚舉+上報(短命 CLI;失敗只缺菜單,不阻啟動)
  void new ModelsReporter(linkb).start(workDir()); // #231 model/effort 清單上報(chip 數據源)

  const health = new HealthLoop(linkb, mirror, CONNECTOR_VERSION, drive); // #10:計數上報
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
