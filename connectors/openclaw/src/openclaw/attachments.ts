/**
 * #60 附件入站:下載 server 下發的 presigned GET url → base64 → `chat.send` 的
 * `attachments` 參數(gateway 原生支持:normalizeRpcAttachmentsToChatAttachments 收
 * {mimeType, fileName, content:base64},落 agent 工作區/圖片走視覺,上限默認 20MB——
 * 2026-07-12 讀 openclaw 2026.6.11 dist 源碼確認)。
 * SSRF / 本地文件防護移植 CC 連接器 #72(同 Hermes #12 修復):只允許 https；生產默認拒 loopback(#379)；dev 須 MACCHIATO_ATTACH_ALLOW_LOCALHOST=1;目標解析後不得落私網/環回/link-local/保留段;下載封頂。
 *
 * #383:Content-Length 早拒;並發下載上限;流式計數 + 超限即 destroy(不整塊無界緩衝)。
 * OpenClaw 需 base64 內聯給 gateway,仍在上限內拼 buffer——關鍵是早拒 + 流式上限 + 失敗丟棄。
 */
import * as http from "node:http";
import * as https from "node:https";
import type { IncomingMessage } from "node:http";
import {
  isPrivateIp,
  isAllowedLocalHttp,
  validateDownloadUrl,
  pinnedLookup,
} from "../_core/attachments/ssrf";
export { isPrivateIp, isAllowedLocalHttp, validateDownloadUrl, pinnedLookup };

/** OpenClaw chat 附件默認上限(resolveChatAttachmentMaxBytes:mediaMaxMb 未配=20MB)。 */
export const DOWNLOAD_MAX = 20 * 1024 * 1024;
/** 並發下載默認 3(env `MACCHIATO_OPENCLAW_ATTACH_MAX_INFLIGHT` 可調)。 */
export const ATTACH_MAX_INFLIGHT_DEFAULT = 3;

export function attachMaxInflight(): number {
  const n = Number(process.env.MACCHIATO_OPENCLAW_ATTACH_MAX_INFLIGHT ?? ATTACH_MAX_INFLIGHT_DEFAULT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : ATTACH_MAX_INFLIGHT_DEFAULT;
}

let inflightDownloads = 0;
export function attachInflightCount(): number {
  return inflightDownloads;
}
/** @internal 測試重置 / 佔位。 */
export function _resetAttachInflightForTest(): void {
  inflightDownloads = 0;
}
/** @internal 測試佔位 in-flight。 */
export function _setAttachInflightForTest(n: number): void {
  inflightDownloads = Math.max(0, Math.floor(n));
}

function sanitizeName(name: string): string {
  const base = (name || "file").split(/[/\\]/).pop() || "file";
  return base.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "file";
}

export interface ChatAttachment {
  mimeType?: string;
  fileName: string;
  content: string; // base64
}

/** 下載附件到內存,轉 `chat.send` attachments 形狀。拋錯=該附件失敗(caller 降級回執)。 */
export async function fetchChatAttachment(ref: {
  id?: unknown;
  name?: unknown;
  mime?: unknown;
  url?: unknown;
}): Promise<ChatAttachment> {
  const url = String(ref.url ?? "");
  await validateDownloadUrl(url); // 早拒:scheme / 字面私網

  const maxInf = attachMaxInflight();
  if (inflightDownloads >= maxInf) {
    throw new Error(`附件並發下載達上限 ${maxInf}`);
  }
  inflightDownloads += 1;

  try {
    const u = new URL(url);
    const isLocalHttp = u.protocol === "http:";
    const mod = u.protocol === "https:" ? https : http;
    // #249 node http/https 默認不跟隨重定向 → 順帶堵死 redirect-based SSRF;https 掛 pinnedLookup 校驗實際 IP。
    const res: IncomingMessage = await new Promise((resolve, reject) => {
      const req = mod.get(
        url,
        { headers: { "user-agent": "macchiato-openclaw-connector" }, ...(isLocalHttp ? {} : { lookup: pinnedLookup }) },
        (r) => {
          const code = r.statusCode ?? 0;
          if (code >= 300) {
            r.resume();
            return reject(new Error(`下載失敗/拒重定向 HTTP ${code}`));
          }
          resolve(r);
        },
      );
      req.on("error", reject);
      req.setTimeout(60_000, () => req.destroy(new Error("下載超時")));
    });

    // Content-Length 早拒:帶頭且 > DOWNLOAD_MAX → 不進 buffer
    const clRaw = res.headers["content-length"];
    if (clRaw != null && clRaw !== "") {
      const cl = Number(clRaw);
      if (Number.isFinite(cl) && cl > DOWNLOAD_MAX) {
        res.resume();
        throw new Error(`Content-Length ${cl} 超過上限 ${DOWNLOAD_MAX} 字節(OpenClaw chat 附件默認 20MB)`);
      }
    }

    // #383 流式計數 + 上限:超限即 destroy 並丟棄已收 chunk(不整塊無界緩衝)
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of res as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > DOWNLOAD_MAX) {
          try {
            res.destroy();
          } catch {
            /* */
          }
          chunks.length = 0;
          throw new Error(`附件超過上限 ${DOWNLOAD_MAX} 字節(OpenClaw chat 附件默認 20MB)`);
        }
        chunks.push(Buffer.from(chunk));
      }
    } catch (e) {
      chunks.length = 0;
      throw e;
    }

    const mime = typeof ref.mime === "string" && ref.mime ? ref.mime : undefined;
    return {
      ...(mime ? { mimeType: mime } : {}),
      fileName: sanitizeName(String(ref.name ?? "file")),
      content: Buffer.concat(chunks).toString("base64"),
    };
  } finally {
    inflightDownloads = Math.max(0, inflightDownloads - 1);
  }
}
