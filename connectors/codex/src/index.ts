/**
 * Codex 連接器入口：
 *   憑證（未配對則先配對）→ 連 Macchiato Link B → 啟動鏡像 + 驅動 + 健康。
 * 跑：pnpm --filter @macchiato/codex-connector start
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCreds } from "./linkb/creds";
import { LinkBClient } from "./linkb/client";
import { runPairing } from "./linkb/pairing";
import { E2EKeyStore, settleE2EBackfillAck } from "./e2e/keys";
import { authorizeE2EDisableResume } from "./e2e/control";
import { Mirror } from "./codex/mirror";
import { announceImportAvailable, runImport } from "./codex/history-import";
import { Drive, workDir } from "./codex/drive";
import { gcTitlegenResidue } from "./codex/titles";
import { AppServerClient } from "./codex/appserver";
import { Projects } from "./codex/projects";
import { ModelsReporter } from "./codex/models";
import { SkillsReporter } from "./codex/skills";
import { AppServerDrive } from "./codex/drive-appserver";
import { LoginFlow } from "./codex/login";
import { HealthLoop } from "./health";
import { runVerifiedSelfUpdate } from "./selfupdate";

// §update 連接器發布版本:對齊 packages/protocol CONNECTOR_VERSION。⚠️ 發版必須**五處同步 bump**:
// 四連接器常量(cc/codex/openclaw 各自 src/index.ts + hermes connector.py)+ protocol link.ts 全局。
// 全局是 server 判 updateAvailable 的標尺——bump 全局漏任何一家=該家 app 永亮「更新」
// (本機與公開用戶一起亮,重啟無用;2026-07-20 實踩);全局上生產後應儘快 sync-public 發版閉環。
const CONNECTOR_VERSION = "1.5.45";

function runSelfUpdate(): void {
  // #1 供應鏈加固:簽名清單驗證鏈全過才執行(見 selfupdate.ts;舊版是 curl|bash 裸跑)。
  runVerifiedSelfUpdate("codex", CONNECTOR_VERSION).catch((e) =>
    console.error("[self_update failed]", (e as Error).message),
  );
}

type E2EControlLink = Pick<LinkBClient, "agentLinkId" | "send"> &
  Partial<Pick<LinkBClient, "unblockSession">>;
type E2EBackfiller = Pick<Mirror, "backfillE2E" | "handleE2EBackfillResult">;
type E2ELocalSessionResolver = { localSessionIdFor(sid: string): string | undefined };

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

/** #347 E2E 控制幀狀態機；導出供 connector 端 roundtrip 測試。 */
export function handleE2EControlFrame(
  msg: Record<string, unknown>,
  linkb: E2EControlLink,
  e2e: E2EKeyStore,
  mirror: E2EBackfiller,
  sessions: E2ELocalSessionResolver,
  assertIdentitySafe: () => void = () => {},
): boolean {
  const sid = typeof msg.hermesSessionId === "string" ? msg.hermesSessionId : undefined;

  if (msg.t === "e2e_wrap_request" && sid) {
    const devices = Array.isArray(msg.devices) ? (msg.devices as any[]) : [];
    const isEnable = msg.backfill === true;
    let wrapped: { deviceId: string; sealed: string }[];
    if (isEnable) {
      // 首次 enable 是唯一允許建 K_S 的路徑。
      e2e.beginEnable(sid, msg.disableReceipt);
      assertIdentitySafe();
      wrapped = e2e.wrapForEnable(sid, devices);
    } else {
      // 新設備補封必須沿用既有 K_S，缺鑰時 fail closed，絕不生成 K₂。
      wrapped = e2e.wrapExistingForDevices(sid, devices);
    }
    linkb.send({ t: "e2e_key", agentLinkId: linkb.agentLinkId, hermesSessionId: sid, wrapped });
    console.log(`· E2E: session ${sid} — wrapped K_S for ${wrapped.length} device(s)`);
    if (isEnable) startE2EBackfill(mirror, sessions, sid, "enable");
    return true;
  }

  if (msg.t === "e2e_disable_request" && sid) {
    // 裸帧只用于 connector 重启后恢复“本地已由签封控制持久化”的 pending-disable。
    // server 无权从 stable 状态发起降级，否则可强迫明文历史回灌。
    if (!authorizeE2EDisableResume(e2e, linkb, sid)) {
      console.error(`[E2E raw disable rejected ${sid}] no authenticated local pending-disable`);
      return true;
    }
    e2e.markServerE2E(sid, "disable");
    assertIdentitySafe();
    startE2EBackfill(mirror, sessions, sid, "disable");
    return true;
  }

  if (msg.t === "e2e_backfill_result" && sid) {
    if (msg.mode !== "enable" && msg.mode !== "disable") {
      console.error(`⚠️ E2E backfill result mode 無效，session ${sid} 狀態不變`);
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
    }
    mirror.handleE2EBackfillResult(sid, msg.mode, accepted);
    if (!accepted) {
      console.error(
        `⚠️ E2E backfill 未確認提交，session ${sid} mode=${msg.mode} ` +
          `ok=${String(msg.ok)} e2e=${String(msg.e2e)}；保持 E2E/K_S`,
      );
    }
    return true;
  }

  return false;
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

  const e2e = new E2EKeyStore();
  let drive!: Drive | AppServerDrive;
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
    () => drive.plaintextLocalMirrorAllowed(),
  );
  // #132 引擎選擇:默認 app-server v2(token delta/遠程審批/steer/原生圖片),initialize 握手
  // 探活失敗(老 codex 無此子命令/experimental 漂移)→ 回退 exec v1(功能同 1.5.x,不斷服務)。
  // env MACCHIATO_CODEX_ENGINE=exec 強制走 v1(逃生門)。
  const projects = new Projects(linkb); // #227 備案目錄:project_op + 回合末惰性版本化
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
    try {
      if (handleE2EControlFrame(msg, linkb, e2e, mirror, drive, () => drive.assertE2EIdentitySafe())) return;
    } catch (error) {
      // LinkB 的一般 frame handler 會隔離例外；E2E 狀態錯誤不可被吞掉後繼續運行。
      console.error("[E2E control frame rejected]", (error as Error).message);
      linkb.close();
      linkb.onFatal();
      return;
    }
    if (msg.t === "mirror_nack" && typeof msg.batchId === "number") mirror.handleNack(msg.batchId);
    else if (msg.t === "import_start") runImport(linkb, localE2EStatus(), Array.isArray(msg.projects) ? (msg.projects as string[]) : undefined); // #154 可按 project 過濾
    else if (msg.t === "self_update") runSelfUpdate();
    else if (msg.t === "auth_login_start") login.start(loginEvents);
  });
  await linkb.start();

  drive.flushAbandonedTurns(); // #200 上個進程死於回合中途 → 提示重發(消滅靜默無響應)

  gcTitlegenResidue(); // #267 清掃殘留的 codex-titlegen-* 臨時目錄(SIGKILL 時 auth.json 副本殘留)
  announceImportAvailable(linkb, localE2EStatus()); // app 的「導入」入口據此顯示
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

// 允許測試只導入 E2E 控制狀態機；直接執行 src/index.ts 時行為不變。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((e) => {
    console.error("Connector failed to start:", e);
    process.exit(1);
  });
}
