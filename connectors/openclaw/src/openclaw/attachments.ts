/**
 * #60 附件入站:下載 server 下發的 presigned GET url → base64 → `chat.send` 的
 * `attachments` 參數(gateway 原生支持:normalizeRpcAttachmentsToChatAttachments 收
 * {mimeType, fileName, content:base64},落 agent 工作區/圖片走視覺,上限默認 20MB——
 * 2026-07-12 讀 openclaw 2026.6.11 dist 源碼確認)。
 * SSRF / 本地文件防護移植 CC 連接器 #72(同 Hermes #12 修復):只允許 https(或
 * http+localhost 的 dev 服務);目標解析後不得落私網/環回/link-local/保留段;下載封頂。
 */
import { lookup } from "node:dns/promises";
import { lookup as dnsLookupCb } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import type { IncomingMessage } from "node:http";

/** OpenClaw chat 附件默認上限(resolveChatAttachmentMaxBytes:mediaMaxMb 未配=20MB)。 */
export const DOWNLOAD_MAX = 20 * 1024 * 1024;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * #249 pin-IP 解析:socket 連接時用它做 DNS——校驗**實際要連的那個 IP**。DNS-rebinding 換的正是
 * 這次連接解析到的 IP,當場被拒;validateDownloadUrl 預解析只是早拒,真正把關在這裡(單次解析、
 * 直接用於 socket,無「校驗解析 ≠ 連接解析」的 TOCTOU 窗口)。
 */
export function pinnedLookup(
  hostname: string,
  options: unknown,
  cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
): void {
  dnsLookupCb(hostname, { ...(options as object), all: false }, (err, address, family) => {
    if (err) return cb(err, address as unknown as string, family as unknown as number);
    if (isPrivateIp(address)) {
      return cb(new Error(`目標 IP ${address} 在私網/保留範圍(防 SSRF DNS-rebinding)`), address, family);
    }
    cb(null, address, family);
  });
}

/** IPv4/IPv6 私網/環回/link-local/保留段判定(無依賴手寫,覆蓋 SSRF 常用目標)。 */
export function isPrivateIp(ip: string): boolean {
  if (ip.includes(".") && !ip.toLowerCase().startsWith("::ffff:")) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((x) => Number.isNaN(x))) return true; // 解析不了按危險處理
    const [a, b] = p as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local / 雲元數據
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast + 保留
    );
  }
  const low = ip.toLowerCase();
  if (low.startsWith("::ffff:")) return isPrivateIp(low.slice(7)); // v4-mapped
  return (
    low === "::1" ||
    low === "::" ||
    low.startsWith("fc") ||
    low.startsWith("fd") || // ULA fc00::/7
    low.startsWith("fe8") ||
    low.startsWith("fe9") ||
    low.startsWith("fea") ||
    low.startsWith("feb") || // link-local fe80::/10
    low.startsWith("ff") // multicast
  );
}

/** 下載前校驗 url(拋錯=拒絕)。 */
export async function validateDownloadUrl(url: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`無效 url`);
  }
  const host = (u.hostname || "").toLowerCase();
  if (u.protocol === "http:" && LOCAL_HOSTS.has(host)) return; // 本地 dev 服務(生產走 https)
  if (u.protocol !== "https:") throw new Error(`不允許的 scheme:${u.protocol}(只允許 https)`);
  if (!host) throw new Error("url 缺主機名");
  const addrs = await lookup(host, { all: true }).catch((e) => {
    throw new Error(`解析主機失敗:${(e as Error).message}`);
  });
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error(`目標 IP ${address} 在私網/環回/保留範圍(防 SSRF)`);
  }
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
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > DOWNLOAD_MAX) throw new Error(`附件超過上限 ${DOWNLOAD_MAX} 字節(OpenClaw chat 附件默認 20MB)`);
    chunks.push(Buffer.from(chunk));
  }
  const mime = typeof ref.mime === "string" && ref.mime ? ref.mime : undefined;
  return {
    ...(mime ? { mimeType: mime } : {}),
    fileName: sanitizeName(String(ref.name ?? "file")),
    content: Buffer.concat(chunks).toString("base64"),
  };
}
