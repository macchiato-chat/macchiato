/**
 * #146(codex):附件入站——落盤 + 路徑注入 prompt 讓 codex 用讀檔工具訪問
 * （無原生 image block：codex exec 無圖片輸入）。
 *
 * #631：落盘 / 配额 / 并发 / gc 同构层单源于 `@macchiato/connector-core/attachments/store`；
 * SSRF 原语单源于 `attachments/ssrf`。本文件只留按 KIND 绑定的薄包装（对外 API 不变）。
 */
import {
  isPrivateIp,
  isAllowedLocalHttp,
  validateDownloadUrl,
  pinnedLookup,
} from "../_core/attachments/ssrf";
import {
  DOWNLOAD_MAX,
  ATTACH_QUOTA_DEFAULT,
  ATTACH_MAX_INFLIGHT_DEFAULT,
  attachQuotaBytes as coreAttachQuotaBytes,
  attachMaxInflight as coreAttachMaxInflight,
  attachInflightCount as coreAttachInflightCount,
  _resetAttachInflightForTest as coreResetAttachInflightForTest,
  _setAttachInflightForTest as coreSetAttachInflightForTest,
  duAttachRoot as coreDuAttachRoot,
  materializeAttachment as coreMaterializeAttachment,
  gcAttachments as coreGcAttachments,
  type AttachmentRefLike,
} from "../_core/attachments/store";
import { KIND } from "../identity";

export { isPrivateIp, isAllowedLocalHttp, validateDownloadUrl, pinnedLookup };
export { DOWNLOAD_MAX, ATTACH_QUOTA_DEFAULT, ATTACH_MAX_INFLIGHT_DEFAULT };
export type { AttachmentRefLike };

export function attachQuotaBytes(): number {
  return coreAttachQuotaBytes(KIND);
}

export function attachMaxInflight(): number {
  return coreAttachMaxInflight(KIND);
}

/** 進程內 in-flight 計數(單連接器實例)。測試可讀。 */
export function attachInflightCount(): number {
  return coreAttachInflightCount(KIND);
}

/** @internal 測試重置 / 佔位。 */
export function _resetAttachInflightForTest(): void {
  coreResetAttachInflightForTest(KIND);
}

/** @internal 測試佔位 in-flight。 */
export function _setAttachInflightForTest(n: number): void {
  coreSetAttachInflightForTest(KIND, n);
}

/** 統計 attach root 佔用(lstat,不跟隨 symlink;只計常規文件)。 */
export function duAttachRoot(root?: string): number {
  return root === undefined ? coreDuAttachRoot(KIND) : coreDuAttachRoot(KIND, root);
}

export async function materializeAttachment(ref: AttachmentRefLike): Promise<string> {
  return coreMaterializeAttachment(KIND, ref);
}

/** #151 入站附件 TTL GC（節流在 core 內）。 */
export function gcAttachments(now = Date.now()): number {
  return coreGcAttachments(KIND, now);
}
