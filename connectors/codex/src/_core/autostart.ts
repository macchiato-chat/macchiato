/**
 * #977 開機自啟**補裝**：手起來的連接器自己把 launchd / systemd 單元補上。
 *
 * 為什麼需要它（真實用戶 2026-08-17 報的）：「電腦每次重啟都需要重新啟動麼？」
 * install.sh 早就會裝 LaunchAgent（#15）/ systemd user unit（#430），但**存量機器吃不到**——
 * 自更新只換代碼樹，從不回頭補單元；而沒有單元的機器同時也沒有 supervisor，於是連自更新
 * 都不會發生。這批人只剩一條路：每次開機自己去終端把連接器再敲起來一遍。那不是「小瑕疵」，
 * 那是產品每天壞一次、且要用戶自己記得修。
 *
 * 本模塊的全部行為就一句話：**發現自己是手起的、且單元檔不存在，就把單元檔補上，然後什麼都不做。**
 *
 * 三條刻意的克制（每一條都對應一種更糟的結果）：
 *  1. **絕不覆蓋已存在的單元檔。** install.sh 寫的單元帶著它當時探到的 `MACCHIATO_CLAUDE_BIN`、
 *     PATH、mirror 模式——我們這裡的環境未必等價。覆蓋一份「看起來對」的單元，是把一台好機器
 *     改壞，比不修嚴重得多。單元已在 = 收工。
 *  2. **絕不現在就把它拉起來**（不 `launchctl bootstrap`、不 `systemctl start`）。此刻用戶手起的
 *     那個進程正跑著，再拉一個 = 同一 agent 兩條 Link B。server 端 `registry.add` 會踢掉舊的
 *     （4001 superseded），被踢的那個退避後重連再踢回去——本機自己跟自己打，會話一路抖。
 *     單元檔落盤即可：launchd 下次登入自己加載，systemd `enable` 進 default.target。
 *  3. **只認 install.sh 裝出來的樹**（`~/.macchiato/<kind>-app`）。開發樹、localchain、探針跑的
 *     連接器一律跳過——不然開發機上會憑空多出一個開機自啟的 agent，那是 2026-07-19 影子會話
 *     事故的同一類問題（本機開發行為溢出到常駐服務）。
 *
 * 配套的另一半在 `shouldYieldToRunningInstance`：自啟一旦生效，用戶按老習慣再手起一個就會
 * 出現同機兩條 Link B。**這是本改動自己造出來的風險，所以由本改動兜住**——手起的那個讓位退出。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { defaultConnectorAppRoot } from "./disk-version";
import { agentLinkFingerprint, type HeartbeatLiveness, readHeartbeatLiveness, supervisorUpdateReport } from "./heartbeat";
import { loadCreds } from "./linkb/creds";
import type { ConnectorKind } from "./identity";

/** 一次補裝的結論（供日誌/單測；`installed` 之外都不寫任何文件）。 */
export type AutostartOutcome =
  /** 本進程已經是 launchd/systemd 拉起來的 —— 什麼都不用做。 */
  | "managed"
  /** 單元檔已在盤上（可能只是還沒加載）—— 下次開機/登入會起，絕不覆蓋。 */
  | "unit-present"
  /** 本次補上了單元檔。 */
  | "installed"
  /** 不是 install.sh 裝出來的樹（開發樹 / 手工部署）—— 不碰。 */
  | "not-installed-tree"
  /** 顯式關掉（`MACCHIATO_NO_AUTOSTART` / `MACCHIATO_SKIP_UNIT` / 配對子進程）。 */
  | "opted-out"
  /** 這台機器沒有 launchd 也沒有 systemd（WSL、裸容器…）—— 沒有能補的東西。 */
  | "unsupported"
  /** 想補但沒補成（權限/盤滿/systemctl 失敗）。 */
  | "failed";

export interface AutostartResult {
  outcome: AutostartOutcome;
  /** 單元檔路徑（`installed` / `unit-present` 時有）。 */
  unitPath?: string;
  /** 一句人話，給日誌用；`failed` 時是原因。 */
  detail?: string;
}

/** 可注入的一層薄殼：單測不碰真實文件系統、不真跑 systemctl。 */
export interface AutostartDeps {
  env: NodeJS.ProcessEnv;
  platform: string;
  home: string;
  /** 本進程實際在跑的連接器樹（`resolveRunningAppRoot` 的結果）；null = 認不出來。 */
  appRoot: string | null;
  /** 本進程是否已被 supervisor 托管（heartbeat 的印章判據）。 */
  supervised: boolean;
  exists(path: string): boolean;
  /** `mkdir -p`。 */
  ensureDir(path: string): void;
  /** 原子寫（tmp + rename）；拋異常即視為失敗。 */
  writeUnit(path: string, content: string, mode: number): void;
  /** 跑一條輔助命令（systemctl / loginctl）；成功 true。 */
  run(cmd: string, args: string[]): boolean;
}

/** systemd/launchd 單元名 —— 與 install.sh 的 `unit_for()` 一字不差。 */
export function unitNameFor(kind: string): string {
  return kind === "hermes" ? "macchiato-connector" : `macchiato-${kind}-connector`;
}

/** `$HOME/Library/LaunchAgents/chat.macchiato.<unit>.plist`（install.sh 同一路徑）。 */
export function launchdPlistPath(home: string, unit: string): string {
  return join(home, "Library", "LaunchAgents", `chat.macchiato.${unit}.plist`);
}

/**
 * `$HOME/.config/systemd/user/<unit>.service`。
 * 刻意**不看 `XDG_CONFIG_HOME`**：install.sh 的 `UNIT_DIR` 就是寫死的這條路徑，
 * 兩邊解出不同目錄 = 我們補一份、它裝一份，機器上兩個單元互相打架。
 */
export function systemdUnitPath(home: string, unit: string): string {
  return join(home, ".config", "systemd", "user", `${unit}.service`);
}

/**
 * 帶進單元的環境變量白名單。**只帶運維面的**——絕不把整個 shell 環境（含各種憑證）
 * 拓印進一個開機就執行的文件。
 *
 * `PATH` 單獨處理：手起的進程那份 PATH 正是「現在能跑起來」的證據（nvm / homebrew /
 * ~/.local/bin 都在裡面），照抄比我們重新猜一份靠譜。
 */
const UNIT_ENV_KEYS = [
  "MACCHIATO_SERVER_URL",
  "MACCHIATO_WEB_URL",
  "MACCHIATO_MIRROR",
  "MACCHIATO_STATE_DIR",
  "MACCHIATO_SUPERVISE_STATE_DIR",
  "MACCHIATO_CLAUDE_BIN",
  "MACCHIATO_CODEX_BIN",
] as const;

/** 單元文件裡的值不許帶換行/控制字符（會截斷 plist 或讓 systemd 解析出別的鍵）。 */
function safeEnvValue(value: string | undefined): string | null {
  if (typeof value !== "string" || value === "") return null;
  if (value.length > 4096) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

export function collectUnitEnv(env: NodeJS.ProcessEnv, execPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  // node 自己所在目錄必須在 PATH 裡：launchd 給 agent 的是極簡 PATH，而 ExecStart 的 tsx
  // 是 `#!/usr/bin/env node` 的 shebang —— 找不到 node 就是開機起不來（install.sh 同一處理）。
  const parts = (safeEnvValue(env.PATH) ?? "/usr/local/bin:/usr/bin:/bin").split(":").filter(Boolean);
  const nodeDir = dirname(execPath);
  if (nodeDir && nodeDir !== "." && !parts.includes(nodeDir)) parts.unshift(nodeDir);
  // 開發機的交互 shell PATH 常有大量重複段（實測抄下來 2KB、同一目錄出現三次）。
  // 去重不改語義（首次命中即生效），但讓落盤的單元還能讀。
  out.PATH = [...new Set(parts)].join(":");
  for (const key of UNIT_ENV_KEYS) {
    const v = safeEnvValue(env[key]);
    if (v !== null) out[key] = v;
  }
  return out;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface UnitSpec {
  unit: string;
  /** ExecStart 的參數表（已含 supervise 包裝）。 */
  args: string[];
  workingDir: string;
  env: Record<string, string>;
  logPath: string;
}

/**
 * LaunchAgent plist —— 與 install.sh `install_launchd_unit` 同構：
 * `RunAtLoad`（登入即起）+ `KeepAlive`（崩了/自更新換代碼後退出，launchd 拉回來）。
 */
export function renderLaunchdPlist(spec: UnitSpec): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>Label</key><string>chat.macchiato.${xmlEscape(spec.unit)}</string>`,
    "  <key>ProgramArguments</key><array>",
    ...spec.args.map((a) => `    <string>${xmlEscape(a)}</string>`),
    "  </array>",
    `  <key>WorkingDirectory</key><string>${xmlEscape(spec.workingDir)}</string>`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    "  <key>EnvironmentVariables</key><dict>",
    ...Object.entries(spec.env).map(
      ([k, v]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`,
    ),
    "  </dict>",
    `  <key>StandardOutPath</key><string>${xmlEscape(spec.logPath)}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(spec.logPath)}</string>`,
    "</dict></plist>",
    "",
  ];
  return lines.join("\n");
}

/**
 * systemd user unit —— 與 install.sh 同構。`RestartPreventExitStatus=78` / `SuccessExitStatus=78`
 * 兩條缺一不可：78(EX_CONFIG) 是「這個 agent 已在 app 裡被解綁」，那種進程重啟一萬次也認證不了，
 * 不攔就是無限 flap（#387；鍵名寫錯過一次，#767）。
 */
export function renderSystemdUnit(spec: UnitSpec): string {
  const lines: string[] = [
    "[Unit]",
    `Description=Macchiato Connector (${spec.unit})`,
    "After=network-online.target",
    "",
    "[Service]",
    `WorkingDirectory=${spec.workingDir}`,
    `ExecStart=${spec.args.join(" ")}`,
    "Restart=always",
    "RestartSec=5",
    "RestartPreventExitStatus=78",
    "SuccessExitStatus=78",
    "Environment=PYTHONUNBUFFERED=1",
    ...Object.entries(spec.env).map(([k, v]) => `Environment=${k}=${v}`),
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  return lines.join("\n");
}

/**
 * 「我是被誰起來的」。
 *
 * launchd 會把 job 的 label 放進 `XPC_SERVICE_NAME`（普通終端裡那個值是 `0`），systemd 會給
 * unit 的每個進程設 `INVOCATION_ID` / `JOURNAL_STREAM`——兩者都會被子進程繼承，所以中間隔著
 * `macchiato-supervise` 也認得出來。再兜一層 supervisor 的存活印章。
 *
 * 判錯的代價是不對稱的，所以寧可**多報 managed**：漏判（把托管的當手起的）最多是白跑一次
 * 「單元已在 → 收工」；反過來如果把手起的當托管，我們什麼都不補，用戶下次開機照樣手動起。
 */
export function isProcessManaged(env: NodeJS.ProcessEnv, supervised: boolean): boolean {
  if (supervised) return true;
  const xpc = env.XPC_SERVICE_NAME ?? "";
  if (xpc.startsWith("chat.macchiato.")) return true;
  if (env.INVOCATION_ID || env.JOURNAL_STREAM) return true;
  return false;
}

function truthy(v: string | undefined): boolean {
  return v === "1" || v === "true" || v === "yes";
}

/**
 * 心跳多舊就不算「還有人在跑」。心跳每 30s 一次（`HEARTBEAT_INTERVAL_MS`），這裡給到 120s：
 * 寬到吃得下一次休眠喚醒/時鐘微調，又短到 pid 復用撞上同一格的概率可以忽略。
 */
const INSTANCE_ALIVE_WINDOW_S = 120;

export interface YieldDeps {
  env: NodeJS.ProcessEnv;
  /** supervisor 存活印章（同 `AutostartDeps.supervised`）。 */
  supervised: boolean;
  /** 本進程 pid。 */
  pid: number;
  /** 現在（epoch 秒）。 */
  nowS: number;
  /** 同 kind 心跳裡的活體格；沒有 → null。 */
  liveness: HeartbeatLiveness | null;
  /** #991 本進程服務的 agent link 指紋（未配對 → null）。只有兩邊同一條才讓位。 */
  selfAgentLinkFp: string | null;
  /** pid 還在不在（`process.kill(pid, 0)`）。 */
  isAlive(pid: number): boolean;
}

/**
 * #977 「同機第二個實例讓位」判據。
 *
 * 為什麼需要：補上開機自啟之後，用戶按老習慣再手動起一個，同一 agent 就有了兩條 Link B。
 * server 的 `registry.add` 只保留最後一條、把前一條以 4001 superseded 踢掉，而被踢的那個
 * 退避幾秒又連回來、再把對方踢掉——本機自己跟自己打，用戶側表現為會話莫名其妙地抖。
 *
 * 方向是**單向**的：**托管的那個永不讓位**。它要是退了，launchd 的 `KeepAlive` / systemd 的
 * `Restart=always` 立刻把它拉回來，於是變成十秒一輪的重啟循環——比互踢更糟。
 * 只有手起的那個退。
 *
 * 兩個「寧可放行也不冤殺」的 fail-open：老連接器沒寫 pid、或心跳已經不新鮮，一律不讓位。
 * 最壞回到今天的行為（兩個一起跑），而誤判的代價是「用戶起不來連接器且不知道為什麼」。
 */
export function shouldYieldToRunningInstance(deps: YieldDeps): number | null {
  const { env } = deps;
  // 配對子進程本來就是 install.sh 在服務還跑著的時候起的（#387 重新配對），它必須能跑。
  if (env.MACCHIATO_PAIR_ONLY) return null;
  // 逃生門：真要在本機同時跑兩個（排障/對比）時用。
  if (truthy(env.MACCHIATO_ALLOW_SECOND_INSTANCE)) return null;
  if (isProcessManaged(env, deps.supervised)) return null;
  const live = deps.liveness;
  if (!live || live.pid === null) return null;
  if (live.pid === deps.pid) return null; // 自己剛寫的
  if (deps.nowS - live.ts > INSTANCE_ALIVE_WINDOW_S) return null; // 陳年心跳：那個進程早沒了
  if (!deps.isAlive(live.pid)) return null;
  // #991 第三條 fail-open，也是最要緊的一條：**必須是同一條 agent link 才讓位**。
  // 衝突的來源是 server 端 `registry.add` 對同一個 agentLinkId 只留最後一條；不同 link 的兩個
  // 連接器各走各的，從來不互踢。只看 kind 會誤殺一堆合法組合——兩個帳號、staging × 生產、
  // 以及所有測試骨架（2026-08-17 狗糧實測：cc-regr / folders-e2e / codex-regr / localchain
  // codex-mirroroff 四步全紅，紅的原因與被測行為毫無關係）。
  // 任一邊不知道自己是哪條 link（老連接器沒寫這格 / 本進程還沒配對）→ 放行，理由同上面兩條：
  // 誤判的代價是「用戶起不來連接器且不知道為什麼」，比兩個一起跑嚴重得多。
  if (!live.agentLinkFp || !deps.selfAgentLinkFp) return null;
  if (live.agentLinkFp !== deps.selfAgentLinkFp) return null;
  return live.pid;
}

/** 真實依賴（心跳文件 + `kill(pid, 0)`）。 */
export function realYieldDeps(kind: string): YieldDeps {
  return {
    env: process.env,
    supervised: supervisorUpdateReport(kind).supervised === true,
    pid: process.pid,
    nowS: Math.floor(Date.now() / 1000),
    liveness: readHeartbeatLiveness(kind),
    // 守衛跑在 `loadCreds()` 之前（見各家 index.ts 的 main），所以這裡自己讀一次。
    // 讀不到（未配對 / 壞檔）→ null → 上面按 fail-open 放行。
    selfAgentLinkFp: agentLinkFingerprint(loadCreds(kind as ConnectorKind)?.agentLinkId),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        // EPERM = 進程在、只是不歸我們管（幾乎不會發生：同一個用戶起的）——算活著。
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    },
  };
}

/**
 * 連接器啟動時調一次：本機已經有一個活著的同 kind 連接器 → 說一句人話並返回它的 pid，
 * 由調用方 `process.exit(0)`。沒有就返回 null（絕大多數情況，一聲不吭）。
 */
export function yieldToRunningInstance(kind: string, deps: YieldDeps = realYieldDeps(kind)): number | null {
  const other = shouldYieldToRunningInstance(deps);
  if (other === null) return null;
  console.log(
    `· A Macchiato ${kind} connector is already running on this machine (pid ${other}) — ` +
      "this one is exiting so the two don't fight over the same link. The running one keeps working; nothing for you to do.",
  );
  return other;
}

/**
 * 本進程實際跑的連接器樹。取 `process.argv[1]`（tsx 下就是 `<app>/src/index.ts`）往上兩級。
 * 認不出來 → null，調用方按「不是安裝樹」處理（不補、不猜）。
 *
 * ⚠️ 必須先對 cwd 絕對化：**手起**恰恰是最常見的相對路徑場景——用戶 `cd ~/.macchiato/codex-app`
 * 再 `./node_modules/.bin/tsx src/index.ts`，argv[1] 就是 `src/index.ts`。不絕對化的話，
 * 本模塊唯一要救的那類進程正好全被判成「不是安裝樹」，一台都補不上。
 */
export function resolveRunningAppRoot(argv1: string | undefined, cwd: string = process.cwd()): string | null {
  if (!argv1) return null;
  const dir = dirname(resolve(cwd, argv1)); // <app>/src
  if (basename(dir) !== "src") return null;
  return dirname(dir);
}

/** 兩條路徑是否指同一個目錄（realpath 拉平 symlink 與 macOS 的 /var→/private/var）。 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p.replace(/\/+$/, "");
    }
  };
  return norm(a) === norm(b);
}

/**
 * 補裝主體。**永不拋**——自啟是錦上添花，絕不能反過來讓連接器起不來。
 */
export function ensureAutostart(kind: string, deps: AutostartDeps): AutostartResult {
  try {
    return ensureAutostartInner(kind, deps);
  } catch (err) {
    return { outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

function ensureAutostartInner(kind: string, deps: AutostartDeps): AutostartResult {
  const { env, home } = deps;
  // #767 外部托管（system unit / 容器 / 一體機鏡像）明說了「別碰服務單元」——那條紀律在這裡同樣算數。
  if (truthy(env.MACCHIATO_SKIP_UNIT) || truthy(env.MACCHIATO_NO_AUTOSTART) || env.MACCHIATO_PAIR_ONLY) {
    return { outcome: "opted-out" };
  }
  if (isProcessManaged(env, deps.supervised)) return { outcome: "managed" };

  const installedRoot = defaultConnectorAppRoot(kind);
  if (!deps.appRoot || !deps.exists(installedRoot) || !samePath(deps.appRoot, installedRoot)) {
    return { outcome: "not-installed-tree", detail: deps.appRoot ?? "(unknown)" };
  }

  const unit = unitNameFor(kind);
  const isDarwin = deps.platform === "darwin";
  // install.sh 的 have_systemd 判據：有 systemctl 且 /run/systemd/system 在（容器裡通常沒有）。
  const hasSystemd = deps.platform === "linux" && deps.exists("/run/systemd/system");
  if (!isDarwin && !hasSystemd) return { outcome: "unsupported", detail: deps.platform };

  const unitPath = isDarwin ? launchdPlistPath(home, unit) : systemdUnitPath(home, unit);
  // 已有單元 = 這台機器本來就會自啟（可能只是這次被手動多起了一個）——一個字節都不改。
  if (deps.exists(unitPath)) return { outcome: "unit-present", unitPath };

  const tsx = join(installedRoot, "node_modules", ".bin", "tsx");
  if (!deps.exists(tsx)) {
    return { outcome: "failed", detail: `找不到 ${tsx}（安裝樹不完整，不寫一個開機必炸的單元）` };
  }
  // 有 supervisor 就照 install.sh 的形狀包一層（壞包自愈 + 自動更新都靠它）；沒有就直跑。
  const supervise = join(home, ".macchiato", "bin", "macchiato-supervise");
  const args = deps.exists(supervise)
    ? [supervise, kind, "--", tsx, "src/index.ts"]
    : [tsx, "src/index.ts"];

  const spec: UnitSpec = {
    unit,
    args,
    workingDir: installedRoot,
    env: collectUnitEnv(env, process.execPath),
    logPath: join(home, ".macchiato", "logs", `${unit}.log`),
  };

  if (isDarwin) {
    // launchd 只在目錄已存在時才建 StandardOutPath 那個文件；目錄不在就靜默不落日誌，
    // 而這個連接器的日誌恰恰是「開機後它到底起沒起」唯一的線索。
    deps.ensureDir(dirname(spec.logPath));
    deps.writeUnit(unitPath, renderLaunchdPlist(spec), 0o644);
    // 不 bootstrap：見文件頭第 2 條。plist 躺在 ~/Library/LaunchAgents 裡，下次登入 launchd 自己加載。
    return { outcome: "installed", unitPath };
  }

  deps.writeUnit(unitPath, renderSystemdUnit(spec), 0o644);
  deps.run("systemctl", ["--user", "daemon-reload"]);
  if (!deps.run("systemctl", ["--user", "enable", `${unit}.service`])) {
    return { outcome: "failed", unitPath, detail: `systemctl --user enable ${unit}.service 失敗` };
  }
  // #430 沒有 linger，user manager 會在最後一個會話結束後被拆掉，連帶拆掉這個 unit——
  // 「開機自啟」在 headless 機器上等於沒有。能自己開就開，開不了不算失敗（桌面 Linux 無所謂）。
  const who = safeEnvValue(env.USER) ?? safeEnvValue(env.LOGNAME);
  if (who) deps.run("loginctl", ["enable-linger", who]);
  return { outcome: "installed", unitPath };
}

/** 真實依賴。 */
export function realAutostartDeps(kind: string): AutostartDeps {
  return {
    env: process.env,
    platform: osPlatform(),
    home: homedir(),
    appRoot: resolveRunningAppRoot(process.argv[1]),
    supervised: supervisorUpdateReport(kind).supervised === true,
    exists: (p) => existsSync(p),
    ensureDir: (p) => {
      mkdirSync(p, { recursive: true });
    },
    writeUnit: (path, content, mode) => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
      try {
        writeFileSync(tmp, content, { mode });
        renameSync(tmp, path);
      } catch (err) {
        try {
          unlinkSync(tmp);
        } catch {
          /* 沒殘骸就沒事 */
        }
        throw err;
      }
    },
    run: (cmd, args) => {
      try {
        execFileSync(cmd, args, { stdio: "ignore", timeout: 15_000 });
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * 連接器啟動時調一次。**同步、極廉價**（幾個 stat），失敗只打一行日誌。
 *
 * 只在真補上時說話：其餘情形（已托管、單元已在、開發樹）保持安靜——用戶不需要知道
 * 我們每次啟動都檢查了一遍，那是我們的事。
 */
export function ensureAutostartOnStartup(kind: string, deps: AutostartDeps = realAutostartDeps(kind)): AutostartResult {
  const result = ensureAutostart(kind, deps);
  if (result.outcome === "installed") {
    console.log(
      `· Autostart registered (${result.unitPath}) — this connector will now start by itself after a reboot; no need to launch it by hand.`,
    );
  } else if (result.outcome === "unit-present") {
    // 走到這裡 = 單元檔在、但那個單元此刻並沒有在跑（真跑著的話 `yieldToRunningInstance`
    // 已經讓這個進程退掉了）。多半是它沒被加載 / 起崩了——說一句，別讓人自己猜。
    console.log(
      `· Autostart is already configured (${result.unitPath}) but nothing was running — this hand-started copy takes over for now; it starts on its own after your next login.`,
    );
  } else if (result.outcome === "failed") {
    console.error(`[autostart] 未能補上開機自啟:${result.detail ?? "unknown"}`);
  }
  return result;
}
