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
      titled: new Set<string>(Array.isArray(p.titled) ? p.titled : []),
      pending: Array.isArray(p.pending) ? (p.pending as string[]) : [], // #200
    };
  } catch {
    return { map: {}, cwds: {}, models: {}, titled: new Set(), pending: [] };
  }
}

export function saveDriveState(st: { map: Record<string, string>; cwds: Record<string, string>; models: Record<string, string>; titled: Iterable<string>; pending: Iterable<string> }): void {
  try {
    mkdirSync(dirname(mapPath()), { recursive: true });
    const tmp = `${mapPath()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, map: st.map, cwds: st.cwds, models: st.models, titled: [...st.titled], pending: [...st.pending] }));
    renameSync(tmp, mapPath());
  } catch (e) {
    console.error("[session map save failed]", (e as Error).message);
  }
}
