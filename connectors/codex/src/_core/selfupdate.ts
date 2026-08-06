/**
 * #1 self_update 供應鏈加固:此前直接 `curl install.sh | bash`——repo/CDN 投毒或 server
 * 沦陷即本機 RCE。現在:
 *   1. 下載 release.json + .sig → **內嵌公鑰 ed25519 驗簽**(repo/CDN 投毒 → 簽名不過);
 *   2. 要求 bootstrap v1 信任橋，且只接受嚴格升版(同版重放/降級/畸形版本一律中止);
 *   3. install.sh 的 sha256 對上清單才執行,並把已驗證清單傳給它(每個安裝文件再驗一遍)。
 * 信任根 = 發布機的簽名私鑰(scripts/release/sign-manifest.mjs);公鑰輪換 = 發一版帶新鑰的簽名更新。
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
let selfUpdatePendingRestart: string | null = null;

/**
 * #773 installer 退出 0 之後再等這麼久;到點本進程還活着 ＝ 重啟沒把它換掉 → 放開交棒閂。
 *
 * **為什麼需要這個寬限期**:交棒閂原本只在 installer **退出非 0** 時才清(見下面
 * handleInstallerExit)。生產真機上 installer 裝成功、退出 0,而真正在跑的進程沒被替換
 * (#767 的 system unit 托管、MACCHIATO_SKIP_UNIT、手動跑的連接器…),閂就永久置位——
 * 之後每次 self_update 只打印 `[self_update ignored]`,連下載都不做,用戶點多少次「重試」
 * 都一樣。清閂的唯一途徑是進程重啟,而那恰恰就是沒發生的那件事 → 死鎖。
 *
 * **N 為什麼取 45s**:
 *  - 下界(不能更小):閂的本意是防並發/重放安裝,清早了會同時跑兩個 installer,比本 bug 更糟。
 *    真重啟路徑上本進程幾乎不可能活到 45s:systemd 的 `systemctl --user restart` 是**阻塞**的
 *    (stop 完成才返回),所以 installer 退出時舊進程早已死透;launchd 的 `kickstart -k` 發完
 *    SIGTERM 就返回,本進程再優雅退出也是秒級。45s 遠在這兩條之上。
 *  - 上界(不能更大):app 側「正在更新…」的看門狗是 90s,到點提示「更新失敗/重試」。N 必須
 *    明顯小於它,用戶那一下重試才真的能再裝一次,而不是又撞在閂上。
 *  - 計時**從 installer 退出算起,不是從 spawn 算起**——下載/安裝本身可能很久,從 spawn 起算
 *    等於在 installer 還在跑的時候放閂。
 *
 * env 只為測試提供注入點(生產不設)。
 */
export const SELF_UPDATE_RESTART_GRACE_MS =
  Number(process.env.MACCHIATO_SELF_UPDATE_RESTART_GRACE_MS) || 45_000;

/**
 * #773 「新版已裝好、但本進程沒被換掉」的一句人話,由 health 併入 `lastError` 上報。
 *
 * 🚨 **絕不是「更新失敗」**:非 systemd(手動跑)的連接器本來就是「只更新文件、下次重啟生效」,
 * 那是**正常**路徑;說成失敗就是撒謊。這條只說事實 + 下一步(重啟)。`lastError` 不參與
 * server 的 degraded 判定(registry.ts 的 healthFromState 只看 gatewayAlive/compatOk/
 * mirrorStuck/authOk),所以拿它當信息位不會誤亮黃燈。
 */
export function selfUpdatePendingRestartNotice(): string | null {
  return selfUpdatePendingRestart;
}

/** 交棒閂當前狀態:true ＝ 本進程已放出一個 installer,拒絕第二個(防並發/重放安裝)。 */
export function isSelfUpdateHandedOff(): boolean {
  return selfUpdateHandedOff;
}

/**
 * 取交棒閂:拿到 true ＝ 本進程可以放 installer;false ＝ 已有一個在跑 → 拒絕並發/重放安裝
 * (同時跑兩個 installer 比更新不上來更糟)。
 */
export function acquireSelfUpdateHandoff(): boolean {
  if (selfUpdateHandedOff) return false;
  selfUpdateHandedOff = true;
  return true;
}

/** 放閂(下載/驗簽失敗、installer 起不來、或裝失敗 → 允許安全重試)。 */
export function releaseSelfUpdateHandoff(): void {
  selfUpdateHandedOff = false;
}

/** 重置本模塊的交棒狀態。生產路徑不需要(閂與通知天生跟着進程走),單測用它隔離用例。 */
export function resetSelfUpdateState(): void {
  selfUpdateHandedOff = false;
  selfUpdatePendingRestart = null;
}

/**
 * installer 進程退出後的收尾(#773)。
 *  - 退出**非 0**(裝失敗):立刻放閂,用戶點重試就能真的再裝一次(既有行為,原樣保留)。
 *  - 退出**0**(裝成功):**不立刻**放閂——正常情況下服務重啟會把本進程殺掉,閂跟着進程一起消失。
 *    等 graceMs 後本進程還活着,才說明重啟沒生效 → 放閂 + 掛一句「已下載,重啟後生效」。
 */
export function handleInstallerExit(
  code: number | null,
  version: string,
  graceMs: number = SELF_UPDATE_RESTART_GRACE_MS,
): void {
  if (code !== 0) {
    releaseSelfUpdateHandoff();
    return;
  }
  const timer: unknown = setTimeout(() => {
    releaseSelfUpdateHandoff();
    selfUpdatePendingRestart = `更新已下載(v${version}),重啟連接器後生效`;
    console.error(
      `· self_update:v${version} 已裝好,但 ${Math.round(graceMs / 1000)}s 後本進程仍在跑` +
        "——服務沒被重啟替換,放開更新閂(下次 self_update 會真的再裝一次)",
    );
  }, graceMs);
  // 這條計時器絕不能成為進程退不掉的理由(它本來就是在等「被殺掉」)。
  (timer as { unref?: () => void }).unref?.();
}

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

// ── #669 阶段 0:策略 sidecar(release-policy.json + .sig)────────────────────────
/**
 * **为什么是独立文件、而不是往 release.json 加字段**:上面的 verifyManifest 把清单字段集
 * 钉死成 {version,bootstrapVersion,bootstrapSha256,files},后面还做 canonical 字节比对。
 * 于是往 release.json 加**任何**一个字段,全部**存量**连接器都会判清单非法 → self_update
 * 挂,supervisor 的崩溃自愈(#528,同一个验签器)一起挂,全体永久只剩手工重装。所以自动
 * 更新要用的控制位(分批比例 / 过期时间 / 版本黑名单)一律住在这个 sidecar 里:老客户端
 * 根本不知道有这个文件、不去拉它,行为零变化。**release.json 的四个字段永不动。**
 *
 * **为什么这个验证器未知字段一律忽略**:上面那套「字段集精确相等 + canonical 字节比对」
 * 把格式焊死了——它的本意是防重复/歧义字段,代价是格式再也演进不了(就是本节存在的理由)。
 * 这里绝不重蹈:以后往 policy 加字段(频道、最低版本、闲时窗口…)时,旧连接器只是看不懂
 * 新字段,不会把整份策略判非法。严格性没丢,只是落在**已知字段**上:类型、范围、语义全部
 * 照 verifyManifest 的防御风格查(严格 semver、大小上限、拒绝重复字段);未知字段单纯不
 * 参与决策。fail-safe 的方向也不同:清单验不过 = 不装(安全第一),策略验不过/过期 = **不
 * 更新**,机器停在当前能工作的版本上,绝不能变成「拒绝启动」。
 */
export const RELEASE_POLICY_SCHEMA = 1;
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_BLOCKED_VERSIONS = 256;
/** 策略的最长有效期:签坏一份「一百年不过期」的策略就等于永久放弃新鲜度保证(TUF freeze)。 */
const MAX_POLICY_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000;
/** 序号上限取 JS 安全整数:Python 侧是 bignum,不钉这条两个实现会对同一份字节给出不同答案。 */
const MAX_POLICY_SEQUENCE = Number.MAX_SAFE_INTEGER;

export interface ReleasePolicy {
  /** 格式版本;本实现只认 1。 */
  schema: number;
  /**
   * 单调递增序号(防重放/回滚)。每签一份策略必须严格大于上一份;客户端记住见过的最大值,
   * 更低的一律不认。为什么需要它 → 见下方 assertPolicyNotReplayed 的注释。
   */
  sequence: number;
  /** 签名时刻(RFC3339 UTC 秒级)。 */
  signedAt: string;
  /** 过期时刻;超过即视为不新鲜 → 不更新(非拒绝启动)。 */
  expires: string;
  /** 本轮放量的目标连接器版本。 */
  version: string;
  /** 0–100;出坏版本时改回 0 重签 = 分钟级刹车。 */
  rolloutPercent: number;
  /** 已知坏版本,任何机器都不许装/应尽快离开。 */
  blocked: string[];
  /** 未知字段原样保留,但本版本不据以做任何决策。 */
  [extra: string]: unknown;
}

/** 策略过期(不新鲜)。语义是「不更新」,调用方**不得**据此拒绝启动或中止连接器。 */
export class PolicyExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyExpiredError";
  }
}

const UTC_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/**
 * 只接受 RFC3339 的 UTC 秒级时间戳。宽松解析(Date.parse)会吞掉本地时区、两位年份和
 * 2026-02-30 这类不存在的日期——过期判定是安全属性,不能靠运行环境的解析口味。
 */
function parseUtcTimestamp(value: unknown, field: string): number {
  if (typeof value !== "string" || !UTC_TIMESTAMP_RE.test(value)) {
    throw new Error(`release-policy.json 結構不對:${field} 必須是 YYYY-MM-DDTHH:MM:SSZ`);
  }
  const [year, month, day, hour, minute, second] = UTC_TIMESTAMP_RE.exec(value)!.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  // 回写比对:Date.UTC 会把 2026-02-30 悄悄折成 3 月 2 日,只有 round-trip 抓得到。
  if (!Number.isFinite(ms) || new Date(ms).toISOString().replace(/\.000Z$/, "Z") !== value) {
    throw new Error(`release-policy.json 結構不對:${field} 不是合法時刻 ${value}`);
  }
  return ms;
}

/**
 * JSON.parse 对重复字段是「后者胜」且静默——同一份签名字节,不同解析器可以看到不同的
 * rolloutPercent。release.json 靠 canonical 字节比对顺手堵住了这个洞,policy 不能钉死
 * 字节(见上),所以这里做一次与排版无关的重复键扫描。输入已由 JSON.parse 验过语法,
 * 因此只需扫描而不必再做完整解析。
 */
function assertNoDuplicateKeys(text: string): void {
  const scopes: Array<Set<string> | null> = []; // Set = 对象作用域;null = 数组作用域
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      while (end < text.length) {
        if (text[end] === "\\") end += 2;
        else if (text[end] === '"') break;
        else end += 1;
      }
      const literal = text.slice(i, end + 1);
      i = end + 1;
      let after = i;
      while (after < text.length && /\s/.test(text[after])) after += 1;
      const scope = scopes[scopes.length - 1];
      if (scope && text[after] === ":") {
        const key = JSON.parse(literal) as string;
        if (scope.has(key)) throw new Error(`release-policy.json 結構不對:重複字段 ${key}`);
        scope.add(key);
      }
      continue;
    }
    if (ch === "{") scopes.push(new Set());
    else if (ch === "[") scopes.push(null);
    else if (ch === "}" || ch === "]") scopes.pop();
    i += 1;
  }
}

/**
 * 驗簽 + 解析策略 sidecar;簽名不過/已知字段不合法/已過期 → 拋。
 * 過期拋的是 PolicyExpiredError(仍是 Error 子類),語義為「不更新」而非「不啟動」。
 */
export function verifyPolicy(
  policyBytes: Buffer,
  sigB64: string,
  options: { pubkeyHex?: string; now?: number } = {},
): ReleasePolicy {
  const { pubkeyHex = RELEASE_PUBKEY_HEX, now = Date.now() } = options;
  if (policyBytes.length === 0 || policyBytes.length > MAX_POLICY_BYTES) {
    throw new Error("release-policy.json 結構不對:大小越界");
  }
  if (!/^[A-Za-z0-9+/]{86}==\n?$/.test(sigB64)) {
    throw new Error("release-policy.json 簽名編碼不合法");
  }
  const ok = edVerify(null, policyBytes, pubkeyFromHex(pubkeyHex), Buffer.from(sigB64.trim(), "base64"));
  if (!ok) throw new Error("release-policy.json 簽名驗證失敗(repo 被改?公鑰輪換?)");
  const text = policyBytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("release-policy.json 結構不對:JSON 非法");
  }
  assertNoDuplicateKeys(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("release-policy.json 結構不對:頂層必須是物件");
  }
  const p = parsed as ReleasePolicy;
  if (typeof p.schema !== "number" || !Number.isInteger(p.schema)) {
    throw new Error("release-policy.json 結構不對:schema 必須是整數");
  }
  if (p.schema !== RELEASE_POLICY_SCHEMA) {
    // 新 schema 由新客户端认;老客户端**停在原地**(不更新),不是报错退出。
    throw new Error(`release-policy.json 不支援的 schema:${p.schema}`);
  }
  // sequence 是**必填**已知字段:一份没有序号的策略无法防重放,只能整份拒绝(fail-safe = 不更新)。
  // 攻击者无法从签名字节里摘掉它(签名覆盖全文),所以缺失只可能来自签名器 bug 或前序号时代的
  // 陈年策略——两种都不该被当成「可以放行」。
  if (
    typeof p.sequence !== "number" ||
    !Number.isSafeInteger(p.sequence) ||
    p.sequence < 1 ||
    p.sequence > MAX_POLICY_SEQUENCE
  ) {
    throw new Error("release-policy.json 結構不對:sequence 必須是 1 起的安全整數");
  }
  parseStrictSemver(p.version);
  if (
    typeof p.rolloutPercent !== "number" ||
    !Number.isInteger(p.rolloutPercent) ||
    p.rolloutPercent < 0 ||
    p.rolloutPercent > 100
  ) {
    throw new Error("release-policy.json 結構不對:rolloutPercent 必須是 0–100 的整數");
  }
  if (!Array.isArray(p.blocked) || p.blocked.length > MAX_BLOCKED_VERSIONS) {
    throw new Error("release-policy.json 結構不對:blocked 必須是陣列且不超過上限");
  }
  const seen = new Set<string>();
  for (const blocked of p.blocked) {
    parseStrictSemver(blocked);
    if (seen.has(blocked)) throw new Error(`release-policy.json 結構不對:blocked 重複項 ${blocked}`);
    seen.add(blocked);
  }
  const signedAt = parseUtcTimestamp(p.signedAt, "signedAt");
  const expires = parseUtcTimestamp(p.expires, "expires");
  if (expires <= signedAt) {
    throw new Error("release-policy.json 結構不對:expires 必須晚於 signedAt");
  }
  if (expires - signedAt > MAX_POLICY_VALIDITY_MS) {
    throw new Error("release-policy.json 結構不對:有效期超過上限");
  }
  if (now >= expires) {
    throw new PolicyExpiredError(`release-policy.json 已過期(expires ${p.expires})——維持現版本,不更新`);
  }
  return p;
}

// ── #669 阶段 0b:防重放序号 ────────────────────────────────────────────────────
/**
 * **expires 挡不住重放。** 有效期上限 90 天,窗口里任何人——投毒的 CDN、卡住的镜像、
 * 中间人——都可以把一份**仍在有效期内的旧策略**原样再喂一次:签名是真的、时刻是新鲜的,
 * 上面每一条校验都过。两条后果都直指刹车闸:
 *   ① 旧策略的 blocked 更短 → 已知坏版本重新变成可装;
 *   ② rolloutPercent 从「刹车后的 0」被恢复成旧的高值 → **刹车被绕过**。
 * 而 set-rollout.mjs 的全部价值就是「改回 0 重签 → 分钟级刹住」,严格升版闸又让我们根本
 * 无法降级——刹车是唯一的补偿手段,它被绕过等于没有。
 *
 * 所以策略带单调递增 sequence,客户端持久化「见过的最大序号」,**更低的一律不认**
 * (TUF 对 rollback attack 的标准做法)。序号不依赖时钟:时钟坏掉的机器照样挡得住重放,
 * 也不会因此永久停更(停更只由 expires 管,而 expires 一到只是「不更新」)。
 *
 * **为什么序号相同要接受、只拒更低**:策略在两次重签之间就是同一份字节,连接器每轮拉到的
 * 都是它。若「见过即拒」,一台机器只要成功读过一次策略,就再也用不了它——直到下次有人重签
 * 为止,分批放量与 blocked 名单等于常年失效。真正的攻击面是**更低**的序号(旧策略),等于
 * 是不给任何好处的自残。相同序号 = 当前生效的那一份 = 发布者此刻想要的状态。
 * 「相同也拒」落在**签名器**那一头(buildReleasePolicy 拒绝签出不严格递增的序号),那里拒才
 * 有意义:签出重复序号 = 刹车刹不住。
 */
export class PolicyReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyReplayError";
  }
}

/** 防重放存档的格式版本(与策略的 schema 无关,是本机文件自己的)。 */
const POLICY_SEQUENCE_STORE_SCHEMA = 1;

/**
 * 见过的最大序号存哪:`~/.macchiato/release-policy-seen.json`(**每机一份、四家共享**——
 * 策略谈论的是这台机器该装什么,不分连接器;任一家挡下重放,其它家跟着受益)。
 * 默认路径与 hermes(release_verify.py 的 policy_sequence_path)重合,故意的。
 */
export function policySequencePath(): string {
  const override = process.env.MACCHIATO_POLICY_SEQUENCE_FILE?.trim();
  if (override) return override;
  return join(homedir(), ".macchiato", "release-policy-seen.json");
}

/**
 * 读「见过的最大序号」;**读不到一律回 0**(= 还没见过任何策略,首见即接受并记下,TOFU)。
 *
 * 为什么坏掉的存档也当「没见过」而不是拒绝更新:这个文件是本机缓存,不是信任根——它唯一
 * 要防的是**网络侧**的重放,而能改写它的人早已能改写连接器自身(本地写权限 = 完全沦陷),
 * 「坏档 → 永久停更」只会把一次崩溃写坏的文件变成一台再也修不好的机器。我们自己的写是
 * 原子的(临时文件 + rename),所以坏档本就只可能来自外力。
 */
export function readSeenPolicySequence(path = policySequencePath()): number {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return 0; // 首装:没有存档 = 没见过策略,不能因此卡死
  }
  try {
    const parsed = JSON.parse(raw) as { schema?: unknown; sequence?: unknown };
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.schema === POLICY_SEQUENCE_STORE_SCHEMA &&
      typeof parsed.sequence === "number" &&
      Number.isSafeInteger(parsed.sequence) &&
      parsed.sequence >= 0 &&
      parsed.sequence <= MAX_POLICY_SEQUENCE
    ) {
      return parsed.sequence;
    }
  } catch {
    /* 落到下面 */
  }
  return 0;
}

/** 记下见过的序号;**只进不退**(旧值更大就什么都不做),原子落盘(临时文件 + rename)。 */
export function recordPolicySequence(sequence: number, path = policySequencePath()): void {
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`拒絕記錄非法策略序號:${sequence}`);
  }
  if (readSeenPolicySequence(path) >= sequence) return;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify({ schema: POLICY_SEQUENCE_STORE_SCHEMA, sequence }, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, path);
}

/** 序号低于本机见过的最大值 = 重放 → 抛。语义同过期:**不更新**,绝不是「不启动」。 */
export function assertPolicyNotReplayed(policy: ReleasePolicy, seenSequence: number): void {
  if (policy.sequence < seenSequence) {
    throw new PolicyReplayError(
      `release-policy.json 是重放的舊策略(sequence ${policy.sequence} < 本機見過的 ${seenSequence})` +
        `——維持現版本,不更新`,
    );
  }
}

/**
 * 验签 + 校验 + 防重放 + 记账,调用方要的一步到位版本。
 * 抛 PolicyExpiredError / PolicyReplayError / Error 时语义统一是「本轮不更新」。
 */
export function verifyPolicyWithAntiReplay(
  policyBytes: Buffer,
  sigB64: string,
  options: { pubkeyHex?: string; now?: number; storePath?: string } = {},
): ReleasePolicy {
  const storePath = options.storePath ?? policySequencePath();
  const policy = verifyPolicy(policyBytes, sigB64, options);
  assertPolicyNotReplayed(policy, readSeenPolicySequence(storePath));
  try {
    recordPolicySequence(policy.sequence, storePath);
  } catch (error) {
    // 只读 home / 磁盘满时**不能**因此停更:策略此刻已验证为新鲜且非重放,拒绝它没有任何
    // 安全收益,只会让一台写不了盘的机器永远升不了级。地板下一轮再补。
    console.error(`· release-policy:序號落盤失敗(${(error as Error).message})——本輪照常判定`);
  }
  return policy;
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
  // #767 服务由外部托管（system unit / 容器 / 一体机镜像）：不进白名单 = self_update 拉起的
  // installer 收不到它，照样去装 user unit —— 更新写进磁盘、真正在跑的进程纹丝不动，
  // 用户点 Update 永远失败。
  "MACCHIATO_SKIP_UNIT",
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
  if (!acquireSelfUpdateHandoff()) throw new Error("self_update 已在本进程启动，拒绝并发/重放安装");
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
      releaseSelfUpdateHandoff();
    });
    // #773 計時從 **installer 退出** 算起(不是 spawn),見 handleInstallerExit 的注釋。
    child.once("exit", (code) => handleInstallerExit(code, m.version));
    child.unref();
    spawned = true;
  } finally {
    // 成功交棒后本进程不再发第二个 installer（#773 起有一个例外：installer 退 0 但本进程
    // 没被重启替换 → 宽限期后放闩，否则更新按钮永久锁死）；下载/验签失败则允许安全重试。
    if (!spawned) releaseSelfUpdateHandoff();
  }
}
