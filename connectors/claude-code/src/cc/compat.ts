/**
 * #76 CLI 兼容自檢：transcript 是官方標注的**內部格式**,CLI 大版本升級可能破壞解析。
 *  - 版本門檻:低於已知最低支持版 → 標記不兼容(app 顯示降級,不靜默丟消息)。
 *  - 解析冒煙:對最新一個真實 transcript 跑 foldEntries,拋錯/零產出視為格式漂移。
 * 純函數,便於單測;health 定期調用把結果經 compatOk 上報。
 */
import { statSync } from "node:fs";
import { discoverSessions } from "./mirror";
import { foldEntries, readEntries } from "./transcripts";

/** 已知可解析的最低 CLI 版本(隨驗證過的版本上調;低於此不保證 transcript 格式)。 */
export const MIN_CLI_VERSION = "2.0.0";

/** 解析 "2.1.201 (Claude Code)" / "2.1.201" → [2,1,201];失敗 → null。 */
export function parseVersion(s: string): [number, number, number] | null {
  const m = s.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a >= b ? */
export function versionGte(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! > pb[i]!) return true;
    if (pa[i]! < pb[i]!) return false;
  }
  return true;
}

export interface CompatResult {
  ok: boolean;
  reason?: string;
}

/** 版本門檻檢查。 */
export function checkVersion(cliVersion: string | undefined): CompatResult {
  if (!cliVersion) return { ok: false, reason: "claude CLI 未找到" };
  if (!parseVersion(cliVersion)) return { ok: false, reason: `無法解析版本:${cliVersion}` };
  if (!versionGte(cliVersion, MIN_CLI_VERSION))
    return { ok: false, reason: `CLI ${cliVersion} 低於最低支持 ${MIN_CLI_VERSION}` };
  return { ok: true };
}

/** 對最近修改的一個 transcript 跑解析冒煙:能讀到消息=格式仍兼容;拋錯/該文件解析零產出=漂移。 */
export function smokeParseLatest(): CompatResult {
  const files = discoverSessions();
  if (!files.length) return { ok: true }; // 無 transcript 可測,不判失敗(新機器)
  let latest = files[0]!;
  let latestMtime = 0;
  for (const f of files) {
    try {
      const mt = statSync(f.file).mtimeMs;
      if (mt > latestMtime) {
        latestMtime = mt;
        latest = f;
      }
    } catch {
      /* 跳過 */
    }
  }
  try {
    const { entries, endOffset } = readEntries(latest.file, 0);
    if (!entries.length) return { ok: true }; // 文件空/半行,不判失敗
    const { messages } = foldEntries(entries, endOffset, Number.MAX_SAFE_INTEGER);
    if (messages.length === 0)
      return { ok: false, reason: `最新 transcript 解析零消息(格式可能漂移):${latest.sid}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `transcript 解析拋錯(格式漂移):${(e as Error).message}` };
  }
}

/** 綜合:版本門檻 + 解析冒煙,任一失敗即不兼容。 */
export function checkCompat(cliVersion: string | undefined): CompatResult {
  const v = checkVersion(cliVersion);
  if (!v.ok) return v;
  return smokeParseLatest();
}
