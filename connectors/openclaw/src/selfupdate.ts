/**
 * #1 self_update 供應鏈加固:此前直接 `curl install.sh | bash`——repo/CDN 投毒或 server
 * 沦陷即本機 RCE。現在:
 *   1. 下載 release.json + .sig → **內嵌公鑰 ed25519 驗簽**(repo/CDN 投毒 → 簽名不過);
 *   2. 拒絕降級(manifest.version < 自身 → 中止;server 沦陷只能觸發合法簽名的更新);
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

export interface ReleaseManifest {
  version: string;
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
  const ok = edVerify(null, manifestBytes, pubkeyFromHex(pubkeyHex), Buffer.from(sigB64.trim(), "base64"));
  if (!ok) throw new Error("release.json 簽名驗證失敗(repo 被改?公鑰輪換?)");
  const m = JSON.parse(manifestBytes.toString("utf8")) as ReleaseManifest;
  if (typeof m.version !== "string" || !m.files || typeof m.files !== "object") {
    throw new Error("release.json 結構不對");
  }
  return m;
}

/** a < b(數字段逐段比;非數字段按字典)。 */
export function semverLt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

async function fetchBytes(url: string): Promise<Buffer> {
  if (!url.startsWith("https://")) throw new Error(`拒絕非 https:${url}`);
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 驗證鏈全過才執行 install.sh(已驗證字節從本地臨時文件跑,非管道);清單經
 * MACCHIATO_MANIFEST 傳入,install.sh 對每個安裝文件再驗 sha256。
 */
export async function runVerifiedSelfUpdate(kind: string, currentVersion: string): Promise<void> {
  const [manifestBytes, sigB64] = await Promise.all([
    fetchBytes(`${RAW_BASE}/release.json`),
    fetchBytes(`${RAW_BASE}/release.json.sig`).then((b) => b.toString("utf8")),
  ]);
  const m = verifyManifest(manifestBytes, sigB64);
  if (semverLt(m.version, currentVersion)) {
    throw new Error(`拒絕降級:清單 v${m.version} < 本機 v${currentVersion}`);
  }
  const installSh = await fetchBytes(`${RAW_BASE}/install.sh`);
  const wantSha = m.files["install.sh"];
  const gotSha = createHash("sha256").update(installSh).digest("hex");
  if (!wantSha || gotSha !== wantSha) {
    throw new Error(`install.sh sha256 不符(清單 ${wantSha ?? "缺"} ≠ 實際 ${gotSha})`);
  }
  const dir = mkdtempSync(join(tmpdir(), "macchiato-update-"));
  const shPath = join(dir, "install.sh");
  const mfPath = join(dir, "release.json");
  writeFileSync(shPath, installSh);
  writeFileSync(mfPath, manifestBytes);
  console.error(`· self_update:簽名/版本/哈希全過(v${m.version})→ 後台安裝…`);
  // detached:服務重啟殺本進程時不中斷安裝
  spawn("bash", [shPath], {
    env: { ...process.env, MACCHIATO_ONLY: kind, MACCHIATO_MANIFEST: mfPath },
    detached: true,
    stdio: "ignore",
  }).unref();
}
