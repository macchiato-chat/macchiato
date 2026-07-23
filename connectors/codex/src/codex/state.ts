/**
 * #132 exec v1 / app-server v2 兩個 drive 共用的持久狀態(~/.macchiato/codex-sessions.json):
 * sid↔thread 映射、cwd/model、#113 已標題集、#200 在途回合。單寫者(同一進程只跑一個 drive)。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function mapPath(): string {
  return process.env.MACCHIATO_CODEX_SESSIONS || join(homedir(), ".macchiato/codex-sessions.json");
}

export interface DriveState {
  map: Record<string, string>;
  cwds: Record<string, string>;
  models: Record<string, string>;
  efforts: Record<string, string>;
  /** #230 serverSid → per-session permissionMode(UI 五檔的字符串;codex 只認 plan/auto/bypass 三檔)。 */
  perms: Record<string, string>;
  titled: Set<string>;
  pending: string[];
  /**
   * sid↔thread 身份快照是否由主檔完整、嚴格解析而來。
   * .bak 是舊一代，缺/壞主檔時只能作可用性恢復，不能證明沒有漏掉最新 E2E 映射。
   */
  identityStateTrusted: boolean;
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || typeof item !== "string") throw new Error(`${field} contains an invalid entry`);
    out[key] = item;
  }
  return out;
}

function parseDriveState(raw: string, identityStateTrusted: boolean): DriveState {
  const p = JSON.parse(raw) as Record<string, unknown>;
  if (p === null || typeof p !== "object" || Array.isArray(p)) throw new Error("state root must be an object");
  const pending = p.pending === undefined ? [] : p.pending;
  const titled = p.titled === undefined ? [] : p.titled;
  if (!Array.isArray(pending) || pending.some((sid) => typeof sid !== "string" || !sid)) {
    throw new Error("pending must contain non-empty strings");
  }
  if (!Array.isArray(titled) || titled.some((sid) => typeof sid !== "string" || !sid)) {
    throw new Error("titled must contain non-empty strings");
  }
  return {
    // map 是 E2E local↔wire 的安全邊界，缺字段不能再被 `?? {}` 靜默洗成可信空映射。
    map: stringRecord(p.map, "map"),
    cwds: stringRecord(p.cwds ?? {}, "cwds"),
    models: stringRecord(p.models ?? {}, "models"),
    efforts: stringRecord(p.efforts ?? {}, "efforts"),
    perms: stringRecord(p.perms ?? {}, "perms"),
    titled: new Set<string>(titled as string[]),
    pending: pending as string[],
    identityStateTrusted,
  };
}

export function loadDriveState(): DriveState {
  // #248 主檔壞/缺 → 試 .bak(此前無備份:codex-sessions.json 損壞即 sid↔thread 映射蒸發、
  // 全會話丟上下文)。兩檔都壞才回空。
  for (const [path, isPrimary] of [[mapPath(), true], [mapPath() + ".bak", false]] as const) {
    try {
      return parseDriveState(readFileSync(path, "utf8"), isPrimary);
    } catch {
      /* 試下一個 */
    }
  }
  return {
    map: {},
    cwds: {},
    models: {},
    efforts: {},
    perms: {},
    titled: new Set(),
    pending: [],
    identityStateTrusted: false,
  };
}

export function saveDriveState(st: { map: Record<string, string>; cwds: Record<string, string>; models: Record<string, string>; efforts: Record<string, string>; perms: Record<string, string>; titled: Iterable<string>; pending: Iterable<string> }): boolean {
  try {
    mkdirSync(dirname(mapPath()), { recursive: true });
    const snapshot = JSON.stringify({ v: 1, map: st.map, cwds: st.cwds, models: st.models, efforts: st.efforts, perms: st.perms, titled: [...st.titled], pending: [...st.pending] });
    const tmp = `${mapPath()}.tmp`;
    const backupTmp = `${mapPath()}.bak.tmp`;
    writeFileSync(tmp, snapshot);
    renameSync(tmp, mapPath());
    // 身份備份也保存當前完整代，避免主檔 crash 後回退到漏最新 E2E 映射的上一代。
    writeFileSync(backupTmp, snapshot);
    renameSync(backupTmp, mapPath() + ".bak");
    return true;
  } catch (e) {
    console.error("[session map save failed]", (e as Error).message);
    return false;
  }
}

/**
 * #255 bypass(danger-full-access + never)= server 一幀即在用戶機器**全開不問任意執行**的高危檔。
 * 必須本地顯式開放:env `MACCHIATO_CODEX_ALLOW_BYPASS` 真值,或進程級 `MACCHIATO_CODEX_SANDBOX`
 * 本就是 danger-full-access(操作者已 opt-in)。否則 server 下發的 bypass 降級 auto(workspace-write
 * + on-request,越界才問)——對齊 CC #255 與 projects.ts「server 攻破也指不動」紀律。
 */
export function codexBypassAllowed(): boolean {
  const v = process.env.MACCHIATO_CODEX_ALLOW_BYPASS;
  if (v && /^(1|true|yes|on)$/i.test(v.trim())) return true;
  return process.env.MACCHIATO_CODEX_SANDBOX === "danger-full-access";
}

/**
 * #230 UI 的 permissionMode → codex (sandbox, approvalPolicy)。只認 codex 有意義的三檔;
 * 其餘(ask/acceptEdits/未設)返回 undefined → 調用方回退進程級 env 默認。
 * - plan   → 只讀:read-only + on-request(讀隨意,寫/執行前必問)
 * - auto   → 工作區寫入:workspace-write + on-request(工作區內自動,越界才問)
 * - bypass → 完全訪問:danger-full-access + never(全開,不問);#255 未本地開放 → 降級 auto
 */
export function codexPermsFor(mode: string | undefined): { sandbox: string; approval: string } | undefined {
  switch (mode) {
    case "plan":
      return { sandbox: "read-only", approval: "on-request" };
    case "auto":
      return { sandbox: "workspace-write", approval: "on-request" };
    case "bypass":
      return codexBypassAllowed()
        ? { sandbox: "danger-full-access", approval: "never" }
        : { sandbox: "workspace-write", approval: "on-request" }; // #255 降級
    default:
      return undefined;
  }
}

/** #310 codex 認證失敗特徵(auth.json 過期/未登錄/401)。窄匹配防誤傷("author"、403 權限類不算)。
 * v1(drive)對 stderr、v2(drive-appserver)對 turn error message 同判。 */
export const CODEX_AUTH_ERR_RE = /\b401\b|unauthoriz|authenticat|not.?logged.?in|token.{0,12}expired|invalid.?api.?key|login.?required/i;
