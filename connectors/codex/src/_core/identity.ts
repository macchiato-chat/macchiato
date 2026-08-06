/**
 * TS 三家 connector 的身份常量与磁盘路径映射（#572）。
 * Hermes 是 Python 第四实现，不进本包。
 */
import { homedir } from "node:os";
import { join } from "node:path";

export type ConnectorKind = "claude-code" | "codex" | "openclaw";

export const CONNECTOR_KINDS = ["claude-code", "codex", "openclaw"] as const;

/**
 * 本實例狀態根（`MACCHIATO_STATE_DIR`，默認 `~/.macchiato`）。
 *
 * 與 Hermes `connector.py` 的 `STATE_DIR` 同名同語義（#309 profile 隔離）：同一台機器上跑多實例時，
 * 每實例的落盤文件都掛在這個根下。含 `~` 的值按 Hermes 的 `expanduser` 語義展開，免得
 * 四家對同一個 env 解出不同目錄。
 */
export function stateDir(): string {
  const raw = (process.env.MACCHIATO_STATE_DIR || "").trim();
  if (!raw) return join(homedir(), ".macchiato");
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return raw;
}

/**
 * #669 本地心跳快照。**這是進程外 supervisor 唯一的連接器接口**——
 * supervisor 絕不能 import 連接器樹（那正是會壞的東西，#528 的起因），所以只能讀文件。
 *
 * **按 kind 分家**：`~/.macchiato` 是四家共用的狀態根（`<kind>-connector.json`、
 * `supervise-<kind>.state` 早就按 kind 分了）。同機裝了 CC + Codex 時共用一個 `health.json`
 * 會讓兩家互相覆蓋——於是「CC 的 supervisor 讀到 Codex 的斷連狀態並重裝 CC」，
 * 一個誤判就是全體重裝循環。故 supervisor 只認 `health-<kind>.json`。
 *
 * 不帶 kind 調用 → 歷史上的 `health.json`（Hermes 從 0.12.0 起就在寫，本機 inspect 用，
 * 保持不動；Hermes 兩份都寫）。
 */
export function healthFilePath(kind?: string): string {
  return join(stateDir(), kind ? `health-${kind}.json` : "health.json");
}

/** #669 本機安裝的穩定標識（首次生成後持久化；分批放量的哈希種子）。 */
export function installIdPath(): string {
  return join(stateDir(), "install-id");
}

/** UI / 配对文案用展示名（可被 MACCHIATO_PAIR_GROUP 覆盖）。 */
export const DISPLAY_NAME: Record<ConnectorKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  openclaw: "OpenClaw",
};

/** 默认 agent 标签前缀：`Claude Code (hostname)`。 */
export function defaultPairLabel(kind: ConnectorKind, host: string): string {
  return `${DISPLAY_NAME[kind]} (${host})`;
}

const CRED_ENV: Record<ConnectorKind, string> = {
  "claude-code": "MACCHIATO_CLAUDE_CODE_CRED",
  codex: "MACCHIATO_CODEX_CRED",
  openclaw: "MACCHIATO_OPENCLAW_CRED",
};

const CRED_FILE: Record<ConnectorKind, string> = {
  "claude-code": "claude-code-connector.json",
  codex: "codex-connector.json",
  openclaw: "openclaw-connector.json",
};

const E2E_STORE_ENV: Record<ConnectorKind, string> = {
  "claude-code": "MACCHIATO_CLAUDE_CODE_E2E_STORE",
  codex: "MACCHIATO_CODEX_E2E_STORE",
  openclaw: "MACCHIATO_OPENCLAW_E2E_STORE",
};

const E2E_STORE_FILE: Record<ConnectorKind, string> = {
  "claude-code": "claude-code-e2e.json",
  codex: "codex-e2e.json",
  openclaw: "openclaw-e2e.json",
};

const E2E_CONTROL_ENV: Record<ConnectorKind, string> = {
  "claude-code": "MACCHIATO_CLAUDE_CODE_E2E_CONTROL_STORE",
  codex: "MACCHIATO_CODEX_E2E_CONTROL_STORE",
  openclaw: "MACCHIATO_OPENCLAW_E2E_CONTROL_STORE",
};

export function credPath(kind: ConnectorKind): string {
  const env = process.env[CRED_ENV[kind]];
  if (env) return env;
  return join(homedir(), ".macchiato", CRED_FILE[kind]);
}

export function e2eStorePath(kind: ConnectorKind): string {
  const env = process.env[E2E_STORE_ENV[kind]];
  if (env) return env;
  return join(homedir(), ".macchiato", E2E_STORE_FILE[kind]);
}

function adjacentControlPath(keyStorePath: string): string {
  return keyStorePath.endsWith(".json")
    ? `${keyStorePath.slice(0, -".json".length)}-control.json`
    : `${keyStorePath}-control.json`;
}

export function e2eControlStorePath(kind: ConnectorKind): string {
  const env = process.env[E2E_CONTROL_ENV[kind]];
  if (env) return env;
  return adjacentControlPath(e2eStorePath(kind));
}

/** Projects 注册表（仅 claude-code / codex；openclaw 无此模型）。 */
export type ProjectsKind = "claude-code" | "codex";

const PROJECTS_ENV: Record<ProjectsKind, string> = {
  "claude-code": "MACCHIATO_CC_PROJECTS",
  codex: "MACCHIATO_CODEX_PROJECTS",
};

const PROJECTS_FILE: Record<ProjectsKind, string> = {
  "claude-code": "cc-projects.json",
  codex: "codex-projects.json",
};

export function projectsRegPath(kind: ProjectsKind): string {
  const env = process.env[PROJECTS_ENV[kind]];
  if (env) return env;
  return join(homedir(), ".macchiato", PROJECTS_FILE[kind]);
}

/** cwd 校验用的 env 名（仅 claude-code / codex）。 */
export type CwdKind = "claude-code" | "codex";

const WORKDIR_ENV: Record<CwdKind, string> = {
  "claude-code": "MACCHIATO_CC_WORKDIR",
  codex: "MACCHIATO_CODEX_WORKDIR",
};

const ALLOWED_ROOTS_ENV: Record<CwdKind, string> = {
  "claude-code": "MACCHIATO_CC_ALLOWED_ROOTS",
  codex: "MACCHIATO_CODEX_ALLOWED_ROOTS",
};

export function workdirEnvName(kind: CwdKind): string {
  return WORKDIR_ENV[kind];
}

export function allowedRootsEnvName(kind: CwdKind): string {
  return ALLOWED_ROOTS_ENV[kind];
}

/**
 * Attach **落盘**（claude-code / codex 同构；openclaw 走内存 base64，没有这个目录）。
 *
 * 路径 + 配额/并发/TTL 的 **env 名** 在这里单源（#631：materialize/gc 已抽进
 * `attachments/store`，按 `AttachKind` 读这些 env）。OpenClaw 仍不进这条路径。
 * CC 独有的 `imageBlockFor` 留在 CC（原生图片 block；Codex exec 无图片输入）。
 */
export type AttachKind = "claude-code" | "codex";

const ATTACH_DIR_ENV: Record<AttachKind, string> = {
  "claude-code": "MACCHIATO_CC_ATTACH_DIR",
  codex: "MACCHIATO_CODEX_ATTACH_DIR",
};
const ATTACH_DIR_FILE: Record<AttachKind, string> = {
  "claude-code": "cc-attachments",
  codex: "codex-attachments",
};

const ATTACH_QUOTA_ENV: Record<AttachKind, string> = {
  "claude-code": "MACCHIATO_CC_ATTACH_QUOTA_BYTES",
  codex: "MACCHIATO_CODEX_ATTACH_QUOTA_BYTES",
};
const ATTACH_MAX_INFLIGHT_ENV: Record<AttachKind, string> = {
  "claude-code": "MACCHIATO_CC_ATTACH_MAX_INFLIGHT",
  codex: "MACCHIATO_CODEX_ATTACH_MAX_INFLIGHT",
};
const ATTACH_TTL_ENV: Record<AttachKind, string> = {
  "claude-code": "MACCHIATO_CC_ATTACH_TTL_S",
  codex: "MACCHIATO_CODEX_ATTACH_TTL_S",
};
/** 下载请求的 User-Agent（两家历史上就不同，冻结成身份常量）。 */
const ATTACH_USER_AGENT: Record<AttachKind, string> = {
  "claude-code": "macchiato-cc-connector",
  codex: "macchiato-codex-connector",
};

export function attachDir(kind: AttachKind): string {
  const env = process.env[ATTACH_DIR_ENV[kind]];
  if (env) return env;
  return join(homedir(), ".macchiato", ATTACH_DIR_FILE[kind]);
}

export function attachQuotaEnvName(kind: AttachKind): string {
  return ATTACH_QUOTA_ENV[kind];
}

export function attachMaxInflightEnvName(kind: AttachKind): string {
  return ATTACH_MAX_INFLIGHT_ENV[kind];
}

export function attachTtlEnvName(kind: AttachKind): string {
  return ATTACH_TTL_ENV[kind];
}

export function attachUserAgent(kind: AttachKind): string {
  return ATTACH_USER_AGENT[kind];
}
