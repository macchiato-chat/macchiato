/**
 * #76/#112 Codex 兼容自檢:版本門檻 + 最新 rollout 解析冒煙。不兼容 → compatOk=false(app 顯示降級)。
 * codex 發版節奏快(2-4 天一版),rollout 格式無穩定承諾 → 冒煙抓格式漂移於未爆之時。
 */
import { readFileSync } from "node:fs";
import { discoverRollouts } from "./mirror";
import { readNewMessages } from "./transcripts";

export const MIN_CLI_VERSION = "0.140.0";
/** #258 已實測驗證的 CLI 上限(schema 0.144.1 探針背書)。超出 → 冒煙仍跑,但 health 上浮「超出實測區間」
 * 告警(不判降級——rollout 冒煙通過就放行,只提醒留意升版漂移)。隨每輪驗版更新。 */
export const MAX_VERIFIED_VERSION = "0.144.1";

export function parseVersion(s: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s || "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function versionGte(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return true;
}

export interface CompatResult {
  ok: boolean;
  reason?: string;
  /** #258 非致命提醒(如 CLI 超出實測驗證上限)——ok 仍為 true,只上浮 health 供留意。 */
  advisory?: string;
}

export function checkVersion(cliVersion: string | undefined): CompatResult {
  if (!cliVersion) return { ok: false, reason: "codex CLI 未找到" };
  if (!parseVersion(cliVersion)) return { ok: false, reason: `無法解析版本:${cliVersion}` };
  if (!versionGte(cliVersion, MIN_CLI_VERSION)) return { ok: false, reason: `CLI ${cliVersion} 低於最低支持 ${MIN_CLI_VERSION}` };
  return { ok: true };
}

/** 拿最新 rollout 解析冒煙:能讀到消息或至少解析不炸=格式仍兼容。無文件不判失敗。 */
export function smokeParseLatest(): CompatResult {
  const { rollouts } = discoverRollouts();
  if (!rollouts.length) return { ok: true };
  let latest = rollouts[0]!.file;
  let mt = 0;
  for (const r of rollouts) {
    try {
      const t = require("node:fs").statSync(r.file).mtimeMs;
      if (t > mt) {
        mt = t;
        latest = r.file;
      }
    } catch {
      /* 跳過 */
    }
  }
  try {
    const content = readFileSync(latest, "utf8");
    if (!content.trim()) return { ok: true };
    readNewMessages(content, 0, 0); // 解析全文,不炸即可(空消息不算漂移:可能是純工具會話)
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `rollout 解析拋錯(格式漂移):${(e as Error).message}` };
  }
}

export function checkCompat(cliVersion: string | undefined): CompatResult {
  const v = checkVersion(cliVersion);
  if (!v.ok) return v;
  const smoke = smokeParseLatest();
  if (!smoke.ok) return smoke;
  // #258 冒煙通過但 CLI 超出實測驗證上限 → 放行 + 上浮告警(升版漂移早提醒,不判降級)。
  if (cliVersion && versionGte(cliVersion, MAX_VERIFIED_VERSION) && cliVersion !== MAX_VERIFIED_VERSION) {
    return { ok: true, advisory: `CLI ${cliVersion} 超出實測驗證上限 ${MAX_VERIFIED_VERSION}(冒煙通過,留意升版漂移)` };
  }
  return { ok: true };
}
