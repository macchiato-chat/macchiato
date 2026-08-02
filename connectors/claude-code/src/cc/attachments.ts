/**
 * #72 附件入站：下載 server 下發的 presigned GET url 到本地文件,路徑注入 prompt 供 Claude Code
 * 的 Read 工具讀取(圖片走視覺)。
 *
 * #631：落盘 / 配额 / 并发 / gc 同构层单源于 `@macchiato/connector-core/attachments/store`；
 * SSRF 原语单源于 `attachments/ssrf`。本文件只留 CC 独有 `imageBlockFor`（#118 原生图片 block）
 * + 按 KIND 绑定的薄包装（对外 API 不变）。
 */
import { readFileSync, statSync } from "node:fs";
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

/** #118 原生圖片上限:Anthropic API 圖片 ~5MB(base64 後),留餘量取 3.5MB 原始字節。 */
export const IMAGE_BLOCK_MAX = 3_500_000;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * #118 原生圖片入站(#72 升級,#116 c 探針背書):API 支持的圖片類型且 ≤3.5MB → image content
 * block(視覺直達,不再繞 Read 工具);超限/非圖/讀失敗 → null(回退路徑注入,行為同舊)。
 * Codex 無此能力——exec 無圖片輸入，故不進 connector-core。
 */
export function imageBlockFor(path: string, mime: string): Record<string, unknown> | null {
  const mt = mime.toLowerCase();
  if (!IMAGE_MIMES.has(mt)) return null;
  try {
    if (statSync(path).size > IMAGE_BLOCK_MAX) return null;
    return {
      type: "image",
      source: { type: "base64", media_type: mt, data: readFileSync(path).toString("base64") },
    };
  } catch {
    return null;
  }
}

export async function materializeAttachment(ref: AttachmentRefLike): Promise<string> {
  return coreMaterializeAttachment(KIND, ref);
}

/** #151 入站附件 TTL GC（節流在 core 內）。 */
export function gcAttachments(now = Date.now()): number {
  return coreGcAttachments(KIND, now);
}
