/**
 * §19 per-session E2E 密鑰管理（TS 三家共享, 對應 Python e2e_keys.py）。
 * K_S 按 ConnectorKind 分開存 ~/.macchiato/<kind>-e2e.json（0600, fsync + 原子寫）。
 * **某 hermesSessionId 在 store 里 = 該會話已開 E2E。** 鍵 = server 的 hermesSessionId（原始大小寫）。
 *
 * 合併規則(#572)：CC/OC hasServerStateSnapshot + fail-closed；Codex 錯誤類層級
 * (Load/Persistence/Poisoned/State)；StateError 仍可被 settleE2EBackfillAck 吞。
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import * as ec from "./crypto";
import {
  createE2EDisableReceipt,
  verifyE2EDisableReceipt,
  type E2EControlEnvelopeV1,
  type E2EDisableReceiptV1,
} from "./control";
import {
  isCanonicalDeviceAuthSecret,
  verifyDeviceAuthProof,
  type DeviceAuthConfig,
} from "./device-auth";
import {
  E2EKeyStoreConflictError,
  E2EKeyStoreLockTimeoutError,
  mergeE2EKeyStoreSnapshots,
  withE2EKeyStoreLock,
} from "./file-lock";

export type { DeviceAuthConfig };

export interface DevicePub {
  deviceId: string;
  pubKey: string;
  /** 可選：舊 / 回滾後的 server 不帶；連接器按 `pubKey` 自算，帶了才核對。 */
  keyFingerprint?: string;
  /**
   * #731 可選：設備持有配對 secret 時的 HMAC proof。
   * connector 有 secret 時缺/錯且本地未授權 → 跳過該設備。
   */
  authProof?: string;
  /**
   * #273 可選：設備自報「解得開哪些 E2E 交互密文」。**默認安全**——缺省即當不支持，
   * 連接器走 #273 之前的路徑（clarify/secret 本地 skip 解掛），老 client 天然安全。
   */
  e2eCaps?: { clarify?: true; secret?: true };
}

export interface WrappedDeviceKey {
  deviceId: string;
  keyFingerprint: string;
  sealed: string;
}

export interface ServerE2EStateV1 {
  version: 1;
  sessions: Array<{ hermesSessionId: string; pendingOp: "enable" | "disable" | null }>;
  disabledReceipts: E2EDisableReceiptV1[];
}

type StoreCandidate =
  | { kind: "missing"; path: string }
  | { kind: "invalid"; path: string; error: unknown }
  | { kind: "valid"; path: string; state: StoreState; raw: string; mode: number };

interface StoreState {
  keys: Map<string, Buffer>;
  pendingDisable: Set<string>;
  disableIntents: Map<string, E2EControlEnvelopeV1>;
  disableReceipts: Map<string, E2EDisableReceiptV1>;
  protected: Map<string, "enable" | "disable" | null>;
}

/** CAS 衝突重試次數：每次都在鎖內重讀磁盤權威快照，耗盡後只失敗本次操作、不 poison。 */
const CAS_MAX_ATTEMPTS = 3;
const PENDING_DISABLE_PREFIX = "\u0000macchiato:pending-disable:";
const PENDING_DISABLE_MARKER = Buffer.alloc(32, 0xa5);
const DISABLE_INTENT_PREFIX = "\u0000macchiato:disable-intent:";
const DISABLE_RECEIPT_PREFIX = "\u0000macchiato:disable-receipt:";
const PROTECTED_PREFIX = "\u0000macchiato:protected:";
const DEVICE_PUBLIC_KEY_B64 = /^[A-Za-z0-9+/]{43}=$/;

export function deviceKeyFingerprint(pubKey: string): string {
  if (!DEVICE_PUBLIC_KEY_B64.test(pubKey)) {
    throw new E2EKeyStoreStateError("device public key is not canonical 32-byte base64");
  }
  const raw = Buffer.from(pubKey, "base64");
  if (raw.length !== 32 || raw.toString("base64") !== pubKey) {
    throw new E2EKeyStoreStateError("device public key is not canonical 32-byte base64");
  }
  return createHash("sha256").update(raw).digest("base64url");
}

function pendingDisableMetaSid(sid: string): string {
  return PENDING_DISABLE_PREFIX + Buffer.from(sid, "utf8").toString("base64url");
}

function metadataSid(prefix: string, sid: string): string {
  return prefix + Buffer.from(sid, "utf8").toString("base64url");
}

function decodePendingDisableMetaSid(storedSid: string): string {
  return decodeMetadataSid(PENDING_DISABLE_PREFIX, storedSid);
}

function decodeMetadataSid(prefix: string, storedSid: string): string {
  const encoded = storedSid.slice(prefix.length);
  const sid = Buffer.from(encoded, "base64url").toString("utf8");
  if (!sid || Buffer.from(sid, "utf8").toString("base64url") !== encoded) {
    throw new Error("pending-disable metadata session id is not canonical base64url");
  }
  return sid;
}

function logicalSessionId(storedSid: string): string {
  for (const prefix of [
    PENDING_DISABLE_PREFIX,
    DISABLE_INTENT_PREFIX,
    DISABLE_RECEIPT_PREFIX,
    PROTECTED_PREFIX,
  ]) {
    if (storedSid.startsWith(prefix)) return decodeMetadataSid(prefix, storedSid);
  }
  return storedSid;
}

function encodeMetadata(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decodeMetadata(value: unknown, label: string): unknown {
  if (typeof value !== "string" || !value || Buffer.from(value, "base64").toString("base64") !== value) {
    throw new Error(`${label} metadata is not canonical base64`);
  }
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
  } catch (cause) {
    throw new Error(`${label} metadata is not JSON`, { cause });
  }
}

function sameIntent(a: E2EControlEnvelopeV1, b: E2EControlEnvelopeV1): boolean {
  return (
    a.v === b.v &&
    a.sessionId === b.sessionId &&
    a.hermesSessionId === b.hermesSessionId &&
    a.deviceId === b.deviceId &&
    a.keyId === b.keyId &&
    a.msgId === b.msgId &&
    a.seq === b.seq &&
    a.issuedAtMs === b.issuedAtMs &&
    a.expiresAtMs === b.expiresAtMs &&
    a.kind === b.kind &&
    a.payloadB64 === b.payloadB64 &&
    a.mac === b.mac
  );
}

function sameReceipt(a: E2EDisableReceiptV1, b: E2EDisableReceiptV1): boolean {
  return (
    a.v === b.v &&
    a.kind === b.kind &&
    a.sessionId === b.sessionId &&
    a.hermesSessionId === b.hermesSessionId &&
    a.keyId === b.keyId &&
    a.intentDeviceId === b.intentDeviceId &&
    a.intentMsgId === b.intentMsgId &&
    a.intentSeq === b.intentSeq &&
    a.receiptId === b.receiptId &&
    a.mac === b.mac
  );
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

/** Store writer only ever emits canonical padded base64; accept exactly that shape on load. */
function decodeKey(sid: string, value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error(`bad canonical base64 for session ${JSON.stringify(sid)}`);
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error(`bad K_S for session ${JSON.stringify(sid)}: expected canonical base64 of 32 bytes`);
  }
  return key;
}

function parseSnapshot(raw: string): StoreState {
  const value = JSON.parse(raw) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("keystore root must be an object");
  }
  const root = value as Record<string, unknown>;
  const keys = new Map<string, Buffer>();
  const pendingDisable = new Set<string>();
  const disableIntents = new Map<string, E2EControlEnvelopeV1>();
  const disableReceipts = new Map<string, E2EDisableReceiptV1>();
  const protectedSessions = new Map<string, "enable" | "disable" | null>();
  for (const [storedSid, encoded] of Object.entries(root)) {
    if (!storedSid) throw new Error("keystore contains an empty session id");
    if (storedSid.startsWith(PENDING_DISABLE_PREFIX)) {
      const key = decodeKey(storedSid, encoded);
      if (!key.equals(PENDING_DISABLE_MARKER)) throw new Error("pending-disable marker value is invalid");
      const sid = decodePendingDisableMetaSid(storedSid);
      if (pendingDisable.has(sid)) throw new Error("duplicate pending-disable metadata");
      pendingDisable.add(sid);
    } else if (storedSid.startsWith(DISABLE_INTENT_PREFIX)) {
      const sid = decodeMetadataSid(DISABLE_INTENT_PREFIX, storedSid);
      const intent = decodeMetadata(encoded, "disable intent");
      if (
        intent === null ||
        typeof intent !== "object" ||
        Array.isArray(intent) ||
        // v 的校验来自 OpenClaw 那份（合并 #572 时取了没有它的 CC 版）。crypto verify 路径
        // 也会验 v，但落盘元数据在**进内存之前**就该拒掉未知版本，别把它带进对账逻辑。
        (intent as Partial<E2EControlEnvelopeV1>).v !== 1 ||
        (intent as Partial<E2EControlEnvelopeV1>).kind !== "session.e2e.disable" ||
        (intent as Partial<E2EControlEnvelopeV1>).hermesSessionId !== sid
      ) {
        throw new Error("invalid stored disable intent");
      }
      if (disableIntents.has(sid)) throw new Error("duplicate disable intent metadata");
      disableIntents.set(sid, intent as E2EControlEnvelopeV1);
    } else if (storedSid.startsWith(DISABLE_RECEIPT_PREFIX)) {
      const sid = decodeMetadataSid(DISABLE_RECEIPT_PREFIX, storedSid);
      const receipt = decodeMetadata(encoded, "disable receipt");
      if (
        receipt === null ||
        typeof receipt !== "object" ||
        Array.isArray(receipt) ||
        (receipt as Partial<E2EDisableReceiptV1>).v !== 1 || // 同上（OpenClaw 基线）
        (receipt as Partial<E2EDisableReceiptV1>).kind !== "session.e2e.disabled" ||
        (receipt as Partial<E2EDisableReceiptV1>).hermesSessionId !== sid
      ) {
        throw new Error("invalid stored disable receipt");
      }
      if (disableReceipts.has(sid)) throw new Error("duplicate disable receipt metadata");
      disableReceipts.set(sid, receipt as E2EDisableReceiptV1);
    } else if (storedSid.startsWith(PROTECTED_PREFIX)) {
      const sid = decodeMetadataSid(PROTECTED_PREFIX, storedSid);
      const pendingOp = decodeMetadata(encoded, "protected floor");
      if (
        (pendingOp !== null && pendingOp !== "enable" && pendingOp !== "disable") ||
        protectedSessions.has(sid)
      ) {
        throw new Error("invalid/duplicate protected floor metadata");
      }
      protectedSessions.set(sid, pendingOp);
    } else {
      const key = decodeKey(storedSid, encoded);
      keys.set(storedSid, key);
    }
  }
  for (const sid of pendingDisable) {
    if (!keys.has(sid)) throw new Error("pending-disable metadata has no corresponding K_S");
    if (!disableIntents.has(sid)) throw new Error("pending-disable metadata has no signed intent");
  }
  for (const sid of disableIntents.keys()) {
    if (!pendingDisable.has(sid)) throw new Error("disable intent has no pending-disable marker");
  }
  for (const sid of disableReceipts.keys()) {
    if (!pendingDisable.has(sid)) throw new Error("disable receipt has no pending-disable marker");
  }
  return { keys, pendingDisable, disableIntents, disableReceipts, protected: protectedSessions };
}

function snapshotJson(state: StoreState): string {
  const { keys, pendingDisable, disableIntents, disableReceipts, protected: protectedSessions } = state;
  const encoded: Array<[string, string]> = [...keys.entries()].map(([sid, key]) => {
    if (!sid) throw new Error("keystore contains an empty session id");
    if (key.length !== 32) throw new Error(`bad K_S length for session ${JSON.stringify(sid)}: ${key.length}`);
    return [sid, key.toString("base64")];
  });
  for (const sid of pendingDisable) {
    if (!keys.has(sid)) throw new Error(`pending-disable ${sid} has no corresponding K_S`);
    const intent = disableIntents.get(sid);
    if (!intent) throw new Error(`pending-disable ${sid} has no signed intent`);
    encoded.push([pendingDisableMetaSid(sid), PENDING_DISABLE_MARKER.toString("base64")]);
    encoded.push([metadataSid(DISABLE_INTENT_PREFIX, sid), encodeMetadata(intent)]);
    const receipt = disableReceipts.get(sid);
    if (receipt) {
      encoded.push([metadataSid(DISABLE_RECEIPT_PREFIX, sid), encodeMetadata(receipt)]);
    }
  }
  for (const sid of disableIntents.keys()) {
    if (!pendingDisable.has(sid)) throw new Error(`disable intent ${sid} has no pending marker`);
  }
  for (const sid of disableReceipts.keys()) {
    if (!pendingDisable.has(sid)) throw new Error(`disable receipt ${sid} has no pending marker`);
  }
  for (const [sid, pendingOp] of protectedSessions) {
    encoded.push([metadataSid(PROTECTED_PREFIX, sid), encodeMetadata(pendingOp)]);
  }
  encoded.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // Object.fromEntries creates "__proto__" as an own data property rather than invoking a setter.
  return JSON.stringify(Object.fromEntries(encoded));
}

function sameSnapshot(a: StoreState, b: StoreState): boolean {
  if (
    a.keys.size !== b.keys.size ||
    a.pendingDisable.size !== b.pendingDisable.size ||
    a.disableIntents.size !== b.disableIntents.size ||
    a.disableReceipts.size !== b.disableReceipts.size ||
    a.protected.size !== b.protected.size
  ) return false;
  for (const [sid, key] of a.keys) {
    if (!b.keys.get(sid)?.equals(key)) return false;
  }
  return (
    [...a.pendingDisable].every((sid) => b.pendingDisable.has(sid)) &&
    [...a.disableIntents].every(
      ([sid, intent]) => !!b.disableIntents.get(sid) && sameIntent(intent, b.disableIntents.get(sid)!),
    ) &&
    [...a.disableReceipts].every(
      ([sid, receipt]) => !!b.disableReceipts.get(sid) && sameReceipt(receipt, b.disableReceipts.get(sid)!),
    ) &&
    [...a.protected].every(([sid, pendingOp]) => b.protected.get(sid) === pendingOp)
  );
}

function readCandidate(path: string): StoreCandidate {
  try {
    const raw = readFileSync(path, "utf8");
    const state = parseSnapshot(raw);
    return { kind: "valid", path, state, raw, mode: statSync(path).mode & 0o777 };
  } catch (error) {
    return isErrno(error, "ENOENT") ? { kind: "missing", path } : { kind: "invalid", path, error };
  }
}

function emptyStoreState(): StoreState {
  return {
    keys: new Map(),
    pendingDisable: new Set(),
    disableIntents: new Map(),
    disableReceipts: new Map(),
    protected: new Map(),
  };
}

function authoritativeStoreState(path: string): StoreState {
  const main = readCandidate(path);
  const backup = readCandidate(path + ".bak");
  if (main.kind === "missing" && backup.kind === "missing") return emptyStoreState();
  const source = main.kind === "valid" ? main : backup.kind === "valid" ? backup : null;
  if (!source) {
    throw new Error(
      `[e2e] keystore has no valid snapshot during locked commit: ` +
        `${candidateSummary(main)}; ${candidateSummary(backup)}`,
    );
  }
  return source.state;
}

function candidateSummary(candidate: StoreCandidate): string {
  if (candidate.kind === "missing") return `${candidate.path}: missing`;
  if (candidate.kind === "valid") return `${candidate.path}: valid`;
  const detail = candidate.error instanceof Error ? candidate.error.message : String(candidate.error);
  return `${candidate.path}: ${detail}`;
}

function openUniqueTemp(target: string): { fd: number; path: string } {
  const dir = dirname(target);
  const name = basename(target);
  for (let attempt = 0; attempt < 10; attempt++) {
    const path = join(dir, `.${name}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
    try {
      return { fd: openSync(path, "wx", 0o600), path };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
  }
  throw new Error(`could not allocate a unique temp file beside ${target}`);
}

/**
 * Durable single-file replacement: a unique 0600 temp in the same directory is fsynced before
 * atomic rename, then the directory is fsynced so the rename itself survives a crash.
 */
function atomicWrite(target: string, contents: string): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const temp = openUniqueTemp(target);
  let fdOpen = true;
  let renamed = false;
  try {
    writeFileSync(temp.fd, contents, "utf8");
    chmodSync(temp.path, 0o600);
    fsyncSync(temp.fd);
    closeSync(temp.fd);
    fdOpen = false;
    renameSync(temp.path, target);
    renamed = true;

    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    if (fdOpen) {
      try {
        closeSync(temp.fd);
      } catch {
        /* preserve the original write error */
      }
    }
    if (!renamed) {
      try {
        unlinkSync(temp.path);
      } catch {
        /* temp may never have been created or may already have moved */
      }
    }
    throw error;
  }
}

/** keystore 通用錯誤基類（OpenClaw 測試 / instanceof 兼容）。 */
export class E2EKeyStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "E2EKeyStoreError";
  }
}

/** 啟動時主/備快照皆不可讀——fail-closed，拒絕空 Map 降級。 */
export class E2EKeyStoreLoadError extends E2EKeyStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "E2EKeyStoreLoadError";
  }
}

/** 寫盤失敗（atomic pair 不完整）。 */
export class E2EKeyStorePersistenceError extends E2EKeyStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "E2EKeyStorePersistenceError";
  }
}

/** 持久化失敗後實例 poison——任何後續操作必須重啟。 */
export class E2EKeyStorePoisonedError extends E2EKeyStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "E2EKeyStorePoisonedError";
  }
}

/** stale/不一致控制 ACK；持久化與 poisoned 錯誤不得偽裝成此類而被上層吞掉。 */
export class E2EKeyStoreStateError extends E2EKeyStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "E2EKeyStoreStateError";
  }
}

/**
 * #731 設備授權未通過（缺/錯 `authProof`）。刻意單列一個類型：wrap 的 catch 要把
 * 「這台設備沒被授權」與「這台設備公鑰是壞的」分開——前者要回報給用戶（可修：重新掃碼），
 * 後者是畸形數據（用戶做不了什麼）。都繼承 StateError，既有 `instanceof` 判據不變。
 */
export class E2EDeviceUnauthorizedError extends E2EKeyStoreStateError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "E2EDeviceUnauthorizedError";
  }
}

/** 只吞 stale/state mismatch；持久化、poison 或未知錯誤重拋到 connector outer fatal。 */
export function settleE2EBackfillAck(
  store: Pick<E2EKeyStore, "markEnableComplete" | "completeDisable">,
  sid: string,
  mode: "enable" | "disable",
  disableReceipt?: unknown,
): boolean {
  try {
    if (mode === "enable") store.markEnableComplete(sid);
    else store.completeDisable(sid, disableReceipt);
    return true;
  } catch (error) {
    if (error instanceof E2EKeyStoreStateError) return false;
    throw error;
  }
}

export class E2EKeyStore {
  private keys = new Map<string, Buffer>(); // hermesSessionId → K_S(32B)
  /** server-positive protection floor；ready omission 不能令本地已有 key 靜默降級。 */
  private serverE2E = new Map<string, "enable" | "disable" | null>();
  /** 本地有 K_S 但 server 快照省略：未知是否 ACK 丢失，按 session 隔离。 */
  private quarantined = new Set<string>();
  private pendingDisable = new Set<string>();
  private disableIntents = new Map<string, E2EControlEnvelopeV1>();
  private disableReceipts = new Map<string, E2EDisableReceiptV1>();
  private serverStateSynced = false;
  /** A partial two-file commit makes disk vs memory uncertain; this instance must never continue. */
  private poisoned: E2EKeyStorePoisonedError | null = null;
  /** #731 設備授權；null = 舊配對無 secret，wrap 降級。 */
  private deviceAuth: DeviceAuthConfig | null = null;
  private deviceAuthLegacyWarned = false;
  /** #273 每會話「已拿到 K_S 的設備」自報的交互能力並集（進程內；見 deviceSupports）。 */
  private sessionDeviceCaps = new Map<string, { clarify?: true; secret?: true }>();
  /** #731 上一次 wrap 因授權失敗被跳過的 deviceId（由連接器取走回報 server）。 */
  private deviceAuthRejected: string[] = [];

  constructor(private readonly path: string) {
    withE2EKeyStoreLock(this.path, () => this.load());
  }

  /**
   * #731 注入配對 secret + 已授權設備表。可在構造後、首次 wrap 前調用。
   * secret 非法 → 視為無授權能力（降級），不拋。
   */
  configureDeviceAuth(config: DeviceAuthConfig | null): void {
    if (!config) {
      this.deviceAuth = null;
      return;
    }
    if (!isCanonicalDeviceAuthSecret(config.secret) || !config.agentLinkId) {
      console.error(
        "[E2E device-auth] secret/agentLinkId 無效 → 降級為無設備授權（存量/損壞憑證）",
      );
      this.deviceAuth = null;
      return;
    }
    this.deviceAuth = {
      secret: config.secret,
      agentLinkId: config.agentLinkId,
      authorizedDevices: { ...(config.authorizedDevices ?? {}) },
      persistAuthorized: config.persistAuthorized,
    };
  }

  /** 測試 / 觀測：當前是否啟用設備授權校驗。 */
  hasDeviceAuth(): boolean {
    return this.deviceAuth !== null;
  }

  private load(): void {
    const main = readCandidate(this.path);
    const backup = readCandidate(this.path + ".bak");
    if (main.kind === "missing" && backup.kind === "missing") {
      // Only the unambiguous double-ENOENT state is a fresh installation.
      this.keys = new Map();
      this.pendingDisable = new Set();
      this.disableIntents = new Map();
      this.disableReceipts = new Map();
      this.serverE2E = new Map();
      return;
    }

    // Main is authoritative whenever valid. This prevents an older backup from resurrecting a
    // removed key; if main is unusable, the valid backup is the only safe recovery candidate.
    const source = main.kind === "valid" ? main : backup.kind === "valid" ? backup : null;
    if (!source) {
      throw new E2EKeyStoreLoadError(
        `[e2e] keystore is corrupt or unreadable; refusing to start (fail-closed). ` +
          `${candidateSummary(main)}; ${candidateSummary(backup)}. ` +
          `Continuing would send existing E2E sessions as plaintext. If you intentionally abandon ` +
          `all E2E keys, remove both files and restart; historical ciphertext will no longer decrypt.`,
      );
    }

    const canonical = snapshotJson(source.state);
    const needsRepair = (candidate: StoreCandidate): boolean =>
      candidate.kind !== "valid" ||
      candidate.mode !== 0o600 ||
      candidate.raw !== canonical ||
      !sameSnapshot(candidate.state, source.state);

    try {
      // Main first: if backup replacement then fails, a restart deterministically selects the
      // already-current main and repairs backup. A completed load/save always leaves both current.
      if (needsRepair(main)) atomicWrite(this.path, canonical);
      if (needsRepair(backup)) atomicWrite(this.path + ".bak", canonical);
    } catch (cause) {
      throw new E2EKeyStoreLoadError(
        `[e2e] could not repair the keystore pair ${this.path} / ${this.path}.bak; refusing to start`,
        { cause },
      );
    }

    // 修复成功後才報告——這兩件事**運維必須看見**（OpenClaw 那份原本會打，合併 #572 時丟了）：
    // 靜默修好意味著「主檔壞過一次」沒有任何痕跡，下次再壞就沒人知道這是第二次。
    if (main.kind !== "valid") {
      console.error(
        `[e2e] 主 keystore ${this.path} ${main.kind === "missing" ? "缺失" : "損壞"}` +
          `（${candidateSummary(main)}），已從 ${this.path}.bak 恢復 ${source.state.keys.size} 把密鑰`,
      );
    } else if (needsRepair(backup)) {
      console.error(`[e2e] ${this.path}.bak 缺失/損壞/過期，已由主檔重建`);
    }
    this.keys = new Map([...source.state.keys].map(([sid, key]) => [sid, Buffer.from(key)]));
    this.pendingDisable = new Set(source.state.pendingDisable);
    this.disableIntents = new Map(source.state.disableIntents);
    this.disableReceipts = new Map(source.state.disableReceipts);
    this.serverE2E = new Map(source.state.protected);
  }

  private assertUsable(): void {
    if (this.poisoned) throw this.poisoned;
  }

  private commit(
    next: Map<string, Buffer>,
    nextPendingDisable = new Set(this.pendingDisable),
    nextDisableIntents = new Map(this.disableIntents),
    nextDisableReceipts = new Map(this.disableReceipts),
    nextProtected = new Map(this.serverE2E),
  ): void {
    this.assertUsable();
    const baseState: StoreState = {
      keys: new Map(this.keys),
      pendingDisable: new Set(this.pendingDisable),
      disableIntents: new Map(this.disableIntents),
      disableReceipts: new Map(this.disableReceipts),
      protected: new Map(this.serverE2E),
    };
    const desiredState: StoreState = {
      keys: next,
      pendingDisable: nextPendingDisable,
      disableIntents: nextDisableIntents,
      disableReceipts: nextDisableReceipts,
      protected: nextProtected,
    };
    // CAS 衝突有限重試：每次都在鎖內重讀磁盤權威快照，另一個進程的寫序列收斂後即可提交。
    let committed: StoreState | undefined;
    let lastConflict: E2EKeyStoreConflictError | undefined;
    for (let attempt = 1; attempt <= CAS_MAX_ATTEMPTS && !committed; attempt++) {
      try {
        committed = withE2EKeyStoreLock(this.path, () => {
          const disk = authoritativeStoreState(this.path);
          const snapshot = mergeE2EKeyStoreSnapshots(
            snapshotJson(baseState),
            snapshotJson(desiredState),
            snapshotJson(disk),
            logicalSessionId,
          );
          const merged = parseSnapshot(snapshot);
          // Keep both files at the latest snapshot. A previous-generation backup can resurrect
          // receipt-deleted keys or lose another process's newly committed protection floor.
          atomicWrite(this.path, snapshot);
          atomicWrite(this.path + ".bak", snapshot);
          return merged;
        });
      } catch (cause) {
        // ⚠️ 只有**真的持久化不確定**才 poison 整個實例（poison = 該進程所有 E2E 會話
        // fail closed 直到重啟，代價極大）。下面兩類都不是：
        if (cause instanceof E2EKeyStoreConflictError) {
          // 「我的內存過期了」：重讀磁盤重試；重試耗盡也只讓本次操作失敗（見迴圈外）。
          lastConflict = cause;
          continue;
        }
        if (cause instanceof E2EKeyStoreLockTimeoutError) {
          // 「現在拿不到鎖」：本次操作失敗，實例照舊可用，其它 session 不受影響。
          throw new E2EKeyStoreStateError(
            `E2E keystore 進程鎖等待超時，本次操作未提交（實例仍可用）：${cause.message}`,
            { cause: cause },
          );
        }
        const failure = new E2EKeyStorePersistenceError(
          `[e2e] keystore persistence failed; this instance is poisoned and must restart before handling any session`,
          { cause },
        );
        this.poisoned = new E2EKeyStorePoisonedError(
          `[e2e] keystore persistence failed; this instance is poisoned and must restart before handling any session`,
          { cause: failure },
        );
        throw failure;
      }
    }
    if (!committed) {
      // 只隔離本次操作/本 session：調用方按狀態級拒絕處理（軟拒絕該幀），
      // 下一次 ready 對賬會用權威快照重新收斂。
      throw new E2EKeyStoreStateError(
        `E2E keystore 併發衝突，${CAS_MAX_ATTEMPTS} 次重讀後仍未收斂，本次操作未提交` +
          `（實例仍可用）：${lastConflict?.message ?? "unknown"}`,
        { cause: lastConflict },
      );
    }
    // Copy-on-write: memory changes only after the complete two-file snapshot reached disk.
    this.keys = committed.keys;
    this.pendingDisable = committed.pendingDisable;
    this.disableIntents = committed.disableIntents;
    this.disableReceipts = committed.disableReceipts;
    this.serverE2E = committed.protected;
  }

  requireKey(sid: string): Buffer {
    this.assertUsable();
    if (this.quarantined.has(sid)) {
      throw new E2EKeyStoreStateError(
        `[e2e] session ${sid} 处于 quarantine（server 快照省略但本地仍持钥），拒绝处理内容`,
      );
    }
    const key = this.keys.get(sid);
    if (!key) {
      throw new E2EKeyStoreStateError(
        `[e2e] no E2E key for session ${sid}（缺少本地 K_S，fail-closed）`,
      );
    }
    return Buffer.from(key);
  }

  isE2E(sid: string): boolean {
    this.assertUsable();
    return this.keys.has(sid) || this.serverE2E.has(sid);
  }

  /** 本地持鑰與 server protection floor 的完整 wire sid 集，供身份映射做 fail-closed 對賬。 */
  protectedSessionIds(): string[] {
    this.assertUsable();
    return [...new Set([...this.keys.keys(), ...this.serverE2E.keys()])];
  }

  /** 只有 ready 的權威 server 快照已套用，零 protected sid 才能用作身份狀態遷移依據。 */
  hasServerStateSnapshot(): boolean {
    this.assertUsable();
    return this.serverStateSynced;
  }

  hasKey(sid: string): boolean {
    this.assertUsable();
    return this.keys.has(sid);
  }

  /**
   * ready 的 server E2E 快照必须先于出站缓冲 flush 应用。
   * 返回「server 已保护但本地缺 key」的 pending-enable sid，调用方据此丢弃首连前积压的明文 TUI。
   */
  applyServerState(raw: unknown): string[] {
    this.assertUsable();
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new E2EKeyStoreStateError("[e2e] Link B ready 缺少合法 e2eState，拒绝进入 ready（fail-closed）");
    }
    const state = raw as Partial<ServerE2EStateV1>;
    if (state.version !== 1 || !Array.isArray(state.sessions)) {
      throw new E2EKeyStoreStateError("[e2e] Link B ready 的 e2eState 版本/shape 无效（fail-closed）");
    }
    if (!Array.isArray(state.disabledReceipts)) {
      throw new E2EKeyStoreStateError("[e2e] Link B ready 缺少 disabledReceipts 数组（fail-closed）");
    }

    // Protection floor 单调累积；ready omission 不能抹掉已见过的 E2E session。
    const next = new Map(this.serverE2E);
    const reported = new Set<string>();
    const blockedSessionIds: string[] = [];
    for (const item of state.sessions) {
      if (
        item === null ||
        typeof item !== "object" ||
        typeof item.hermesSessionId !== "string" ||
        !item.hermesSessionId ||
        (item.pendingOp !== null && item.pendingOp !== "enable" && item.pendingOp !== "disable") ||
        reported.has(item.hermesSessionId)
      ) {
        throw new E2EKeyStoreStateError("[e2e] Link B ready 的 e2eState session 无效（fail-closed）");
      }
      reported.add(item.hermesSessionId);
      next.set(item.hermesSessionId, item.pendingOp);
      if (!this.keys.has(item.hermesSessionId)) {
        blockedSessionIds.push(item.hermesSessionId);
        console.error(
          `[e2e] server E2E session ${item.hermesSessionId}（pending=${String(item.pendingOp)}）` +
            "缺少本地 K_S；该 session 已隔离并阻止首连缓冲，其他会话继续运行。请恢复 keystore 或在 app 安全处置。",
        );
      }
    }

    const remoteReceipts = new Map<string, unknown>();
    for (const receipt of state.disabledReceipts) {
      if (
        receipt === null ||
        typeof receipt !== "object" ||
        Array.isArray(receipt) ||
        typeof (receipt as { hermesSessionId?: unknown }).hermesSessionId !== "string" ||
        !(receipt as { hermesSessionId: string }).hermesSessionId ||
        remoteReceipts.has((receipt as { hermesSessionId: string }).hermesSessionId)
      ) {
        throw new E2EKeyStoreStateError("[e2e] Link B ready 的 disabled receipt 无效/重复（fail-closed）");
      }
      const sid = (receipt as { hermesSessionId: string }).hermesSessionId;
      if (reported.has(sid) && next.get(sid) !== "enable") {
        throw new Error("[e2e] ready 只有 pending-enable epoch rollover 可与 disabled receipt 同现");
      }
      remoteReceipts.set(sid, receipt);
    }

    const reconciledKeys = new Map(this.keys);
    const reconciledPending = new Set(this.pendingDisable);
    const reconciledIntents = new Map(this.disableIntents);
    const reconciledReceipts = new Map(this.disableReceipts);
    const completedDisable = new Set<string>();
    for (const sid of this.pendingDisable) {
      const reportedPendingOp = reported.has(sid) ? next.get(sid) : undefined;
      if (reported.has(sid) && reportedPendingOp !== "enable") {
        if (reportedPendingOp !== "disable") {
          console.error(
            `[e2e] pending-disable ${sid} 未获 completion receipt；server 仍声明 E2E，保留 intent/K_S`,
          );
        }
        continue;
      }
      const key = this.keys.get(sid);
      const intent = this.disableIntents.get(sid);
      const localReceipt = this.disableReceipts.get(sid);
      const remoteReceipt = remoteReceipts.get(sid);
      try {
        if (!key || !intent || !localReceipt || !remoteReceipt) {
          throw new E2EKeyStoreStateError("missing local/remote completion receipt state");
        }
        const verified = verifyE2EDisableReceipt(key, intent, remoteReceipt);
        if (!sameReceipt(localReceipt, verified)) {
          throw new E2EKeyStoreStateError("ready receipt differs from locally released receipt");
        }
        reconciledKeys.delete(sid);
        reconciledPending.delete(sid);
        reconciledIntents.delete(sid);
        reconciledReceipts.delete(sid);
        if (reportedPendingOp !== "enable") next.delete(sid);
        completedDisable.add(sid);
        console.error(
          reportedPendingOp === "enable"
            ? `[e2e] pending-disable ${sid} 已由 matching receipt 结算；删除 K1 并保留 enable floor 等待 K2`
            : `[e2e] pending-disable ${sid} 的 ACK 丢失；ready receipt 验真后清理 K_S`,
        );
      } catch (error) {
        if (reportedPendingOp === "enable") {
          throw new E2EKeyStoreStateError(
            `[e2e] pending-disable ${sid} 遇到 pending-enable 但缺少匹配 completion receipt；` +
              "拒绝复用旧 K_S（fail-closed）",
            { cause: error },
          );
        }
        console.error(
          `[e2e] pending-disable ${sid} 被 ready omission 但无有效 completion receipt；` +
            `保留 K_S/intent 并隔离：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (
      reconciledKeys.size !== this.keys.size ||
      reconciledPending.size !== this.pendingDisable.size ||
      reconciledIntents.size !== this.disableIntents.size ||
      reconciledReceipts.size !== this.disableReceipts.size ||
      next.size !== this.serverE2E.size ||
      [...next].some(([sid, pendingOp]) => this.serverE2E.get(sid) !== pendingOp)
    ) {
      this.commit(
        reconciledKeys,
        reconciledPending,
        reconciledIntents,
        reconciledReceipts,
        next,
      );
    }

    const quarantined = new Set<string>();
    for (const sid of reconciledKeys.keys()) {
      if (!reported.has(sid) && !completedDisable.has(sid)) {
        console.error(
          `[e2e] 本地 keystore 持有 session ${sid} 的 K_S，但 server e2eState 未列出；` +
            "保留本地 protection floor 并隔离，不自动删钥/降明文。请核实 disable 是否已提交后再受控清理。",
        );
        blockedSessionIds.push(sid);
        quarantined.add(sid);
      }
    }
    for (const [sid] of next) {
      if (
        (!reported.has(sid) || completedDisable.has(sid)) &&
        !reconciledKeys.has(sid) &&
        !blockedSessionIds.includes(sid)
      ) {
        blockedSessionIds.push(sid);
      }
    }
    for (const sid of completedDisable) quarantined.delete(sid);

    // 只有完整快照全部验证通过后才发布；失败时 LinkBClient 会终止，绝不 flush。
    this.serverE2E = next;
    this.quarantined = quarantined;
    this.serverStateSynced = true;
    return blockedSessionIds;
  }

  /** 在线 enable/disable 控制帧先提升保护状态；只有 pending-enable 可暂时缺 key。 */
  markServerE2E(sid: string, pendingOp: "enable" | "disable" | null): void {
    this.assertUsable();
    if (!sid) throw new E2EKeyStoreStateError("[e2e] 空 session id");
    // 先标 server-positive，再检查本地 key：即使上层捕获错误，也不会回落到明文路径。
    const nextProtected = new Map(this.serverE2E);
    nextProtected.set(sid, pendingOp);
    this.commit(
      new Map(this.keys),
      new Set(this.pendingDisable),
      new Map(this.disableIntents),
      new Map(this.disableReceipts),
      nextProtected,
    );
    if (pendingOp === "enable") this.quarantined.delete(sid);
    this.serverStateSynced = true;
    if (pendingOp !== "enable" && !this.keys.has(sid)) {
      throw new E2EKeyStoreStateError(
        `[e2e] server E2E session ${sid} 缺少本地 K_S（fail-closed）`,
      );
    }
  }

  /**
   * live pending-enable 的 epoch 入口。上一轮 disable ACK 若丢失，本地仍持 K1 + intent + R1；
   * 必须先验证 server 回显的同一 R1，并在一笔持久化提交中退休 K1，之后才可生成 K2。
   */
  beginEnable(sid: string, receiptValue?: unknown): void {
    this.assertUsable();
    if (!sid) throw new E2EKeyStoreStateError("[e2e] 空 session id");
    if (this.pendingDisable.has(sid)) {
      const key = this.keys.get(sid);
      const intent = this.disableIntents.get(sid);
      const localReceipt = this.disableReceipts.get(sid);
      if (!key || !intent || !localReceipt || receiptValue === undefined) {
        throw new E2EKeyStoreStateError(
          `[e2e] pending re-enable ${sid} 缺少本地/远端 completion receipt（fail-closed）`,
        );
      }
      const receipt = verifyE2EDisableReceipt(key, intent, receiptValue);
      if (!sameReceipt(localReceipt, receipt)) {
        throw new E2EKeyStoreStateError(
          `[e2e] pending re-enable ${sid} 的 completion receipt 不匹配`,
        );
      }
      const nextKeys = new Map(this.keys);
      nextKeys.delete(sid);
      const nextPending = new Set(this.pendingDisable);
      nextPending.delete(sid);
      const nextIntents = new Map(this.disableIntents);
      nextIntents.delete(sid);
      const nextReceipts = new Map(this.disableReceipts);
      nextReceipts.delete(sid);
      const nextProtected = new Map(this.serverE2E);
      nextProtected.set(sid, "enable");
      this.commit(nextKeys, nextPending, nextIntents, nextReceipts, nextProtected);
      this.quarantined.delete(sid);
      this.serverStateSynced = true;
      return;
    }
    const previous = this.serverE2E.get(sid);
    if (this.keys.has(sid) && previous !== "enable") {
      throw new E2EKeyStoreStateError(
        `[e2e] re-enable ${sid} 仍有非当前 enable epoch 的 K_S（fail-closed）`,
      );
    }
    if (previous !== "enable") {
      const nextProtected = new Map(this.serverE2E);
      nextProtected.set(sid, "enable");
      this.commit(
        new Map(this.keys),
        new Set(this.pendingDisable),
        new Map(this.disableIntents),
        new Map(this.disableReceipts),
        nextProtected,
      );
    }
    this.quarantined.delete(sid);
    this.serverStateSynced = true;
  }

  /** enable 回灌 ACK 后把 pending 状态收敛为 enabled；K_S 必须已经存在。 */
  markEnableComplete(sid: string): void {
    this.assertUsable();
    if (this.serverStateSynced && this.serverE2E.get(sid) !== "enable") {
      throw new E2EKeyStoreStateError(
        `[e2e] stale enable ACK for session ${sid}; current server transition is not enable`,
      );
    }
    if (!this.keys.has(sid)) {
      throw new E2EKeyStoreStateError(`[e2e] enable ACK session ${sid} 缺少本地 K_S（fail-closed）`);
    }
    const nextProtected = new Map(this.serverE2E);
    nextProtected.set(sid, null);
    this.commit(
      new Map(this.keys),
      new Set(this.pendingDisable),
      new Map(this.disableIntents),
      new Map(this.disableReceipts),
      nextProtected,
    );
    this.serverStateSynced = true;
  }

  /** 只可在 server 回显/ready 给出匹配且 MAC 有效的 completion receipt 后调用。 */
  completeDisable(sid: string, receiptValue: unknown): void {
    this.assertUsable();
    const key = this.keys.get(sid);
    const intent = this.disableIntents.get(sid);
    const localReceipt = this.disableReceipts.get(sid);
    if (!this.pendingDisable.has(sid) || !key || !intent || !localReceipt) {
      throw new E2EKeyStoreStateError(`[e2e] stale disable receipt for session ${sid}`);
    }
    const receipt = verifyE2EDisableReceipt(key, intent, receiptValue);
    if (!sameReceipt(localReceipt, receipt)) {
      throw new E2EKeyStoreStateError(
        `[e2e] server disable receipt differs from locally released receipt for ${sid}`,
      );
    }
    // 保持 server-positive floor 直到双快照持久删除完成；失败时实例 poison 且仍不可走明文。
    const next = new Map(this.keys);
    next.delete(sid);
    const nextPending = new Set(this.pendingDisable);
    nextPending.delete(sid);
    const nextIntents = new Map(this.disableIntents);
    nextIntents.delete(sid);
    const nextReceipts = new Map(this.disableReceipts);
    nextReceipts.delete(sid);
    const nextProtected = new Map(this.serverE2E);
    nextProtected.delete(sid);
    this.commit(next, nextPending, nextIntents, nextReceipts, nextProtected);
    this.quarantined.delete(sid);
  }

  beginDisable(sid: string, intent: E2EControlEnvelopeV1): void {
    this.requireKey(sid);
    if (
      intent.kind !== "session.e2e.disable" ||
      intent.hermesSessionId !== sid
    ) {
      throw new E2EKeyStoreStateError(`[e2e] disable intent/session mismatch for ${sid}`);
    }
    if (this.pendingDisable.has(sid)) {
      const current = this.disableIntents.get(sid);
      if (!current || !sameIntent(current, intent)) {
        throw new E2EKeyStoreStateError(`[e2e] conflicting pending disable intent for ${sid}`);
      }
      return;
    }
    const nextPending = new Set(this.pendingDisable);
    nextPending.add(sid);
    const nextIntents = new Map(this.disableIntents);
    nextIntents.set(sid, intent);
    this.commit(
      new Map(this.keys),
      nextPending,
      nextIntents,
      new Map(this.disableReceipts),
    );
  }

  hasPendingDisable(sid: string): boolean {
    this.assertUsable();
    return this.pendingDisable.has(sid) && this.disableIntents.has(sid);
  }

  /** server 明确拒绝且尚未签 release receipt：撤销本地 intent，保留 K_S/E2E floor 允许新意图重试。 */
  cancelDisableBeforeRelease(sid: string): void {
    this.assertUsable();
    if (!this.pendingDisable.has(sid)) return;
    if (this.disableReceipts.has(sid)) {
      throw new E2EKeyStoreStateError(
        `[e2e] disable receipt already released for ${sid}; refusing to cancel ambiguous transition`,
      );
    }
    const nextPending = new Set(this.pendingDisable);
    nextPending.delete(sid);
    const nextIntents = new Map(this.disableIntents);
    nextIntents.delete(sid);
    const nextProtected = new Map(this.serverE2E);
    nextProtected.set(sid, null);
    this.commit(
      new Map(this.keys),
      nextPending,
      nextIntents,
      new Map(this.disableReceipts),
      nextProtected,
    );
  }

  /** 明文 snapshot 已取得；先持久化 receipt，之后 caller 才可把 backfill 释放给 server。 */
  disableReceiptForBackfill(sid: string): E2EDisableReceiptV1 {
    this.assertUsable();
    const key = this.keys.get(sid);
    const intent = this.disableIntents.get(sid);
    if (!this.pendingDisable.has(sid) || !key || !intent) {
      throw new E2EKeyStoreStateError(`[e2e] no signed pending disable intent for ${sid}`);
    }
    const existing = this.disableReceipts.get(sid);
    if (existing) {
      verifyE2EDisableReceipt(key, intent, existing);
      return existing;
    }
    const receipt = createE2EDisableReceipt(key, intent);
    const nextReceipts = new Map(this.disableReceipts);
    nextReceipts.set(sid, receipt);
    this.commit(
      new Map(this.keys),
      new Set(this.pendingDisable),
      new Map(this.disableIntents),
      nextReceipts,
    );
    return receipt;
  }

  /** 開啟 E2E 的唯一建鑰入口：先持久化 main+.bak，成功後才讓本進程看見新 key。 */
  createForEnable(sid: string): Buffer {
    this.assertUsable();
    if (!sid) throw new Error("cannot create an E2E key for an empty session id");
    if (this.pendingDisable.has(sid)) {
      throw new E2EKeyStoreStateError(
        `[e2e] session ${sid} 仍在 pending-disable；必须先用 matching R1 退休 K1`,
      );
    }
    const existing = this.keys.get(sid);
    if (existing) return Buffer.from(existing);
    if (this.serverStateSynced && this.serverE2E.get(sid) !== "enable") {
      throw new E2EKeyStoreStateError(
        `[e2e] session ${sid} 并非 server pending-enable，禁止隐式生成新 K_S（fail-closed）`,
      );
    }

    const key = ec.newSessionKey();
    if (key.length !== 32) throw new Error(`newSessionKey returned ${key.length} bytes, expected 32`);
    const next = new Map(this.keys);
    next.set(sid, Buffer.from(key));
    this.commit(next);
    return Buffer.from(key);
  }

  /** @deprecated compatibility alias; new enable call sites should use createForEnable explicitly. */
  getOrCreateKey(sid: string): Buffer {
    return this.createForEnable(sid);
  }

  /**
   * 幀級校驗：`devices` 這個列表本身是否自洽。四家連接器對稱（#366 驗收項）。
   *
   * 兩種失敗語義刻意分層，別再混為一談：
   * - **畸形幀**（本函數）：同一批 `devices` 出現重複 `deviceId`，或條目連 `deviceId`
   *   都沒有。這種錯無法歸因到某一台設備（同一 deviceId 的兩個 pubKey，哪個才是權威
   *   版本？），也說明請求方本身有問題 → 整幀拒絕，拋 `E2EKeyStoreStateError`。
   *   調用方**必須在內層接住只打日誌**：server 會在重連後的 bootstrapE2E 重發同一幀，
   *   讓它冒泡到 onFatal 等於「一幀畸形請求 = 連接器永久起不來」的 DoS。
   * - **單台壞公鑰**（`wrapKeyForDevices`）：某條目缺 `pubKey`、非 canonical base64、
   *   server 已宣告的指紋對不上、或封裝本身失敗 → 只跳過這一台並告警，其餘照封。
   *   一台設備有問題不該讓多設備用戶的**所有**設備都拿不到 K_S。
   */
  private assertWrapTargetsWellFormed(devices: DevicePub[]): void {
    const seen = new Set<string>();
    for (const d of devices ?? []) {
      const id = typeof d?.deviceId === "string" ? d.deviceId : "";
      if (!id || seen.has(id)) {
        throw new E2EKeyStoreStateError("invalid or duplicate device wrap target");
      }
      seen.add(id);
    }
  }

  /**
   * #731：有 secret 時，每台設備必須 proof 通過或本地已授權同一指紋，才封 K_S。
   * 無 secret（舊配對）→ 降級 wrap 全部 + 一次性警告。不得把 fingerprint 當授權。
   */
  private assertDeviceAuthorized(d: DevicePub, fingerprint: string): void {
    const auth = this.deviceAuth;
    if (!auth) {
      if (!this.deviceAuthLegacyWarned) {
        this.deviceAuthLegacyWarned = true;
        console.error(
          "[E2E device-auth] 本連接器無配對 secret（舊配對）→ wrap 不校驗設備授權；" +
            "重新配對後新碼會帶 secret。e2eKeyVersionBinding ≠ 設備授權。",
        );
      }
      return;
    }
    const prior = auth.authorizedDevices?.[d.deviceId];
    if (prior && prior === fingerprint) return;
    if (
      verifyDeviceAuthProof(
        auth.secret,
        auth.agentLinkId,
        d.deviceId,
        fingerprint,
        d.authProof,
      )
    ) {
      const next = { ...(auth.authorizedDevices ?? {}), [d.deviceId]: fingerprint };
      auth.authorizedDevices = next;
      try {
        auth.persistAuthorized?.(next);
      } catch (error) {
        console.error(
          `[E2E device-auth] 持久化授權表失敗（本進程內仍生效）: ${(error as Error).message}`,
        );
      }
      return;
    }
    throw new E2EDeviceUnauthorizedError(
      "device not authorized (missing/invalid authProof; refusing wrap for unknown fingerprint)",
    );
  }

  /**
   * #731：取走並清空「上一次 wrap 因設備授權被跳過」的 deviceId 列表。
   * 連接器把它掛進 `e2e_key.deviceAuthRejected`，server 據此告訴那台設備「你沒被授權」——
   * 否則跳過是**完全靜默**的，用戶只看到一個永遠轉圈的 Updating。
   */
  takeDeviceAuthRejections(): string[] {
    const out = this.deviceAuthRejected;
    this.deviceAuthRejected = [];
    return out;
  }

  private wrapKeyForDevices(k: Buffer, devices: DevicePub[], sid?: string): WrappedDeviceKey[] {
    const out: WrappedDeviceKey[] = [];
    this.deviceAuthRejected = [];
    // #273 只統計**真的拿到 K_S** 的設備：被跳過的設備解不開任何東西，它的自報能力無意義。
    const caps: { clarify?: true; secret?: true } = {};
    for (const d of devices ?? []) {
      try {
        if (!d.pubKey) {
          throw new E2EKeyStoreStateError("missing device public key");
        }
        const fingerprint = deviceKeyFingerprint(d.pubKey); // 非 canonical 公鑰在此拋
        // 能力自適應：舊 server（或回滾後的 server）不帶 `keyFingerprint`——按公鑰自算即可，
        // 絕不因為對端沒宣告版本就跳過該設備、讓用戶拿不到 K_S。帶了就必須對得上。
        if (d.keyFingerprint && fingerprint !== d.keyFingerprint) {
          throw new E2EKeyStoreStateError("device public key fingerprint mismatch");
        }
        // #731 設備授權：在封 K_S 之前校驗（單台跳過，其餘照封）。
        this.assertDeviceAuthorized(d, fingerprint);
        out.push({
          deviceId: d.deviceId,
          keyFingerprint: fingerprint,
          sealed: ec.wrapKey(k, d.pubKey),
        });
        if (d.e2eCaps?.clarify === true) caps.clarify = true;
        if (d.e2eCaps?.secret === true) caps.secret = true;
      } catch (error) {
        // 單台壞公鑰 / 未授權：跳過並響亮記錄，其餘設備照封（絕不 all-or-nothing）。
        console.error(`[E2E wrap skipped device ${d?.deviceId}] ${(error as Error).message}`);
        if (error instanceof E2EDeviceUnauthorizedError && d?.deviceId) {
          this.deviceAuthRejected.push(d.deviceId);
        }
      }
    }
    if (sid) {
      // 並集而非覆蓋:一台老設備 + 一台新設備時,新設備仍該收到密文形態(老設備本來就
      // 讀不了 E2E 內容,不因這條變差)。全是老設備 → 空 → 走 #273 之前的路徑。
      const prev = this.sessionDeviceCaps.get(sid) ?? {};
      const merged = { ...prev, ...caps };
      if (merged.clarify || merged.secret) this.sessionDeviceCaps.set(sid, merged);
    }
    return out;
  }

  /**
   * #273 本會話是否有設備解得開該類交互密文。**默認 false**——沒有正向聲明就當不支持，
   * 調用方走 #273 之前的路徑（clarify/secret 本地 skip 解掛）。
   *
   * 進程內記憶:連接器重啟後為空,直到 server 在 Link B ready 重發 wrap 請求把能力帶回來。
   * 失效方向是**安全**的（退回舊行為），不是打開缺口。
   */
  deviceSupports(sid: string, kind: "clarify" | "secret"): boolean {
    return this.sessionDeviceCaps.get(sid)?.[kind] === true;
  }

  /** 首次 enable：必要时生成 K_S，再封装给设备。 */
  wrapForEnable(sid: string, devices: DevicePub[]): WrappedDeviceKey[] {
    this.assertWrapTargetsWellFormed(devices); // 畸形幀不得觸發 K_S 生成
    return this.wrapKeyForDevices(this.createForEnable(sid), devices, sid);
  }

  /** 新设备补封：必须沿用既有 K_S；缺 key 时拒绝，绝不生成不兼容的 K₂。 */
  wrapExistingForDevices(sid: string, devices: DevicePub[]): WrappedDeviceKey[] {
    this.assertWrapTargetsWellFormed(devices);
    return this.wrapKeyForDevices(this.requireKey(sid), devices, sid);
  }

  /** @deprecated 兼容旧调用，语义等同首次 enable；index 会依据 backfill 显式选路。 */
  wrapForDevices(sid: string, devices: DevicePub[]): WrappedDeviceKey[] {
    return this.wrapForEnable(sid, devices);
  }

  /** 內容對象（{text,reasoning,tools}）→ 密文塊。 */
  encryptContent(sid: string, obj: unknown): string {
    return ec.encrypt(this.requireKey(sid), JSON.stringify(obj));
  }

  decryptContent(sid: string, blobB64: string): unknown {
    return JSON.parse(ec.decrypt(this.requireKey(sid), blobB64));
  }

  encryptText(sid: string, text: string): string {
    return ec.encrypt(this.requireKey(sid), text);
  }

  decryptText(sid: string, blobB64: string): string {
    return ec.decrypt(this.requireKey(sid), blobB64);
  }
}
