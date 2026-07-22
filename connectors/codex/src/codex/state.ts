/**
 * #132 exec v1 / app-server v2 兩個 drive 共用的持久狀態(~/.macchiato/codex-sessions.json):
 * sid↔thread 映射、cwd/model、#113 已標題集、#200 在途回合。單寫者(同一進程只跑一個 drive)。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
}

export function loadDriveState(): DriveState {
  // #248 主檔壞/缺 → 試 .bak(此前無備份:codex-sessions.json 損壞即 sid↔thread 映射蒸發、
  // 全會話丟上下文)。兩檔都壞才回空。
  for (const path of [mapPath(), mapPath() + ".bak"]) {
    try {
      const p = JSON.parse(readFileSync(path, "utf8"));
      return {
        map: p.map ?? {},
        cwds: p.cwds ?? {},
        models: p.models ?? {}, // #143
        efforts: p.efforts ?? {}, // #231
        perms: p.perms ?? {}, // #230
        titled: new Set<string>(Array.isArray(p.titled) ? p.titled : []),
        pending: Array.isArray(p.pending) ? (p.pending as string[]) : [], // #200
      };
    } catch {
      /* 試下一個 */
    }
  }
  return { map: {}, cwds: {}, models: {}, efforts: {}, perms: {}, titled: new Set(), pending: [] };
}

export function saveDriveState(st: { map: Record<string, string>; cwds: Record<string, string>; models: Record<string, string>; efforts: Record<string, string>; perms: Record<string, string>; titled: Iterable<string>; pending: Iterable<string> }): void {
  try {
    mkdirSync(dirname(mapPath()), { recursive: true });
    const tmp = `${mapPath()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, map: st.map, cwds: st.cwds, models: st.models, efforts: st.efforts, perms: st.perms, titled: [...st.titled], pending: [...st.pending] }));
    if (existsSync(mapPath())) renameSync(mapPath(), mapPath() + ".bak"); // #248 輪替備份(load 側有 .bak 回退)
    renameSync(tmp, mapPath());
  } catch (e) {
    console.error("[session map save failed]", (e as Error).message);
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
