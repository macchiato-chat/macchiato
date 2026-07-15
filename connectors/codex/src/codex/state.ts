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
}

export function loadDriveState(): DriveState {
  try {
    const p = JSON.parse(readFileSync(mapPath(), "utf8"));
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
    return { map: {}, cwds: {}, models: {}, efforts: {}, perms: {}, titled: new Set(), pending: [] };
  }
}

export function saveDriveState(st: { map: Record<string, string>; cwds: Record<string, string>; models: Record<string, string>; efforts: Record<string, string>; perms: Record<string, string>; titled: Iterable<string>; pending: Iterable<string> }): void {
  try {
    mkdirSync(dirname(mapPath()), { recursive: true });
    const tmp = `${mapPath()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, map: st.map, cwds: st.cwds, models: st.models, efforts: st.efforts, perms: st.perms, titled: [...st.titled], pending: [...st.pending] }));
    renameSync(tmp, mapPath());
  } catch (e) {
    console.error("[session map save failed]", (e as Error).message);
  }
}

/**
 * #230 UI 的 permissionMode → codex (sandbox, approvalPolicy)。只認 codex 有意義的三檔;
 * 其餘(ask/acceptEdits/未設)返回 undefined → 調用方回退進程級 env 默認。
 * - plan   → 只讀:read-only + on-request(讀隨意,寫/執行前必問)
 * - auto   → 工作區寫入:workspace-write + on-request(工作區內自動,越界才問)
 * - bypass → 完全訪問:danger-full-access + never(全開,不問)
 */
export function codexPermsFor(mode: string | undefined): { sandbox: string; approval: string } | undefined {
  switch (mode) {
    case "plan":
      return { sandbox: "read-only", approval: "on-request" };
    case "auto":
      return { sandbox: "workspace-write", approval: "on-request" };
    case "bypass":
      return { sandbox: "danger-full-access", approval: "never" };
    default:
      return undefined;
  }
}
