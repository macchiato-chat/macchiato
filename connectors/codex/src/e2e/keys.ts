/**
 * §19 per-session E2E 密鑰管理（Codex 連接器側, 對應 Python e2e_keys.py）。
 * K_S 存 ~/.macchiato/codex-e2e.json（0600, 原子寫；與 Hermes/CC/OpenClaw 的 keystore 分開——
 * #144:fork 自 CC 時曾誤共用 claude-code-e2e.json,兩個常駐進程整檔原子重寫會互相覆蓋 K_S）。
 * **某 hermesSessionId 在 store 里 = 該會話已開 E2E。** 鍵 = server 的 hermesSessionId（原始大小寫）。
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
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
  return process.env.MACCHIATO_CODEX_E2E_STORE || join(homedir(), ".macchiato/codex-e2e.json");
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

type Snapshot =
  | { kind: "missing" }
  | { kind: "valid"; state: StoreState }
  | { kind: "invalid"; error: unknown };

interface StoreState {
  keys: Map<string, Buffer>;
  pendingDisable: Set<string>;
  disableIntents: Map<string, E2EControlEnvelopeV1>;
  disableReceipts: Map<string, E2EDisableReceiptV1>;
  protected: Map<string, "enable" | "disable" | null>;
}

const CANONICAL_32_BYTE_BASE64 = /^[A-Za-z0-9+/]{43}=$/;
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

function decodeMetadataSid(prefix: string, storedSid: string): string {
  const encoded = storedSid.slice(prefix.length);
  const sid = Buffer.from(encoded, "base64url").toString("utf8");
  if (!sid || Buffer.from(sid, "utf8").toString("base64url") !== encoded) {
    throw new Error("disable metadata session id is not canonical base64url");
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

function emptyStoreState(): StoreState {
  return {
    keys: new Map(),
    pendingDisable: new Set(),
    disableIntents: new Map(),
    disableReceipts: new Map(),
    protected: new Map(),
  };
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

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class E2EKeyStoreLoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "E2EKeyStoreLoadError";
  }
}

export class E2EKeyStorePersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "E2EKeyStorePersistenceError";
  }
}

export class E2EKeyStorePoisonedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "E2EKeyStorePoisonedError";
  }
}

export class E2EKeyStoreStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "E2EKeyStoreStateError";
  }
}

/**
 * committed backfill ACK 的 store 收斂邊界：只有可辨識的 stale/state mismatch 可拒收；
 * persistence/poison/未知錯誤必須重拋給 connector outer fatal，不能偽裝成 stale ACK 繼續跑。
 */
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
  /** server-positive protection floor；server 漏報不能令本地已有 key 靜默降級。 */
  private serverE2E = new Map<string, "enable" | "disable" | null>();
  /** 本地有 K_S 但 server 快照省略：未知是否 ACK 丢失，按 session 隔离。 */
  private quarantined = new Set<string>();
  /** disable backfill 已发送但 ACK 未结算；与 K_S 同一原子快照持久化。 */
  private pendingDisable = new Set<string>();
  private disableIntents = new Map<string, E2EControlEnvelopeV1>();
  private disableReceipts = new Map<string, E2EDisableReceiptV1>();
  private serverStateSynced = false;
  private poisoned: E2EKeyStorePersistenceError | null = null;

  constructor(private readonly path: string = e2eStorePath()) {
    withE2EKeyStoreLock(this.path, () => this.load());
  }

  private load(): void {
    const primary = this.readSnapshot(this.path);
    const backup = this.readSnapshot(this.backupPath());

    // 只有主檔和備份都確實不存在才是首次啟動；任何既存但不可讀/不合法的檔案都不能降級成空 store。
    if (primary.kind === "missing" && backup.kind === "missing") {
      this.keys = new Map();
      this.pendingDisable = new Set();
      this.disableIntents = new Map();
      this.disableReceipts = new Map();
      this.serverE2E = new Map();
      return;
    }

    const recovered = primary.kind === "valid" ? primary.state : backup.kind === "valid" ? backup.state : null;
    if (!recovered) {
      const primaryState = primary.kind === "invalid" ? `invalid (${errorMessage(primary.error)})` : primary.kind;
      const backupState = backup.kind === "invalid" ? `invalid (${errorMessage(backup.error)})` : backup.kind;
      const cause = primary.kind === "invalid" ? primary.error : backup.kind === "invalid" ? backup.error : undefined;
      throw new E2EKeyStoreLoadError(
        `E2E keystore has no valid snapshot: primary=${primaryState}, backup=${backupState}`,
        { cause },
      );
    }

    try {
      // 主檔有效時它是權威版本；否則用備份恢復。兩邊都重寫為同一份最新快照，
      // 避免「備份永遠落後一代」造成新 key 丟失或已刪 key 復活。
      this.persistSnapshotPair(
        recovered.keys,
        recovered.pendingDisable,
        recovered.disableIntents,
        recovered.disableReceipts,
        recovered.protected,
      );
    } catch (error) {
      throw new E2EKeyStoreLoadError("failed to repair E2E keystore snapshots", { cause: error });
    }
    this.keys = new Map(recovered.keys);
    this.pendingDisable = new Set(recovered.pendingDisable);
    this.disableIntents = new Map(recovered.disableIntents);
    this.disableReceipts = new Map(recovered.disableReceipts);
    this.serverE2E = new Map(recovered.protected);
  }

  private readSnapshot(path: string): Snapshot {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      return isENOENT(error) ? { kind: "missing" } : { kind: "invalid", error };
    }

    try {
      const decoded: unknown = JSON.parse(raw);
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw new Error("snapshot must be a JSON object");
      }

      const root = decoded as Record<string, unknown>;
      const keys = new Map<string, Buffer>();
      const pendingDisable = new Set<string>();
      const disableIntents = new Map<string, E2EControlEnvelopeV1>();
      const disableReceipts = new Map<string, E2EDisableReceiptV1>();
      const protectedSessions = new Map<string, "enable" | "disable" | null>();
      for (const [storedSid, value] of Object.entries(root)) {
        if (typeof value !== "string") throw new Error("snapshot key must be a base64 string");
        if (storedSid.startsWith(PENDING_DISABLE_PREFIX)) {
          if (!CANONICAL_32_BYTE_BASE64.test(value)) {
            throw new Error("pending-disable marker is not canonical 32-byte base64");
          }
          const key = Buffer.from(value, "base64");
          if (!key.equals(PENDING_DISABLE_MARKER)) throw new Error("pending-disable marker value is invalid");
          const sid = decodeMetadataSid(PENDING_DISABLE_PREFIX, storedSid);
          if (pendingDisable.has(sid)) throw new Error("duplicate pending-disable metadata");
          pendingDisable.add(sid);
        } else if (storedSid.startsWith(DISABLE_INTENT_PREFIX)) {
          const sid = decodeMetadataSid(DISABLE_INTENT_PREFIX, storedSid);
          const intent = decodeMetadata(value, "disable intent");
          if (
            intent === null ||
            typeof intent !== "object" ||
            Array.isArray(intent) ||
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
          const receipt = decodeMetadata(value, "disable receipt");
          if (
            receipt === null ||
            typeof receipt !== "object" ||
            Array.isArray(receipt) ||
            (receipt as Partial<E2EDisableReceiptV1>).v !== 1 ||
            (receipt as Partial<E2EDisableReceiptV1>).kind !== "session.e2e.disabled" ||
            (receipt as Partial<E2EDisableReceiptV1>).hermesSessionId !== sid
          ) {
            throw new Error("invalid stored disable receipt");
          }
          if (disableReceipts.has(sid)) throw new Error("duplicate disable receipt metadata");
          disableReceipts.set(sid, receipt as E2EDisableReceiptV1);
        } else if (storedSid.startsWith(PROTECTED_PREFIX)) {
          const sid = decodeMetadataSid(PROTECTED_PREFIX, storedSid);
          const pendingOp = decodeMetadata(value, "protected floor");
          if (
            (pendingOp !== null && pendingOp !== "enable" && pendingOp !== "disable") ||
            protectedSessions.has(sid)
          ) {
            throw new Error("invalid/duplicate protected floor metadata");
          }
          protectedSessions.set(sid, pendingOp);
        } else {
          if (!storedSid || !CANONICAL_32_BYTE_BASE64.test(value)) {
            throw new Error("snapshot key is not canonical 32-byte base64");
          }
          const key = Buffer.from(value, "base64");
          if (key.length !== 32 || key.toString("base64") !== value) {
            throw new Error("snapshot key is not canonical 32-byte base64");
          }
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
      return {
        kind: "valid",
        state: {
          keys,
          pendingDisable,
          disableIntents,
          disableReceipts,
          protected: protectedSessions,
        },
      };
    } catch (error) {
      return { kind: "invalid", error };
    }
  }

  private backupPath(): string {
    return `${this.path}.bak`;
  }

  private serialize(
    keys: Map<string, Buffer>,
    pendingDisable: ReadonlySet<string>,
    disableIntents: ReadonlyMap<string, E2EControlEnvelopeV1>,
    disableReceipts: ReadonlyMap<string, E2EDisableReceiptV1>,
    protectedSessions: ReadonlyMap<string, "enable" | "disable" | null>,
  ): string {
    const entries: Array<[string, string]> = [...keys].map(([sid, key]) => [sid, key.toString("base64")]);
    for (const sid of pendingDisable) {
      if (!keys.has(sid)) throw new Error(`pending-disable ${sid} has no corresponding K_S`);
      const intent = disableIntents.get(sid);
      if (!intent) throw new Error(`pending-disable ${sid} has no signed intent`);
      entries.push([pendingDisableMetaSid(sid), PENDING_DISABLE_MARKER.toString("base64")]);
      entries.push([metadataSid(DISABLE_INTENT_PREFIX, sid), encodeMetadata(intent)]);
      const receipt = disableReceipts.get(sid);
      if (receipt) {
        entries.push([metadataSid(DISABLE_RECEIPT_PREFIX, sid), encodeMetadata(receipt)]);
      }
    }
    for (const sid of disableIntents.keys()) {
      if (!pendingDisable.has(sid)) throw new Error(`disable intent ${sid} has no pending marker`);
    }
    for (const sid of disableReceipts.keys()) {
      if (!pendingDisable.has(sid)) throw new Error(`disable receipt ${sid} has no pending marker`);
    }
    for (const [sid, pendingOp] of protectedSessions) {
      entries.push([metadataSid(PROTECTED_PREFIX, sid), encodeMetadata(pendingOp)]);
    }
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify(Object.fromEntries(entries));
  }

  private persistSnapshotPair(
    keys: Map<string, Buffer>,
    pendingDisable: ReadonlySet<string>,
    disableIntents: ReadonlyMap<string, E2EControlEnvelopeV1>,
    disableReceipts: ReadonlyMap<string, E2EDisableReceiptV1>,
    protectedSessions: ReadonlyMap<string, "enable" | "disable" | null>,
  ): void {
    const serialized = this.serialize(
      keys,
      pendingDisable,
      disableIntents,
      disableReceipts,
      protectedSessions,
    );
    this.atomicWrite(this.path, serialized);
    this.atomicWrite(this.backupPath(), serialized);
  }

  private atomicWrite(target: string, data: string): void {
    const parent = dirname(target);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const tmp = join(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      // mode 在建立檔案時即生效，避免先以較寬權限落盤再 chmod 的暴露窗口。
      fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeFileSync(fd, data, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, target); // 同目錄 rename：原子替換且保留 tmp 的 0600。
      // 文件 fsync 不包含目录项；再 fsync parent，保证崩溃后 rename 本身也持久。
      const dirFd = openSync(parent, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // 保留原始寫入錯誤。
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
        // rename 成功後 tmp 已不存在；失敗時清理是 best-effort，不能掩蓋原始錯誤。
      }
    }
  }

  private assertUsable(): void {
    if (this.poisoned) {
      throw new E2EKeyStorePoisonedError(
        "E2E keystore is unusable after a persistence failure; restart after repairing the store",
        { cause: this.poisoned },
      );
    }
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
        const primary = this.readSnapshot(this.path);
        const backup = this.readSnapshot(this.backupPath());
        const disk =
          primary.kind === "valid"
            ? primary.state
            : backup.kind === "valid"
              ? backup.state
              : primary.kind === "missing" && backup.kind === "missing"
                ? emptyStoreState()
                : null;
        if (!disk) throw new Error("E2E keystore has no valid snapshot during locked commit");
        const mergedRaw = mergeE2EKeyStoreSnapshots(
          this.serialize(
            baseState.keys,
            baseState.pendingDisable,
            baseState.disableIntents,
            baseState.disableReceipts,
            baseState.protected,
          ),
          this.serialize(
            desiredState.keys,
            desiredState.pendingDisable,
            desiredState.disableIntents,
            desiredState.disableReceipts,
            desiredState.protected,
          ),
          this.serialize(
            disk.keys,
            disk.pendingDisable,
            disk.disableIntents,
            disk.disableReceipts,
            disk.protected,
          ),
          logicalSessionId,
        );
        this.atomicWrite(this.path, mergedRaw);
        this.atomicWrite(this.backupPath(), mergedRaw);
        const parsed = this.readSnapshot(this.path);
        if (parsed.kind !== "valid") throw new Error("locked keystore commit produced an invalid snapshot");
        return parsed.state;
      });
    } catch (error) {
      const failure = new E2EKeyStorePersistenceError("failed to persist E2E keystore", { cause: error });
      this.poisoned = failure;
      throw failure;
    }
    // Copy-on-write：只有主檔與備份都完成後，才發布新的記憶體狀態。
    this.keys = committed.keys;
    this.pendingDisable = committed.pendingDisable;
    this.disableIntents = committed.disableIntents;
    this.disableReceipts = committed.disableReceipts;
    this.serverE2E = committed.protected;
  }

  hasKey(sid: string): boolean {
    this.assertUsable();
    return this.keys.has(sid);
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

  /**
   * ready 的 server E2E 快照必須先於 ready/斷線緩衝 flush 套用。
   * 返回 server 已保護、但本地尚缺 K_S 的 pending-enable sid，Link B 據此丟棄首連前明文 TUI。
   */
  applyServerState(raw: unknown): string[] {
    this.assertUsable();
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new E2EKeyStoreStateError("Link B ready 缺少合法 e2eState（fail-closed）");
    }
    const state = raw as Partial<ServerE2EStateV1>;
    if (state.version !== 1 || !Array.isArray(state.sessions)) {
      throw new E2EKeyStoreStateError("Link B ready 的 e2eState 版本或 shape 無效（fail-closed）");
    }
    if (!Array.isArray(state.disabledReceipts)) {
      throw new E2EKeyStoreStateError("Link B ready 缺少 disabledReceipts 数组（fail-closed）");
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
        throw new E2EKeyStoreStateError("Link B ready 的 e2eState session 無效（fail-closed）");
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
        throw new E2EKeyStoreStateError("Link B ready 的 disabled receipt 无效/重复（fail-closed）");
      }
      const sid = (receipt as { hermesSessionId: string }).hermesSessionId;
      if (reported.has(sid) && next.get(sid) !== "enable") {
        throw new E2EKeyStoreStateError("ready 只有 pending-enable epoch rollover 可与 disabled receipt 同现");
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
            `pending-disable ${sid} 遇到 pending-enable 但缺少匹配 completion receipt；` +
              "拒绝复用旧 K_S（fail-closed）",
            { cause: error },
          );
        }
        console.error(
          `[e2e] pending-disable ${sid} 被 ready omission 但无有效 completion receipt；` +
            `保留 K_S/intent 并隔离：${errorMessage(error)}`,
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

    // 全量驗證成功後才發布，畸形/缺鑰快照不能留下半套 server 狀態。
    this.serverE2E = next;
    this.quarantined = quarantined;
    this.serverStateSynced = true;
    return blockedSessionIds;
  }

  markServerE2E(sid: string, pendingOp: "enable" | "disable" | null): void {
    this.assertUsable();
    if (!sid) throw new E2EKeyStoreStateError("E2E session id 不可為空");
    // 先抬高 server protection floor；即使隨後發現缺鑰，後續 isE2E 也不能回落到明文。
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
      throw new E2EKeyStoreStateError(`server E2E session ${sid} 缺少本地 K_S（fail-closed）`);
    }
  }

  /** live pending-enable：验 matching R1 并原子退休 K1，随后 createForEnable 才可生成 K2。 */
  beginEnable(sid: string, receiptValue?: unknown): void {
    this.assertUsable();
    if (!sid) throw new E2EKeyStoreStateError("E2E session id 不可為空");
    if (this.pendingDisable.has(sid)) {
      const key = this.keys.get(sid);
      const intent = this.disableIntents.get(sid);
      const localReceipt = this.disableReceipts.get(sid);
      if (!key || !intent || !localReceipt || receiptValue === undefined) {
        throw new E2EKeyStoreStateError(
          `pending re-enable ${sid} 缺少本地/远端 completion receipt（fail-closed）`,
        );
      }
      const receipt = verifyE2EDisableReceipt(key, intent, receiptValue);
      if (!sameReceipt(localReceipt, receipt)) {
        throw new E2EKeyStoreStateError(`pending re-enable ${sid} 的 completion receipt 不匹配`);
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
        `re-enable ${sid} 仍有非当前 enable epoch 的 K_S（fail-closed）`,
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

  markEnableComplete(sid: string): void {
    this.assertUsable();
    if (this.serverStateSynced && this.serverE2E.get(sid) !== "enable") {
      throw new E2EKeyStoreStateError(`stale enable ACK for session ${sid}; current transition is not enable`);
    }
    if (!this.keys.has(sid)) {
      throw new E2EKeyStoreStateError(`enable ACK session ${sid} 缺少本地 K_S（fail-closed）`);
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
      throw new E2EKeyStoreStateError(`stale disable receipt for session ${sid}`);
    }
    const receipt = verifyE2EDisableReceipt(key, intent, receiptValue);
    if (!sameReceipt(localReceipt, receipt)) {
      throw new E2EKeyStoreStateError(
        `server disable receipt differs from locally released receipt for ${sid}`,
      );
    }
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

  /** 签封 disable 经认证后调用；intent 与 K_S 同一 flat 双快照持久化。 */
  beginDisable(sid: string, intent: E2EControlEnvelopeV1): void {
    this.requireKey(sid);
    if (intent.kind !== "session.e2e.disable" || intent.hermesSessionId !== sid) {
      throw new E2EKeyStoreStateError(`disable intent/session mismatch for ${sid}`);
    }
    if (this.pendingDisable.has(sid)) {
      const current = this.disableIntents.get(sid);
      if (!current || !sameIntent(current, intent)) {
        throw new E2EKeyStoreStateError(`conflicting pending disable intent for ${sid}`);
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
        `disable receipt already released for ${sid}; refusing to cancel ambiguous transition`,
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
      throw new E2EKeyStoreStateError(`no signed pending disable intent for ${sid}`);
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

  requireKey(sid: string): Buffer {
    this.assertUsable();
    if (this.quarantined.has(sid)) {
      throw new E2EKeyStoreStateError(
        `E2E session ${sid} 处于 quarantine（server 快照省略但本地仍持钥），拒绝处理内容`,
      );
    }
    const key = this.keys.get(sid);
    if (!key) throw new E2EKeyStoreStateError(`server E2E session ${sid} 缺少本地 K_S（fail-closed）`);
    return Buffer.from(key);
  }

  /** 僅供顯式 enable 流程：既有則返回，否則生成 K_S，且雙快照落盤成功後才返回。 */
  createForEnable(sid: string): Buffer {
    this.assertUsable();
    if (this.pendingDisable.has(sid)) {
      throw new E2EKeyStoreStateError(
        `session ${sid} 仍在 pending-disable；必须先用 matching R1 退休 K1`,
      );
    }
    const existing = this.keys.get(sid);
    if (existing) return Buffer.from(existing);
    if (this.serverStateSynced && this.serverE2E.get(sid) !== "enable") {
      throw new E2EKeyStoreStateError(
        `session ${sid} 並非 server pending-enable，禁止生成新 K_S（fail-closed）`,
      );
    }

    const key = ec.newSessionKey();
    const next = new Map(this.keys);
    next.set(sid, Buffer.from(key));
    this.commit(next);
    return Buffer.from(key);
  }

  /** @deprecated 僅為既有 enable 呼叫點相容；新程式碼請明確使用 createForEnable。 */
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

  /** 首次 enable：必要時生成 K_S，再封裝給設備。 */
  wrapForEnable(sid: string, devices: DevicePub[]): { deviceId: string; sealed: string }[] {
    return this.wrapKeyForDevices(this.createForEnable(sid), devices);
  }

  /** 新設備補封：必須沿用既有 K_S；缺鑰時絕不生成不相容的 K₂。 */
  wrapExistingForDevices(sid: string, devices: DevicePub[]): { deviceId: string; sealed: string }[] {
    return this.wrapKeyForDevices(this.requireKey(sid), devices);
  }

  /** @deprecated index 會依 backfill 明確選 wrapForEnable / wrapExisting。 */
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
