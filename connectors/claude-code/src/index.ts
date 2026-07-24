/**
 * Claude Code 連接器入口：
 *   憑證（未配對則先配對）→ 連 Macchiato Link B → 啟動鏡像 + 驅動 + 健康。
 * 跑：pnpm --filter @macchiato/claude-code-connector start
 */
import { spawn } from "node:child_process";
import { loadCreds } from "./linkb/creds";
import { LinkBClient } from "./linkb/client";
import { runPairing } from "./linkb/pairing";
import { E2EKeyStore, E2EKeyStoreStateError, settleE2EBackfillAck } from "./e2e/keys";
import { authorizeE2EDisableResume } from "./e2e/control";
import { isCommittedE2EBackfillResult, Mirror } from "./cc/mirror";
import { CommandsReporter } from "./cc/commands";
import { ModelsReporter } from "./cc/models";
import { Projects } from "./cc/projects";
import { announceImportAvailable, runImport } from "./cc/history-import";
import { Drive, workDir } from "./cc/drive";
import { LoginFlow } from "./cc/login";
import { HealthLoop } from "./health";
import { runVerifiedSelfUpdate } from "./selfupdate";
import { cleanupTitlegenResidue } from "./cc/titles";

// §update 連接器發布版本:對齊 packages/protocol CONNECTOR_VERSION。⚠️ 發版必須**五處同步 bump**:
// 四連接器常量(cc/codex/openclaw 各自 src/index.ts + hermes connector.py)+ protocol link.ts 全局。
// 全局是 server 判 updateAvailable 的標尺——bump 全局漏任何一家=該家 app 永亮「更新」
// (本機與公開用戶一起亮,重啟無用;2026-07-20 實踩);全局上生產後應儘快 sync-public 發版閉環。
const CONNECTOR_VERSION = "1.5.46";

function runSelfUpdate(): void {
  // #1 供應鏈加固:簽名清單驗證鏈全過才執行(見 selfupdate.ts;舊版是 curl|bash 裸跑)。
  runVerifiedSelfUpdate("claude-code", CONNECTOR_VERSION).catch((e) =>
    console.error("[self_update failed]", (e as Error).message),
  );
}

async function main(): Promise<void> {
  cleanupTitlegenResidue(); // #346 清掉舊版異常退出後遺留的 titlegen 認證副本
  let creds = loadCreds();
  if (!creds) {
    console.log("Not paired — starting pairing (enter the code below at macchiato.chat):");
    creds = await runPairing();
  }
  if (process.env.MACCHIATO_PAIR_ONLY) {
    console.log("Pairing complete (MACCHIATO_PAIR_ONLY) — exiting; start the service to run.");
    process.exit(0);
  }

  // #347 先加载/校验本地密钥；Link B ready 必须套 server E2E 快照后才能 flush 出站缓冲。
  const e2e = new E2EKeyStore();
  let drive!: Drive;
  const linkb = new LinkBClient(
    creds,
    (state) => {
      const blocked = e2e.applyServerState(state);
      drive.assertE2EIdentitySafe();
      return blocked;
    },
    undefined,
    (sid) => e2e.isE2E(sid),
  );
  const mirror = new Mirror(
    linkb,
    e2e,
    (localSid) => drive.e2eWireSessionIdFor(localSid),
    (localSid) => drive.plaintextLocalMirrorAllowed(localSid),
  );
  const commands = new CommandsReporter(linkb); // #199 命令/技能清單上報(/菜單數據源)
  const projects = new Projects(linkb); // #227 備案目錄:project_op + 回合末惰性版本化
  projects.wire();
  drive = new Drive(linkb, mirror, e2e, commands, projects);
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
    try {
    if (msg.t === "mirror_nack" && typeof msg.batchId === "number") mirror.handleNack(msg.batchId);
    else if (msg.t === "import_start") runImport(linkb, localE2EStatus(), Array.isArray(msg.projects) ? (msg.projects as string[]) : undefined); // #154 可按 project 過濾
    else if (msg.t === "self_update") runSelfUpdate();
    else if (msg.t === "auth_login_start") login.start(loginEvents);
    else if (msg.t === "auth_login_code" && typeof msg.code === "string") login.submitCode(msg.code);
    else if (msg.t === "e2e_wrap_request" && typeof msg.hermesSessionId === "string") {
      const sid = msg.hermesSessionId;
      try {
        // 只有首次 enable(backfill=true) 可生成 K_S；普通新设备补封必须沿用现有 key。
        const enabling = msg.backfill === true;
        if (enabling) {
          e2e.beginEnable(sid, msg.disableReceipt);
          drive.assertE2EIdentitySafe();
        }
        const wrapped = enabling
          ? e2e.wrapForEnable(sid, (msg.devices as any[]) ?? [])
          : e2e.wrapExistingForDevices(sid, (msg.devices as any[]) ?? []);
        linkb.send({ t: "e2e_key", agentLinkId: linkb.agentLinkId, hermesSessionId: sid, wrapped });
        console.log(`· E2E: session ${sid} — wrapped K_S for ${wrapped.length} device(s)`);
        if (enabling) startE2EBackfill(sid, "enable");
      } catch (error) {
        if (!(error instanceof E2EKeyStoreStateError)) throw error;
        console.error(`[E2E wrap rejected ${sid}] ${(error as Error).message}`);
      }
    } else if (msg.t === "e2e_disable_request" && typeof msg.hermesSessionId === "string") {
      const sid = msg.hermesSessionId;
      try {
        if (!authorizeE2EDisableResume(e2e, linkb, sid)) {
          console.error(`[E2E raw disable rejected ${sid}] no authenticated local pending-disable`);
          return;
        }
        e2e.markServerE2E(sid, "disable");
        drive.assertE2EIdentitySafe();
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
      }
      mirror.handleE2EBackfillResult(sid, msg.mode, accepted);
      if (!accepted) {
        console.error(
          `· E2E backfill rejected/inconsistent: ${sid} mode=${msg.mode} ` +
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

  drive.flushAbandonedTurns(); // #200 對上個進程死時被殺的在途回合回「請重發」提示(消滅靜默無響應)
  announceImportAvailable(linkb, localE2EStatus()); // app 的「導入」入口據此顯示
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
