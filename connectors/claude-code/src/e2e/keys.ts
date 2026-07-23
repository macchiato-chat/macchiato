/**
 * §19 per-session E2E 密鑰管理（Claude Code 連接器側, 對應 Python e2e_keys.py）。
 * K_S 存 ~/.macchiato/claude-code-e2e.json（0600, fsync + 原子寫；與 Hermes 的 e2e.json 分開）。
 * **某 hermesSessionId 在 store 里 = 該會話已開 E2E。** 鍵 = server 的 hermesSessionId（原始大小寫）。
 */
import { randomBytes } from "node:crypto";
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
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as ec from "./crypto";
import {
  createE2EDisableReceipt,
  verifyE2EDisableReceipt,
  type E2EControlEnvelopeV1,
  type E2EDisableReceiptV1,
} from "./control";
import {
  mergeE2EKeyStoreSnapshots,
  withE2EKeyStoreLock,
} from "./file-lock";

export function e2eStorePath(): string {
  return process.env.MACCHIATO_CLAUDE_CODE_E2E_STORE || join(homedir(), ".macchiato/claude-code-e2e.json");
}

export interface DevicePub {
  deviceId: string;
  pubKey: string;
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

const PENDING_DISABLE_PREFIX = "\u0000macchiato:pending-disable:";
const PENDING_DISABLE_MARKER = Buffer.alloc(32, 0xa5);
const DISABLE_INTENT_PREFIX = "\u0000macchiato:disable-intent:";
const DISABLE_RECEIPT_PREFIX = "\u0000macchiato:disable-receipt:";
const PROTECTED_PREFIX = "\u0000macchiato:protected:";

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

/** stale/不一致控制 ACK；持久化與 poisoned 錯誤不得偽裝成此類而被上層吞掉。 */
export class E2EKeyStoreStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "E2EKeyStoreStateError";
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
  private poisoned: Error | null = null;

  constructor(private readonly path: string = e2eStorePath()) {
    withE2EKeyStoreLock(this.path, () => this.load());
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
      throw new Error(
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
      throw new Error(
        `[e2e] could not repair the keystore pair ${this.path} / ${this.path}.bak; refusing to start`,
        { cause },
      );
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
    let committed: StoreState;
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
      this.poisoned = new Error(
        `[e2e] keystore persistence failed; this instance is poisoned and must restart before handling any session`,
        { cause },
      );
      throw this.poisoned;
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
      throw new Error("[e2e] Link B ready 缺少合法 e2eState，拒绝进入 ready（fail-closed）");
    }
    const state = raw as Partial<ServerE2EStateV1>;
    if (state.version !== 1 || !Array.isArray(state.sessions)) {
      throw new Error("[e2e] Link B ready 的 e2eState 版本/shape 无效（fail-closed）");
    }
    if (!Array.isArray(state.disabledReceipts)) {
      throw new Error("[e2e] Link B ready 缺少 disabledReceipts 数组（fail-closed）");
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
        throw new Error("[e2e] Link B ready 的 e2eState session 无效（fail-closed）");
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
        throw new Error("[e2e] Link B ready 的 disabled receipt 无效/重复（fail-closed）");
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

  private wrapKeyForDevices(k: Buffer, devices: DevicePub[]): { deviceId: string; sealed: string }[] {
    const out: { deviceId: string; sealed: string }[] = [];
    for (const d of devices ?? []) {
      if (!d?.deviceId || !d?.pubKey) continue;
      try {
        out.push({ deviceId: d.deviceId, sealed: ec.wrapKey(k, d.pubKey) });
      } catch {
        /* 公鑰格式壞 → 跳過該設備 */
      }
    }
    return out;
  }

  /** 首次 enable：必要时生成 K_S，再封装给设备。 */
  wrapForEnable(sid: string, devices: DevicePub[]): { deviceId: string; sealed: string }[] {
    return this.wrapKeyForDevices(this.createForEnable(sid), devices);
  }

  /** 新设备补封：必须沿用既有 K_S；缺 key 时拒绝，绝不生成不兼容的 K₂。 */
  wrapExistingForDevices(sid: string, devices: DevicePub[]): { deviceId: string; sealed: string }[] {
    return this.wrapKeyForDevices(this.requireKey(sid), devices);
  }

  /** @deprecated 兼容旧调用，语义等同首次 enable；index 会依据 backfill 显式选路。 */
  wrapForDevices(sid: string, devices: DevicePub[]): { deviceId: string; sealed: string }[] {
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
