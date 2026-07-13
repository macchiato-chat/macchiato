/**
 * #158 出站附件(對齊 Hermes connector.py 的 _extract_media_files/_read_media_file):
 * agent 回覆正文裡 `MEDIA:<路徑>` 標記或裸絕對路徑 → 讀文件(12MB 上限)→ media.attach 事件
 * (base64 內聯,server 落存儲+渲染 media block,ingest 對任意連接器通吃)。
 * 保守解析防誤報:MEDIA: 標記顯式優先;裸路徑必須「絕對路徑 + 常見副檔名 + 磁盤上真實存在的文件」。
 */
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

export const MEDIA_MAX = 12 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

/** MEDIA: 標記(整行,顯式意圖)。 */
const MEDIA_RE = /^MEDIA:\s*(\S.*?)\s*$/gm;
/** 裸絕對路徑:以 / 或 ~/ 開頭、帶已知副檔名的 token(空白/引號/反引號邊界)。 */
const BARE_RE = /(?:^|[\s"'`(])((?:\/|~\/)[\w.\-\/]+\.(?:png|jpe?g|gif|webp|svg|pdf|txt|md|csv|json|html|zip|mp3|m4a|wav|mp4|mov))(?=$|[\s"'`).,;:!?])/gim;

function expand(p: string): string {
  return p.startsWith("~/") ? p.replace("~", process.env.HOME ?? "~") : p;
}

/** 從回覆正文提取待投遞的本地文件路徑(去重、存在性校驗)。 */
export function extractMediaPaths(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const p = expand(raw.trim());
    if (seen.has(p)) return;
    seen.add(p);
    try {
      if (statSync(p).isFile()) out.push(p);
    } catch {
      /* 不存在/不可讀 → 不是要投遞的文件 */
    }
  };
  for (const m of text.matchAll(MEDIA_RE)) push(m[1]!);
  for (const m of text.matchAll(BARE_RE)) push(m[1]!);
  return out;
}

export interface MediaPayload {
  kind: "image" | "document";
  name: string;
  mime: string;
  size: number;
  data_b64: string;
}

/** 讀文件成 media.attach payload(Hermes 同款形狀);超限/空/讀失敗 → null。 */
export function readMediaFile(path: string): MediaPayload | null {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  if (size <= 0 || size > MEDIA_MAX) {
    if (size > MEDIA_MAX) console.error(`[media too big, skip] ${path} ${size}B`);
    return null;
  }
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch {
    return null;
  }
  const mime = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  return {
    kind: mime.startsWith("image/") ? "image" : "document",
    name: basename(path),
    mime,
    size,
    data_b64: data.toString("base64"),
  };
}
