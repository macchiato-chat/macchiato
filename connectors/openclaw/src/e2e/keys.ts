/**
 * §19 per-session E2E 密鑰管理（OpenClaw 連接器側, 對應 Python e2e_keys.py）。
 * K_S 存 ~/.macchiato/openclaw-e2e.json（0600, 原子寫；與 Hermes 的 e2e.json 分開）。
 * **某 hermesSessionId 在 store 里 = 該會話已開 E2E。** 鍵 = server 的 hermesSessionId（原始大小寫）。
 */
import {
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
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  return process.env.MACCHIATO_OPENCLAW_E2E_STORE || join(homedir(), ".macchiato/openclaw-e2e.json");
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
  | { kind: "valid"; state: StoreState; raw: string; mode: number }
  | { kind: "missing" }
  | { kind: "invalid"; error: unknown };

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

const SESSION_KEY_B64 = /^[A-Za-z0-9+/]{43}=$/;

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === code;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return `${code ? `${code}: ` : ""}${err.message}`;
  }
  return String(err);
}

function parseSnapshot(raw: string, path: string): StoreState {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${path} 頂層必須是 JSON object`);
  }
  const root = parsed as Record<string, unknown>;
  const keys = new Map<string, Buffer>();
  const pendingDisable = new Set<string>();
  const disableIntents = new Map<string, E2EControlEnvelopeV1>();
  const disableReceipts = new Map<string, E2EDisableReceiptV1>();
  const protectedSessions = new Map<string, "enable" | "disable" | null>();
  for (const [storedSid, value] of Object.entries(root)) {
    if (!storedSid || typeof value !== "string") {
      throw new Error(`${path} 的 session key 格式無效（sid=${storedSid || "<empty>"}）`);
    }
    if (storedSid.startsWith(PENDING_DISABLE_PREFIX)) {
      if (!SESSION_KEY_B64.test(value)) throw new Error(`${path} 的 pending-disable marker 格式無效`);
      const key = Buffer.from(value, "base64");
      if (!key.equals(PENDING_DISABLE_MARKER)) throw new Error(`${path} 的 pending-disable marker 無效`);
      const sid = decodeMetadataSid(PENDING_DISABLE_PREFIX, storedSid);
      if (pendingDisable.has(sid)) throw new Error(`${path} 的 pending-disable metadata 重複`);
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
        throw new Error(`${path} 的 disable intent 無效`);
      }
      if (disableIntents.has(sid)) throw new Error(`${path} 的 disable intent metadata 重複`);
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
        throw new Error(`${path} 的 disable receipt 無效`);
      }
      if (disableReceipts.has(sid)) throw new Error(`${path} 的 disable receipt metadata 重複`);
      disableReceipts.set(sid, receipt as E2EDisableReceiptV1);
    } else if (storedSid.startsWith(PROTECTED_PREFIX)) {
      const sid = decodeMetadataSid(PROTECTED_PREFIX, storedSid);
      const pendingOp = decodeMetadata(value, "protected floor");
      if (
        (pendingOp !== null && pendingOp !== "enable" && pendingOp !== "disable") ||
        protectedSessions.has(sid)
      ) {
        throw new Error(`${path} 的 protected floor metadata 無效/重複`);
      }
      protectedSessions.set(sid, pendingOp);
    } else {
      if (!SESSION_KEY_B64.test(value)) {
        throw new Error(`${path} 的 session key 格式無效（sid=${storedSid}）`);
      }
      const key = Buffer.from(value, "base64");
      if (key.length !== 32 || key.toString("base64") !== value) {
        throw new Error(`${path} 的 K_S 必須是 canonical base64 編碼的 32 bytes（sid=${storedSid}）`);
      }
      keys.set(storedSid, key);
    }
  }
  for (const sid of pendingDisable) {
    if (!keys.has(sid)) throw new Error(`${path} 的 pending-disable metadata 沒有對應 K_S`);
    if (!disableIntents.has(sid)) throw new Error(`${path} 的 pending-disable metadata 沒有签封 intent`);
  }
  for (const sid of disableIntents.keys()) {
    if (!pendingDisable.has(sid)) throw new Error(`${path} 的 disable intent 没有 pending marker`);
  }
  for (const sid of disableReceipts.keys()) {
    if (!pendingDisable.has(sid)) throw new Error(`${path} 的 disable receipt 没有 pending marker`);
  }
  return { keys, pendingDisable, disableIntents, disableReceipts, protected: protectedSessions };
}

function sameState(a: StoreState, b: StoreState): boolean {
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

export class E2EKeyStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "E2EKeyStoreError";
  }
}

/** stale/不一致控制 ACK；持久化與 poisoned 錯誤不得偽裝成此類而被上層吞掉。 */
export class E2EKeyStoreStateError extends E2EKeyStoreError {
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
  /** server-positive protection floor；server omission 不能令本地已有 key 靜默降級。 */
  private serverE2E = new Map<string, "enable" | "disable" | null>();
  /** 本地有 K_S 但 server 快照省略：未知是否 ACK 丟失，按 session 隔離。 */
  private quarantined = new Set<string>();
  private pendingDisable = new Set<string>();
  private disableIntents = new Map<string, E2EControlEnvelopeV1>();
  private disableReceipts = new Map<string, E2EDisableReceiptV1>();
  private serverStateSynced = false;
  private poisoned: Error | null = null;

  constructor(private readonly path: string = e2eStorePath()) {
    withE2EKeyStoreLock(this.path, () => this.load());
  }

  private readSnapshot(path: string): Snapshot {
    try {
      const raw = readFileSync(path, "utf8");
      return { kind: "valid", state: parseSnapshot(raw, path), raw, mode: statSync(path).mode & 0o777 };
    } catch (error) {
      return isErrno(error, "ENOENT") ? { kind: "missing" } : { kind: "invalid", error };
    }
  }

  private load(): void {
    const backupPath = `${this.path}.bak`;
    const main = this.readSnapshot(this.path);
    const backup = this.readSnapshot(backupPath);

    if (main.kind === "missing" && backup.kind === "missing") {
      this.keys = new Map();
      this.pendingDisable = new Set();
      this.disableIntents = new Map();
      this.disableReceipts = new Map();
      this.serverE2E = new Map();
      return;
    }

    if (main.kind === "valid") {
      this.keys = main.state.keys;
      this.pendingDisable = main.state.pendingDisable;
      this.disableIntents = main.state.disableIntents;
      this.disableReceipts = main.state.disableReceipts;
      this.serverE2E = main.state.protected;
      const canonical = this.serialize(
        main.state.keys,
        main.state.pendingDisable,
        main.state.disableIntents,
        main.state.disableReceipts,
        main.state.protected,
      );
      if (main.mode !== 0o600 || main.raw !== canonical) {
        try {
          this.atomicReplace(this.path, canonical);
        } catch (error) {
          throw new E2EKeyStoreError(
            `[e2e] 無法把主 keystore ${this.path} 修復為 canonical 0600 快照；拒絕啟動（fail-closed）：` +
              describeError(error),
            { cause: error },
          );
        }
      }
      if (backup.kind !== "valid" || !sameState(main.state, backup.state)) {
        try {
          this.atomicReplace(backupPath, canonical);
          console.error(`[e2e] ${backupPath} 缺失/損壞/過期，已由主檔重建`);
        } catch (error) {
          throw new E2EKeyStoreError(
            `[e2e] 無法重建 keystore 備份 ${backupPath}；拒絕啟動（fail-closed）。` +
              `請修復目錄權限或磁碟後重試：${describeError(error)}`,
            { cause: error },
          );
        }
      } else if (backup.mode !== 0o600 || backup.raw !== canonical) {
        try {
          this.atomicReplace(backupPath, canonical);
        } catch (error) {
          throw new E2EKeyStoreError(
            `[e2e] 無法把 keystore 備份 ${backupPath} 修復為 canonical 0600 快照；` +
              `拒絕啟動（fail-closed）：${describeError(error)}`,
            { cause: error },
          );
        }
      }
      return;
    }

    if (backup.kind === "valid") {
      const canonical = this.serialize(
        backup.state.keys,
        backup.state.pendingDisable,
        backup.state.disableIntents,
        backup.state.disableReceipts,
        backup.state.protected,
      );
      try {
        this.atomicReplace(this.path, canonical);
        if (backup.mode !== 0o600 || backup.raw !== canonical) this.atomicReplace(backupPath, canonical);
      } catch (error) {
        throw new E2EKeyStoreError(
          `[e2e] 主 keystore ${this.path} 無效，且無法從 ${backupPath} 重建；` +
            `拒絕啟動（fail-closed）：${describeError(error)}`,
          { cause: error },
        );
      }
      this.keys = backup.state.keys;
      this.pendingDisable = backup.state.pendingDisable;
      this.disableIntents = backup.state.disableIntents;
      this.disableReceipts = backup.state.disableReceipts;
      this.serverE2E = backup.state.protected;
      console.error(`[e2e] 主 keystore 缺失/損壞，已從 ${backupPath} 恢復 ${backup.state.keys.size} 把密鑰`);
      return;
    }

    const mainReason = main.kind === "missing" ? "ENOENT" : describeError(main.error);
    const backupReason = backup.kind === "missing" ? "ENOENT" : describeError(backup.error);
    throw new E2EKeyStoreError(
      `[e2e] keystore 無可用快照，拒絕啟動（fail-closed），避免把 E2E 會話明文發給 server。` +
        `主檔 ${this.path}: ${mainReason}；備份 ${backupPath}: ${backupReason}。` +
        `請先從可靠備份恢復；刪除兩檔會永久遺失 K_S，且既有歷史密文將無法解密。`,
    );
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
      if (!keys.has(sid)) throw new Error(`pending-disable ${sid} 沒有對應 K_S`);
      const intent = disableIntents.get(sid);
      if (!intent) throw new Error(`pending-disable ${sid} 沒有签封 intent`);
      entries.push([pendingDisableMetaSid(sid), PENDING_DISABLE_MARKER.toString("base64")]);
      entries.push([metadataSid(DISABLE_INTENT_PREFIX, sid), encodeMetadata(intent)]);
      const receipt = disableReceipts.get(sid);
      if (receipt) {
        entries.push([metadataSid(DISABLE_RECEIPT_PREFIX, sid), encodeMetadata(receipt)]);
      }
    }
    for (const sid of disableIntents.keys()) {
      if (!pendingDisable.has(sid)) throw new Error(`disable intent ${sid} 没有 pending marker`);
    }
    for (const sid of disableReceipts.keys()) {
      if (!pendingDisable.has(sid)) throw new Error(`disable receipt ${sid} 没有 pending marker`);
    }
    for (const [sid, pendingOp] of protectedSessions) {
      entries.push([metadataSid(PROTECTED_PREFIX, sid), encodeMetadata(pendingOp)]);
    }
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify(Object.fromEntries(entries));
  }

  private atomicReplace(target: string, data: string): void {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmp, "wx", 0o600);
      writeFileSync(fd, data, "utf8");
      fsyncSync(fd);
      const opened = fd;
      fd = undefined;
      closeSync(opened);
      renameSync(tmp, target);
      // fsync the directory as well as the file: without this, a crash can lose the
      // rename even though the temp file contents were durable.
      const dirFd = openSync(dirname(target), "r");
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
          /* 保留原始寫入錯誤 */
        }
      }
      try {
        unlinkSync(tmp);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          /* 臨時檔清理失敗不覆蓋真正的持久化結果；唯一檔名避免下次衝突 */
        }
      }
    }
  }

  private persist(
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
        const backup = this.readSnapshot(`${this.path}.bak`);
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
        const merged = parseSnapshot(mergedRaw, this.path);
        // 兩份都保存當前完整快照，且包含其他進程在鎖內已提交的 unrelated sessions。
        this.atomicReplace(this.path, mergedRaw);
        this.atomicReplace(`${this.path}.bak`, mergedRaw);
        return merged;
      });
    } catch (error) {
      this.poisoned = new E2EKeyStoreError(
        `[e2e] keystore 持久化失敗，當前進程已鎖定（fail-closed）：${describeError(error)}`,
        { cause: error },
      );
      throw this.poisoned;
    }
    this.keys = committed.keys;
    this.pendingDisable = committed.pendingDisable;
    this.disableIntents = committed.disableIntents;
    this.disableReceipts = committed.disableReceipts;
    this.serverE2E = committed.protected;
  }

  private assertUsable(): void {
    if (this.poisoned) throw this.poisoned;
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

  /** 身份 registry 只有在 ready 權威快照套用後，才可把「零 protected sid」視為安全遷移條件。 */
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
   * 返回「server 已保护但本地缺 key」的 pending-enable sid，调用方据此丢弃首连前积压的明文帧。
   */
  applyServerState(raw: unknown): string[] {
    this.assertUsable();
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new E2EKeyStoreError("[e2e] Link B ready 缺少合法 e2eState，拒絕進入 ready（fail-closed）");
    }
    const state = raw as Partial<ServerE2EStateV1>;
    if (state.version !== 1 || !Array.isArray(state.sessions)) {
      throw new E2EKeyStoreError("[e2e] Link B ready 的 e2eState 版本/shape 無效（fail-closed）");
    }
    if (!Array.isArray(state.disabledReceipts)) {
      throw new E2EKeyStoreError("[e2e] Link B ready 缺少 disabledReceipts 数组（fail-closed）");
    }
    // Protection floor 單調累積；ready omission 不能抹掉已見過的 E2E session。
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
        throw new E2EKeyStoreError("[e2e] Link B ready 的 e2eState session 無效（fail-closed）");
      }
      reported.add(item.hermesSessionId);
      next.set(item.hermesSessionId, item.pendingOp);
      if (!this.keys.has(item.hermesSessionId)) {
        blockedSessionIds.push(item.hermesSessionId);
        console.error(
          `[e2e] server E2E session ${item.hermesSessionId}（pending=${String(item.pendingOp)}）` +
            "缺少本地 K_S；該 session 已隔離並阻止首連緩衝，其他會話繼續運行。請恢復 keystore 或在 app 安全處置。",
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
        throw new E2EKeyStoreError("[e2e] Link B ready 的 disabled receipt 無效/重複（fail-closed）");
      }
      const sid = (receipt as { hermesSessionId: string }).hermesSessionId;
      if (reported.has(sid) && next.get(sid) !== "enable") {
        throw new E2EKeyStoreError("[e2e] ready 只有 pending-enable epoch rollover 可與 disabled receipt 同現");
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
            `保留 K_S/intent 并隔离：${describeError(error)}`,
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
      this.persist(
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
          `[e2e] 本地 keystore 仍持有 session ${sid} 的 K_S，但 server e2eState 未列出；` +
            "保留本地 protection floor 並隔離，不自動刪鑰/降明文。請核實 disable 是否已提交後再受控清理。",
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
    this.serverE2E = next;
    this.quarantined = quarantined;
    this.serverStateSynced = true;
    return blockedSessionIds;
  }

  /** 在線 enable/disable 控制幀先提升保護狀態；只允許 enable 缺 key 等待明確建鑰。 */
  markServerE2E(sid: string, pendingOp: "enable" | "disable" | null): void {
    this.assertUsable();
    if (!sid) throw new E2EKeyStoreStateError("[e2e] 空 session id");
    // 先持久抬高 server-positive floor；即使隨後發現缺鑰，也不可回落明文。
    const nextProtected = new Map(this.serverE2E);
    nextProtected.set(sid, pendingOp);
    this.persist(
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

  /** live pending-enable：验 matching R1 并原子退休 K1，随后 createForEnable 才可生成 K2。 */
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
      this.persist(nextKeys, nextPending, nextIntents, nextReceipts, nextProtected);
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
      this.persist(
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
      throw new E2EKeyStoreStateError(
        `[e2e] stale enable ACK for session ${sid}; current transition is not enable`,
      );
    }
    if (!this.keys.has(sid)) {
      throw new E2EKeyStoreStateError(
        `[e2e] enable ACK session ${sid} 缺少本地 K_S（fail-closed）`,
      );
    }
    const nextProtected = new Map(this.serverE2E);
    nextProtected.set(sid, null);
    this.persist(
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
      throw new E2EKeyStoreStateError(
        `[e2e] stale disable receipt for session ${sid}`,
      );
    }
    const receipt = verifyE2EDisableReceipt(key, intent, receiptValue);
    if (!sameReceipt(localReceipt, receipt)) {
      throw new E2EKeyStoreStateError(
        `[e2e] server disable receipt differs from locally released receipt for ${sid}`,
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
    this.persist(next, nextPending, nextIntents, nextReceipts, nextProtected);
    this.quarantined.delete(sid);
  }

  beginDisable(sid: string, intent: E2EControlEnvelopeV1): void {
    this.requireKey(sid);
    if (intent.kind !== "session.e2e.disable" || intent.hermesSessionId !== sid) {
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
    this.persist(
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
    this.persist(
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
    this.persist(
      new Map(this.keys),
      new Set(this.pendingDisable),
      new Map(this.disableIntents),
      nextReceipts,
    );
    return receipt;
  }

  /** 只供 server 明確的首次 enable 使用；普通加密/新設備補封絕不隱式換一把 K_S。 */
  createForEnable(sid: string): Buffer {
    this.assertUsable();
    if (this.pendingDisable.has(sid)) {
      throw new E2EKeyStoreStateError(
        `[e2e] session ${sid} 仍在 pending-disable；必须先用 matching R1 退休 K1`,
      );
    }
    const current = this.keys.get(sid);
    if (current) return current;
    if (this.serverStateSynced && this.serverE2E.get(sid) !== "enable") {
      throw new E2EKeyStoreStateError(
        `[e2e] session ${sid} 並非 server pending-enable，禁止隱式生成新 K_S（fail-closed）`,
      );
    }
    const key = ec.newSessionKey();
    const next = new Map(this.keys);
    next.set(sid, key);
    this.persist(next);
    return key;
  }

  /** 舊調用兼容；新代碼應用 createForEnable 明確表達唯一允許建鑰的狀態轉換。 */
  getOrCreateKey(sid: string): Buffer {
    return this.createForEnable(sid);
  }

  requireKey(sid: string): Buffer {
    this.assertUsable();
    if (this.quarantined.has(sid)) {
      throw new E2EKeyStoreStateError(
        `[e2e] session ${sid} 處於 quarantine（server 快照省略但本地仍持鑰），拒絕處理內容`,
      );
    }
    const key = this.keys.get(sid);
    if (!key) {
      throw new E2EKeyStoreStateError(
        `[e2e] server E2E session ${sid} 缺少本地 K_S（fail-closed）`,
      );
    }
    return key;
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

  /** 新設備补封：必须沿用既有 K_S；本地缺钥就拒绝，绝不生成不兼容的 K₂。 */
  wrapExistingForDevices(sid: string, devices: DevicePub[]): { deviceId: string; sealed: string }[] {
    return this.wrapKeyForDevices(this.requireKey(sid), devices);
  }

  /** 舊調用兼容，語義等同首次 enable；index 會依 backfill 明確選擇兩條路。 */
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
