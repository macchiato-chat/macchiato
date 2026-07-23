/**
 * #1 self_update 供應鏈加固:此前直接 `curl install.sh | bash`——repo/CDN 投毒或 server
 * 沦陷即本機 RCE。現在:
 *   1. 下載 release.json + .sig → **內嵌公鑰 ed25519 驗簽**(repo/CDN 投毒 → 簽名不過);
 *   2. 要求 bootstrap v1 信任橋，且只接受嚴格升版(同版重放/降級/畸形版本一律中止);
 *   3. install.sh 的 sha256 對上清單才執行,並把已驗證清單傳給它(每個安裝文件再驗一遍)。
 * 信任根 = 發布機的簽名私鑰(scripts/release/sign-manifest.mjs);公鑰輪換 = 發一版帶新鑰的簽名更新。
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/** 發布簽名公鑰(ed25519 raw 32B hex;私鑰在發布機 ~/.macchiato/release-signing.key)。 */
export const RELEASE_PUBKEY_HEX = "48d741eac2364340cfbd14502eac7506f8babcd4ce502775e831abcd1ed0f105";

const RAW_BASE =
  process.env.MACCHIATO_RELEASE_BASE ||
  "https://raw.githubusercontent.com/macchiato-chat/macchiato/main";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const MAX_INSTALL_BYTES = 2 * 1024 * 1024;
let selfUpdateHandedOff = false;

export interface ReleaseManifest {
  version: string;
  /** bridge v1 metadata；verifyManifest 对缺失/未知字段一律 fail closed。 */
  bootstrapVersion?: number;
  bootstrapSha256?: string;
  files: Record<string, string>;
}

/** raw 32B ed25519 公鑰 hex → KeyObject(裹 SPKI DER)。 */
function pubkeyFromHex(hex: string) {
  const raw = Buffer.from(hex, "hex");
  if (raw.length !== 32) throw new Error("公鑰長度不對");
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

/** 驗簽 + 解析清單;簽名不過/結構不對 → 拋。 */
export function verifyManifest(manifestBytes: Buffer, sigB64: string, pubkeyHex = RELEASE_PUBKEY_HEX): ReleaseManifest {
  if (manifestBytes.length === 0 || manifestBytes.length > MAX_MANIFEST_BYTES) {
    throw new Error("release.json 結構不對:大小越界");
  }
  if (!/^[A-Za-z0-9+/]{86}==\n?$/.test(sigB64)) {
    throw new Error("release.json 簽名編碼不合法");
  }
  const ok = edVerify(null, manifestBytes, pubkeyFromHex(pubkeyHex), Buffer.from(sigB64.trim(), "base64"));
  if (!ok) throw new Error("release.json 簽名驗證失敗(repo 被改?公鑰輪換?)");
  const m = JSON.parse(manifestBytes.toString("utf8")) as ReleaseManifest;
  const keys = m && typeof m === "object" && !Array.isArray(m) ? Object.keys(m).sort() : [];
  if (
    keys.join(",") !== "bootstrapSha256,bootstrapVersion,files,version" ||
    m.bootstrapVersion !== 1 ||
    typeof m.bootstrapSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(m.bootstrapSha256) ||
    !m.files ||
    typeof m.files !== "object" ||
    Array.isArray(m.files)
  ) {
    throw new Error("release.json 結構不對");
  }
  parseStrictSemver(m.version);
  const fileEntries = Object.entries(m.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (fileEntries.length === 0 || fileEntries.length > 10_000) {
    throw new Error("release.json 結構不對:文件清單大小越界");
  }
  for (const [path, digest] of fileEntries) {
    if (
      !/^[A-Za-z0-9._+@/-]+$/.test(path) ||
      path.startsWith("/") ||
      path.includes("//") ||
      path.split("/").some((part) => part === "." || part === "..") ||
      typeof digest !== "string" ||
      !/^[0-9a-f]{64}$/.test(digest)
    ) {
      throw new Error(`release.json 結構不對:非法文件項 ${path}`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(m.files, "install.sh")) {
    throw new Error("release.json 結構不對:缺 install.sh");
  }
  const canonical =
    JSON.stringify(
      {
        version: m.version,
        bootstrapVersion: m.bootstrapVersion,
        bootstrapSha256: m.bootstrapSha256,
        files: Object.fromEntries(fileEntries),
      },
      null,
      2,
    ).replace(/\n {4}/g, "\n  ") + "\n";
  if (!manifestBytes.equals(Buffer.from(canonical))) {
    throw new Error("release.json 結構不對:非 canonical/重複或歧義字段");
  }
  return m;
}

const STRICT_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;

/** 僅接受無前導零的 X.Y.Z，且每段都能由 JS 安全整數精確表示。 */
export function parseStrictSemver(version: string): readonly [number, number, number] {
  if (typeof version !== "string") throw new Error("版本必須是字串");
  const match = STRICT_SEMVER_RE.exec(version);
  if (!match) throw new Error(`版本格式不合法:${version}`);
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`版本字段超出安全範圍:${version}`);
  }
  return parts as unknown as readonly [number, number, number];
}

/** 嚴格 X.Y.Z 數字比較；格式畸形一律拋錯，讓更新 fail closed。 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseStrictSemver(a);
  const pb = parseStrictSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** a < b；格式畸形時拋錯。 */
export function semverLt(a: string, b: string): boolean {
  return compareSemver(a, b) < 0;
}

/**
 * 首裝 bridge 上線後，自更新只執行由新 signer 產生、且嚴格高於本機版本的 manifest。
 */
export function assertSelfUpdateAllowed(m: ReleaseManifest, currentVersion: string): void {
  if (m.bootstrapVersion !== 1 || typeof m.bootstrapSha256 !== "string" || !SHA256_RE.test(m.bootstrapSha256)) {
    throw new Error("release.json 缺少合法 bootstrap v1 信任橋");
  }
  const order = compareSemver(m.version, currentVersion);
  if (order <= 0) {
    const relation = order < 0 ? "<" : "=";
    throw new Error(`拒絕非升級清單:清單 v${m.version} ${relation} 本機 v${currentVersion}`);
  }
}

const SAFE_INSTALLER_ENV = new Set([
  "HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "TMP", "TEMP", "SHELL", "TERM",
  "LANG", "LANGUAGE", "TZ",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "NVM_DIR", "VOLTA_HOME", "PNPM_HOME", "BUN_INSTALL",
  "HERMES_HOME", "HERMES_PYTHON",
  "MACCHIATO_STATE_DIR", "MACCHIATO_HERMES_PROFILE",
  "MACCHIATO_SERVER_URL", "MACCHIATO_WEB_URL", "MACCHIATO_MIRROR",
  "MACCHIATO_CLAUDE_BIN", "MACCHIATO_CODEX_BIN",
]);

/**
 * 已验签 updater 不能把测试信任根、本地“已验证”标记或 shell 启动钩子带进 installer。
 * 否则服务环境中的一个遗留变量就能绕开 bridge，或在 bash 读取脚本前先执行任意文件。
 */
export function buildInstallerEnv(
  source: NodeJS.ProcessEnv,
  kind: string,
  manifestPath: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if ((SAFE_INSTALLER_ENV.has(key) || key.startsWith("LC_")) && value !== undefined) {
      env[key] = value;
    }
  }
  env.MACCHIATO_ONLY = kind;
  env.MACCHIATO_MANIFEST = manifestPath;
  return env;
}

async function fetchBytes(url: string, maximum: number): Promise<Buffer> {
  if (!url.startsWith("https://")) throw new Error(`拒絕非 https:${url}`);
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const declared = res.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw new Error(`HTTP body 超過 ${maximum} bytes:${url}`);
  }
  if (!res.body) throw new Error(`HTTP body 缺失:${url}`);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new Error(`HTTP body 超過 ${maximum} bytes:${url}`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * 驗證鏈全過才執行 install.sh(已驗證字節從本地臨時文件跑,非管道);清單經
 * MACCHIATO_MANIFEST 傳入,install.sh 對每個安裝文件再驗 sha256。
 */
export async function runVerifiedSelfUpdate(kind: string, currentVersion: string): Promise<void> {
  if (selfUpdateHandedOff) throw new Error("self_update 已在本进程启动，拒绝并发/重放安装");
  selfUpdateHandedOff = true;
  let spawned = false;
  try {
    const [manifestBytes, sigB64] = await Promise.all([
      fetchBytes(`${RAW_BASE}/release.json`, MAX_MANIFEST_BYTES),
      fetchBytes(`${RAW_BASE}/release.json.sig`, MAX_SIGNATURE_BYTES).then((b) => b.toString("utf8")),
    ]);
    const m = verifyManifest(manifestBytes, sigB64);
    assertSelfUpdateAllowed(m, currentVersion);
    const installSh = await fetchBytes(`${RAW_BASE}/install.sh`, MAX_INSTALL_BYTES);
    const wantSha = m.files["install.sh"];
    const gotSha = createHash("sha256").update(installSh).digest("hex");
    if (!wantSha || gotSha !== wantSha) {
      throw new Error(`install.sh sha256 不符(清單 ${wantSha ?? "缺"} ≠ 實際 ${gotSha})`);
    }
    const dir = mkdtempSync(join(tmpdir(), "macchiato-update-"));
    const shPath = join(dir, "install.sh");
    const mfPath = join(dir, "release.json");
    writeFileSync(shPath, installSh, { mode: 0o700 });
    writeFileSync(mfPath, manifestBytes, { mode: 0o600 });
    console.error(`· self_update:簽名/版本/哈希全過(v${m.version})→ 後台安裝…`);
    // detached:服務重啟殺本進程時不中斷安裝；初始 bash 固定绝对路径，避免 PATH 劫持。
    const child = spawn("/bin/bash", ["-p", shPath], {
      env: buildInstallerEnv(process.env, kind, mfPath),
      detached: true,
      stdio: "ignore",
    });
    child.once("error", () => {
      selfUpdateHandedOff = false;
    });
    child.once("exit", (code) => {
      if (code !== 0) selfUpdateHandedOff = false;
    });
    child.unref();
    spawned = true;
  } finally {
    // 成功交棒后本进程永不再发第二个 installer；下载/验签失败则允许安全重试。
    if (!spawned) selfUpdateHandedOff = false;
  }
}
