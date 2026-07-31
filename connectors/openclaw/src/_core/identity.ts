/**
 * TS 三家 connector 的身份常量与磁盘路径映射（#572）。
 * Hermes 是 Python 第四实现，不进本包。
 */
import { homedir } from "node:os";
import { join } from "node:path";

export type ConnectorKind = "claude-code" | "codex" | "openclaw";

export const CONNECTOR_KINDS = ["claude-code", "codex", "openclaw"] as const;

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
 * Attach **落盘根**（claude-code / codex 同构；openclaw 走内存 base64，没有这个目录）。
 *
 * 只放路径：配额 / 并发上限 / TTL 那几个 env 各家读法与默认值本就不同，且 openclaw 的
 * 那份这里根本建模不了——放进来会变成「看着单源、实际只覆盖两家」的假单源。
 * materialize / gc 也仍在各家（产品形态分叉，见 README 的「刻意不进本包」）。
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

export function attachDir(kind: AttachKind): string {
  const env = process.env[ATTACH_DIR_ENV[kind]];
  if (env) return env;
  return join(homedir(), ".macchiato", ATTACH_DIR_FILE[kind]);
}
