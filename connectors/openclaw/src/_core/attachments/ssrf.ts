/**
 * 附件下载 SSRF 护栏（#12 / #249 / #379）——TS 三家同构安全原语。
 * CC/Codex 的 materialize / gc 在 `attachments/store`（#631）；OpenClaw 仍走内存 base64；
 * CC 独有 image block 留在 CC。
 */
import { lookup } from "node:dns/promises";
import { lookup as dnsLookupCb } from "node:dns";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * IPv4/IPv6 私网/环回/link-local/保留段判定(无依赖手写,覆盖 SSRF 常用目标)。
 *
 * v4-mapped(`::ffff:a.b.c.d`)**先剥壳再按 v4 判**——这是 OpenClaw 那份的写法,合并 #572 时
 * 取的是 CC/Codex 版:它让 `::ffff:` 落进 v4 分支、`Number("::ffff:127")` 得 NaN,于是靠
 * 「解析不了按危险处理」兜住私网,但同时把 `::ffff:<公网 v4>` 也一并拒了(误杀)。
 * 剥壳后两种情况都判对,且没有放松任何一格。
 */
export function isPrivateIp(ip: string): boolean {
  const low = ip.toLowerCase();
  if (low.startsWith("::ffff:")) return isPrivateIp(low.slice(7));
  if (low.includes(".")) {
    const p = low.split(".").map(Number);
    if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true; // 解析不了按危险处理
    const [a, b] = p as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local / 云元数据
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast + 保留
    );
  }
  if (!low.includes(":")) return true; // 既不是 v4 也不是 v6 → 解析不了,按危险处理
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

/** 下载前校验 localhost http 特例(dev-disk)。 */
export function isAllowedLocalHttp(u: URL): boolean {
  if (process.env.MACCHIATO_ATTACH_ALLOW_LOCALHOST !== "1") return false;
  if (u.protocol !== "http:") return false;
  // Node 部分版本 hostname 对 IPv6 带方括号（[::1]）；WHATWG 则不带——两边都接。
  const host = (u.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!LOCAL_HOSTS.has(host)) return false;
  // userinfo 混淆(http://evil@127.0.0.1/…)一律拒
  if (u.username || u.password) return false;
  const portRaw = process.env.MACCHIATO_ATTACH_LOCAL_PORT;
  const wantPort = portRaw === undefined || portRaw === "" ? 8080 : Number(portRaw);
  if (!Number.isInteger(wantPort) || wantPort < 1 || wantPort > 65535) return false;
  const gotPort = u.port ? Number(u.port) : 80; // http 默认 80；dev-disk 是 8080，必须显式带端口
  if (gotPort !== wantPort) return false;
  // 空字串=不限 path（测试用）；未设默认 /attachments（对齐 dev-disk）
  const prefix =
    process.env.MACCHIATO_ATTACH_LOCAL_PATH_PREFIX === undefined
      ? "/attachments"
      : process.env.MACCHIATO_ATTACH_LOCAL_PATH_PREFIX;
  if (prefix) {
    const path = u.pathname || "/";
    if (path !== prefix && !path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)) {
      return false;
    }
  }
  return true;
}

/** 下载前校验 url(抛错=拒绝)。 */
export async function validateDownloadUrl(url: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`無效 url`);
  }
  if (isAllowedLocalHttp(u)) return; // #379 显式 dev 才放行 http→loopback
  if (u.protocol !== "https:") {
    throw new Error(
      `不允許的 scheme:${u.protocol}(只允許 https；本地 dev-disk 需 MACCHIATO_ATTACH_ALLOW_LOCALHOST=1)`,
    );
  }
  const host = (u.hostname || "").toLowerCase();
  if (!host) throw new Error("url 缺主機名");
  if (u.username || u.password) throw new Error("url 不得含 userinfo(防混淆)");
  const addrs = await lookup(host, { all: true }).catch((e) => {
    throw new Error(`解析主機失敗:${(e as Error).message}`);
  });
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error(`目標 IP ${address} 在私網/環回/保留範圍(防 SSRF)`);
  }
}

/**
 * #249 pin-IP 解析:socket 連接時用它做 DNS——校驗**實際要連的那個 IP**。DNS-rebinding 把記錄
 * 換成私網,換的也正是這次連接解析到的 IP,當場被拒;validateDownloadUrl 的預解析只是早拒,
 * 真正把關的是這裡(單次解析、直接用於 socket,無「校驗解析 ≠ 連接解析」的 TOCTOU 窗口)。
 */
export const pinnedLookup: LookupFunction = (hostname, options, cb) => {
  // ⚠️ **不能**覆蓋調用方要的 `all`。Node 20+ 的 autoSelectFamily(默認開)會用 `all: true` 調用
  // 並期待回調給**數組**;強行 all:false 回一個字符串,Node 讀 `addresses[0].address` 得 undefined,
  // 於是 net.isIP(undefined) 拋 `Invalid IP address: undefined`——https 附件下載全掛
  // (本地 dev 走 http 不掛 lookup,所以這個坑一直沒暴露)。
  //
  // dns.lookup 的類型按 all:true/false 分兩個重載,而這裡的 all 由調用方給、編譯期不知道是哪個,
  // 過不了重載解析;運行時兩種形狀都處理了,故收口成一個寬簽名。
  type RawLookup = (
    hostname: string,
    options: object,
    cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ) => void;
  (dnsLookupCb as unknown as RawLookup)(hostname, (options ?? {}) as object, (err, address, family) => {
    if (err) return cb(err, address, family);
    // 數組形狀要**逐個**校驗:Node 會依次嘗試裡面的地址,只要有一個是私網,SSRF 就成立。
    const list = Array.isArray(address) ? address.map((a) => a.address) : [address];
    const bad = list.find((ip) => isPrivateIp(ip));
    if (bad !== undefined) {
      return cb(new Error(`目標 IP ${bad} 在私網/保留範圍(防 SSRF DNS-rebinding)`), address, family);
    }
    cb(null, address, family);
  });
};
