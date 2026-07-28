import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const WAIT_MS = 10;
const WAIT_TIMEOUT_MS = 5_000;

/**
 * 另一個活著的進程持鎖超過 `WAIT_TIMEOUT_MS`。
 *
 * 語義是「現在拿不到鎖」，**不是**「本進程的 keystore 不可信」——把它當持久化失敗去
 * poison 整個實例，會讓該進程**所有** E2E 會話 fail closed 直到重啟。調用方只讓本次
 * 操作失敗即可。
 */
export class E2EKeyStoreLockTimeoutError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "E2EKeyStoreLockTimeoutError";
  }
}

/**
 * 同一 logical session 的三方 CAS 衝突：磁盤上的權威狀態既不是我的 base 也不是我的
 * desired，說明**我的內存快照過期了**。同樣不是持久化故障，不得 poison 實例；
 * 未涉及的其它 session 完全不受影響。
 */
export class E2EKeyStoreConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "E2EKeyStoreConflictError";
  }
}
const MAX_OWNER_BYTES = 2_048;
const OWNER_FILE = "owner.json";
const RECLAIM_FILE = "reclaim.json";
const waitCell = new Int32Array(new SharedArrayBuffer(4));

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

interface LockOwner {
  v: 1;
  pid: number;
  token: string;
  createdAtMs: number;
  processStart: string;
}

function sameOwner(a: LockOwner, b: LockOwner): boolean {
  return (
    a.v === b.v &&
    a.pid === b.pid &&
    a.token === b.token &&
    a.createdAtMs === b.createdAtMs &&
    a.processStart === b.processStart
  );
}

function processStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("[e2e] invalid keystore lock owner PID");
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) throw new Error("malformed /proc stat");
      const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      if (!/^[0-9]+$/.test(startTicks ?? "")) throw new Error("malformed /proc starttime");
      return `linux:${startTicks}`;
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ESRCH")) return null;
      throw new Error("[e2e] cannot read keystore lock owner process identity", { cause: error });
    }
  }
  if (process.platform === "darwin" || process.platform === "freebsd") {
    try {
      const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }).trim();
      return started ? `${process.platform}:${started}` : null;
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (status === 1) return null;
      throw new Error("[e2e] cannot read keystore lock owner process identity", { cause: error });
    }
  }
  throw new Error(`[e2e] unsupported platform for crash-safe keystore lock: ${process.platform}`);
}

let cachedSelfProcessStart: string | undefined;
function liveProcessStartIdentity(pid: number): string | null {
  if (pid !== process.pid) return processStartIdentity(pid);
  cachedSelfProcessStart ??= processStartIdentity(pid) ?? undefined;
  if (!cachedSelfProcessStart) throw new Error("[e2e] cannot determine current process identity");
  return cachedSelfProcessStart;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function parseOwner(raw: string, label: string): LockOwner {
  if (Buffer.byteLength(raw, "utf8") > MAX_OWNER_BYTES) throw new Error(`[e2e] ${label} is too large`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`[e2e] ${label} is invalid JSON`, { cause: error });
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !== "createdAtMs,pid,processStart,token,v"
  ) {
    throw new Error(`[e2e] ${label} has invalid shape`);
  }
  const owner = parsed as LockOwner;
  if (
    owner.v !== 1 ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    !Number.isSafeInteger(owner.createdAtMs) ||
    owner.createdAtMs < 0 ||
    typeof owner.token !== "string" ||
    !/^[0-9a-f]{48}$/.test(owner.token) ||
    typeof owner.processStart !== "string" ||
    !owner.processStart ||
    Buffer.byteLength(owner.processStart, "utf8") > 512
  ) {
    throw new Error(`[e2e] ${label} has invalid fields`);
  }
  return owner;
}

function ownerPath(lockDir: string, reclaim = false): string {
  return join(lockDir, reclaim ? RECLAIM_FILE : OWNER_FILE);
}

function readOwner(lockDir: string, reclaim = false): LockOwner {
  assertSafeLockDirectory(lockDir);
  const path = ownerPath(lockDir, reclaim);
  const before = lstatSync(path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size > MAX_OWNER_BYTES ||
    (before.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && before.uid !== process.getuid())
  ) {
    throw new Error("[e2e] unsafe keystore process lock owner");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile()) {
      throw new Error("[e2e] keystore process lock owner changed while opening");
    }
    return parseOwner(
      readFileSync(fd, "utf8"),
      reclaim ? "keystore process lock reclaimer" : "keystore process lock owner",
    );
  } finally {
    closeSync(fd);
  }
}

function writeOwner(lockDir: string, owner: LockOwner, reclaim = false): void {
  const path = ownerPath(lockDir, reclaim);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(owner), "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(lockDir);
}

function cleanupLockDirectory(lockDir: string): void {
  const names = readdirSync(lockDir).sort();
  if (names.some((name) => name !== OWNER_FILE && name !== RECLAIM_FILE)) {
    throw new Error("[e2e] keystore process lock contains unexpected entries");
  }
  for (const name of names) unlinkSync(join(lockDir, name));
  rmdirSync(lockDir);
}

/** 先完整落盘随机候选目录，再用一次 rename 发布 canonical 锁，杜绝 ownerless 崩溃锁。 */
function tryAcquireOwnedLock(lockDir: string, parent: string, owner: LockOwner): boolean {
  const candidate = `${lockDir}.acquire.${owner.token}`;
  mkdirSync(candidate, { mode: 0o700 });
  try {
    writeOwner(candidate, owner);
    try {
      renameSync(candidate, lockDir);
    } catch (error) {
      if (isErrno(error, "EEXIST") || isErrno(error, "ENOTEMPTY")) {
        cleanupLockDirectory(candidate);
        return false;
      }
      throw error;
    }
    fsyncDirectory(parent);
    return true;
  } catch (error) {
    try {
      cleanupLockDirectory(candidate);
    } catch {
      // rename 成功后 candidate 已不存在；否则随机半成品也不影响 canonical 锁。
    }
    throw error;
  }
}

function removeOwnedReclaimer(lockDir: string, owner: LockOwner): boolean {
  try {
    if (!sameOwner(readOwner(lockDir, true), owner)) return false;
    unlinkSync(ownerPath(lockDir, true));
    fsyncDirectory(lockDir);
    return true;
  } catch {
    return false;
  }
}

function assertSafeLockDirectory(path: string): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error(`[e2e] unsafe keystore process lock: ${path}`);
  }
}

/**
 * 跨进程互斥。崩溃锁仅在 owner PID 已消失或 PID 的启动身份不同（已复用）时原子回收；
 * live owner 最多等待 5 秒后响亮失败。所有 read-modify-write 都在锁内重读并做 per-session CAS。
 */
export function withE2EKeyStoreLock<T>(storePath: string, action: () => T): T {
  const parent = dirname(storePath);
  const lockDir = `${storePath}.lock`;
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const owner: LockOwner = {
    v: 1,
    pid: process.pid,
    token: randomBytes(24).toString("hex"),
    createdAtMs: Date.now(),
    processStart: liveProcessStartIdentity(process.pid)!,
  };
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  while (true) {
    if (tryAcquireOwnedLock(lockDir, parent, owner)) break;
    let current: LockOwner;
    try {
      current = readOwner(lockDir);
    } catch (error) {
      if (isErrno(error, "ENOENT") && Date.now() < deadline) {
        Atomics.wait(waitCell, 0, 0, WAIT_MS);
        continue;
      }
      throw error;
    }
    if (liveProcessStartIdentity(current.pid) === current.processStart) {
      if (Date.now() >= deadline) {
        throw new E2EKeyStoreLockTimeoutError(
          `[e2e] keystore process lock remained held for ${WAIT_TIMEOUT_MS}ms: ${lockDir}`,
        );
      }
      Atomics.wait(waitCell, 0, 0, WAIT_MS);
      continue;
    }
    const reclaimer: LockOwner = {
      v: 1,
      pid: process.pid,
      token: randomBytes(24).toString("hex"),
      createdAtMs: Date.now(),
      processStart: owner.processStart,
    };
    try {
      writeOwner(lockDir, reclaimer, true);
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      if (isErrno(error, "EEXIST")) {
        let abandoned: LockOwner;
        try {
          abandoned = readOwner(lockDir, true);
        } catch (readError) {
          if (isErrno(readError, "ENOENT")) continue;
          throw readError;
        }
        if (
          liveProcessStartIdentity(abandoned.pid) !== abandoned.processStart &&
          removeOwnedReclaimer(lockDir, abandoned)
        ) continue;
      }
      throw new Error("[e2e] keystore process lock is already being reclaimed", { cause: error });
    }
    let confirmed: LockOwner;
    try {
      confirmed = readOwner(lockDir);
    } catch (error) {
      removeOwnedReclaimer(lockDir, reclaimer);
      if (isErrno(error, "ENOENT")) continue;
      throw error;
    }
    if (!sameOwner(confirmed, current) || liveProcessStartIdentity(confirmed.pid) === confirmed.processStart) {
      removeOwnedReclaimer(lockDir, reclaimer);
      throw new Error("[e2e] stale keystore lock ownership could not be proven");
    }
    const reclaimed = `${lockDir}.stale.${reclaimer.token}`;
    try {
      renameSync(lockDir, reclaimed);
      fsyncDirectory(parent);
      cleanupLockDirectory(reclaimed);
      fsyncDirectory(parent);
    } catch (error) {
      removeOwnedReclaimer(lockDir, reclaimer);
      throw new Error("[e2e] failed to atomically reclaim stale keystore lock", { cause: error });
    }
  }

  try {
    return action();
  } finally {
    if (!sameOwner(readOwner(lockDir), owner)) {
      throw new Error("[e2e] keystore process lock ownership changed");
    }
    const released = `${lockDir}.released.${owner.token}`;
    renameSync(lockDir, released);
    fsyncDirectory(parent);
    cleanupLockDirectory(released);
    fsyncDirectory(parent);
  }
}

function snapshotRecord(raw: string): Record<string, string> {
  const value = JSON.parse(raw) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("[e2e] keystore CAS snapshot root must be an object");
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    if (typeof item !== "string") throw new Error("[e2e] keystore CAS snapshot value must be a string");
  }
  return value as Record<string, string>;
}

function sameEntries(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  return a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
}

/** 保留磁盘上的 unrelated session；同一 session 并发变化则 CAS 冲突并 fail-closed。 */
export function mergeE2EKeyStoreSnapshots(
  baseRaw: string,
  desiredRaw: string,
  diskRaw: string,
  logicalSessionId: (storedKey: string) => string,
): string {
  const base = snapshotRecord(baseRaw);
  const desired = snapshotRecord(desiredRaw);
  const disk = snapshotRecord(diskRaw);
  const group = (record: Record<string, string>): Map<string, Map<string, string>> => {
    const grouped = new Map<string, Map<string, string>>();
    for (const [storedKey, value] of Object.entries(record)) {
      const sid = logicalSessionId(storedKey);
      const entries = grouped.get(sid) ?? new Map<string, string>();
      entries.set(storedKey, value);
      grouped.set(sid, entries);
    }
    return grouped;
  };
  const baseGroups = group(base);
  const desiredGroups = group(desired);
  const diskGroups = group(disk);
  const empty = new Map<string, string>();

  for (const sid of new Set([...baseGroups.keys(), ...desiredGroups.keys()])) {
    const before = baseGroups.get(sid) ?? empty;
    const after = desiredGroups.get(sid) ?? empty;
    if (sameEntries(before, after)) continue;
    const current = diskGroups.get(sid) ?? empty;
    if (!sameEntries(current, before) && !sameEntries(current, after)) {
      throw new E2EKeyStoreConflictError(
        `[e2e] concurrent keystore state conflict for session ${JSON.stringify(sid)}`,
      );
    }
    for (const storedKey of Object.keys(disk)) {
      if (logicalSessionId(storedKey) === sid) delete disk[storedKey];
    }
    for (const [storedKey, value] of after) disk[storedKey] = value;
  }

  return JSON.stringify(
    Object.fromEntries(Object.entries(disk).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}
