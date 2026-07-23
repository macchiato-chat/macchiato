import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const WAIT_MS = 10;
const WAIT_TIMEOUT_MS = 5_000;
const waitCell = new Int32Array(new SharedArrayBuffer(4));

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
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
 * 跨进程互斥。锁持有者崩溃时宁可响亮失败等待人工清理，也不猜测/抢占可能仍在使用的锁。
 * 所有 keystore read-modify-write 都必须在这个边界内重读磁盘并做 per-session CAS。
 */
export function withE2EKeyStoreLock<T>(storePath: string, action: () => T): T {
  const parent = dirname(storePath);
  const lockDir = `${storePath}.lock`;
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString("hex");
  const owner = JSON.stringify({ pid: process.pid, token });
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  while (true) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      break;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      try {
        assertSafeLockDirectory(lockDir);
      } catch (inspectionError) {
        if (isErrno(inspectionError, "ENOENT")) continue;
        throw inspectionError;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `[e2e] keystore process lock remained held for ${WAIT_TIMEOUT_MS}ms: ${lockDir}; ` +
            "refusing unsafe stale-lock reclamation",
        );
      }
      Atomics.wait(waitCell, 0, 0, WAIT_MS);
    }
  }

  const ownerPath = join(lockDir, "owner.json");
  let ownerCreated = false;
  try {
    const fd = openSync(
      ownerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, owner, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    ownerCreated = true;
    fsyncDirectory(lockDir);
    fsyncDirectory(parent);
  } catch (error) {
    if (ownerCreated) {
      try {
        unlinkSync(ownerPath);
      } catch {
        // Preserve the lock-creation error.
      }
    }
    try {
      rmdirSync(lockDir);
    } catch {
      // A leftover lock fails closed on the next attempt.
    }
    throw error;
  }

  try {
    return action();
  } finally {
    assertSafeLockDirectory(lockDir);
    if (readFileSync(ownerPath, "utf8") !== owner) {
      throw new Error("[e2e] keystore process lock ownership changed");
    }
    const released = `${lockDir}.released.${token}`;
    renameSync(lockDir, released);
    fsyncDirectory(parent);
    unlinkSync(join(released, "owner.json"));
    rmdirSync(released);
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
      throw new Error(`[e2e] concurrent keystore state conflict for session ${JSON.stringify(sid)}`);
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
