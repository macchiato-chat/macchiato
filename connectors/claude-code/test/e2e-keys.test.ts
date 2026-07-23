import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  E2EKeyStore,
  E2EKeyStoreStateError,
  settleE2EBackfillAck,
} from "../src/e2e/keys";
import * as ec from "../src/e2e/crypto";
import {
  e2eControlKeyId,
  type E2EControlEnvelopeV1,
} from "../src/e2e/control";

type DiskSnapshot = Record<string, string>;

const encodedKey = (byte: number): string => Buffer.alloc(32, byte).toString("base64");

function disableIntent(
  sid: string,
  key: Buffer,
  msgId = "00000000-0000-4000-8000-000000000001",
): E2EControlEnvelopeV1 {
  return {
    v: 1,
    sessionId: `public-${sid}`,
    hermesSessionId: sid,
    deviceId: "device-A",
    keyId: e2eControlKeyId(key),
    msgId,
    seq: "1",
    issuedAtMs: "1",
    expiresAtMs: "2",
    kind: "session.e2e.disable",
    payloadB64: "e30=",
    mac: Buffer.alloc(32).toString("base64"),
  };
}

function completeDisableWithReceipt(store: E2EKeyStore, sid: string): void {
  const key = store.requireKey(sid);
  store.markServerE2E(sid, "disable");
  store.beginDisable(sid, disableIntent(sid, key));
  const receipt = store.disableReceiptForBackfill(sid);
  store.completeDisable(sid, receipt);
}

function writeRaw(path: string, raw: string, mode = 0o600): void {
  writeFileSync(path, raw, { mode });
  chmodSync(path, mode);
}

function readSnapshot(path: string): DiskSnapshot {
  return JSON.parse(readFileSync(path, "utf8")) as DiskSnapshot;
}

function expect0600(path: string): void {
  expect(statSync(path).mode & 0o777).toBe(0o600);
}

function tempArtifacts(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

describe("E2EKeyStore（fail-closed 持鑰/封裝/加解密/持久化）", () => {
  let dir: string;
  let path: string;
  let backup: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-e2e-"));
    path = join(dir, "e2e.json");
    backup = path + ".bak";
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("只有 main + .bak 都 ENOENT 才視為全新安裝", () => {
    const store = new E2EKeyStore(path);
    expect(store.isE2E("missing")).toBe(false);
    expect(store.hasServerStateSnapshot()).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(backup)).toBe(false);
    expect(store.applyServerState({ version: 1, sessions: [], disabledReceipts: [] })).toEqual([]);
    expect(store.hasServerStateSnapshot()).toBe(true);
  });

  it.each([
    ["main", false],
    [".bak", true],
  ])("任一候選是非 ENOENT I/O 錯誤就不冒充全新安裝（%s）", (_label, useBackup) => {
    mkdirSync(useBackup ? backup : path);
    expect(() => new E2EKeyStore(path)).toThrow(/fail-closed/);
  });

  it("createForEnable 是顯式建鑰入口；兼容 alias 返回同一把", () => {
    const store = new E2EKeyStore(path);
    const key = store.createForEnable("d1");
    expect(key).toHaveLength(32);
    expect(store.isE2E("d1")).toBe(true);
    expect(store.createForEnable("d1").equals(key)).toBe(true);
    expect(store.getOrCreateKey("d1").equals(key)).toBe(true);
    expect(readSnapshot(path)).toEqual(readSnapshot(backup));
  });

  it("#347 ready 快照形成 server-positive floor；本地 key 必须与完整 server 快照一一对账", () => {
    const store = new E2EKeyStore(path);
    store.createForEnable("enabled");

    expect(
      store.applyServerState({
        version: 1,
        disabledReceipts: [],
        sessions: [{ hermesSessionId: "enabled", pendingOp: null }],
      }),
    ).toEqual([]);
    expect(store.isE2E("enabled")).toBe(true);

    // omission 可能是 disable 已提交但 ACK 丢失；保留孤儿 K_S quarantine，绝不自动删/降明文。
    expect(store.applyServerState({ version: 1, sessions: [], disabledReceipts: [] })).toEqual(["enabled"]);
    expect(store.isE2E("enabled")).toBe(true);
    expect(store.hasKey("enabled")).toBe(true);
    expect(() => store.requireKey("enabled")).toThrow(/quarantine/);
  });

  it("server-positive floor 跨连续 ready omission 与进程重启都保持 fail-closed", () => {
    const store = new E2EKeyStore(path);
    expect(
      store.applyServerState({
        version: 1,
        disabledReceipts: [],
        sessions: [{ hermesSessionId: "remote-only", pendingOp: null }],
      }),
    ).toEqual(["remote-only"]);
    expect(store.applyServerState({ version: 1, sessions: [], disabledReceipts: [] })).toEqual(["remote-only"]);
    expect(store.isE2E("remote-only")).toBe(true);

    const restarted = new E2EKeyStore(path);
    expect(restarted.isE2E("remote-only")).toBe(true);
    expect(restarted.applyServerState({ version: 1, sessions: [], disabledReceipts: [] })).toEqual([
      "remote-only",
    ]);
  });

  it("#347 首次 ready 发现本地孤儿 K_S 时按 session quarantine，不拖垮其它会话", () => {
    const store = new E2EKeyStore(path);
    store.createForEnable("local-only");
    expect(store.applyServerState({ version: 1, sessions: [], disabledReceipts: [] })).toEqual(["local-only"]);
    expect(store.hasKey("local-only")).toBe(true);
    expect(store.isE2E("local-only")).toBe(true);
    expect(() => store.requireKey("local-only")).toThrow(/quarantine/);
  });

  it("#347 pending-enable 缺 key 可进入保护态并返回 sid；只有该状态允许显式建钥", () => {
    const store = new E2EKeyStore(path);
    expect(
      store.applyServerState({
        version: 1,
        disabledReceipts: [],
        sessions: [{ hermesSessionId: "pending", pendingOp: "enable" }],
      }),
    ).toEqual(["pending"]);
    expect(store.isE2E("pending")).toBe(true);
    expect(store.hasKey("pending")).toBe(false);
    expect(() => store.encryptText("pending", "must not leak")).toThrow(/no E2E key/);
    expect(() => store.createForEnable("not-pending")).toThrow(/并非 server pending-enable/);

    store.createForEnable("pending");
    expect(store.hasKey("pending")).toBe(true);
    store.markEnableComplete("pending");
    expect(store.isE2E("pending")).toBe(true);
  });

  it.each([
    ["enabled", null],
    ["pending-disable", "disable"],
  ] as const)("#347 server %s 缺本地 key 时 fail closed", (sid, pendingOp) => {
    const store = new E2EKeyStore(path);
    expect(
      store.applyServerState({
        version: 1,
        disabledReceipts: [],
        sessions: [{ hermesSessionId: sid, pendingOp }],
      }),
    ).toEqual([sid]);
    expect(store.isE2E(sid)).toBe(true);
    expect(store.hasKey(sid)).toBe(false);
    expect(() => store.encryptText(sid, "blocked")).toThrow(/no E2E key/);
  });

  it.each([
    [undefined],
    [null],
    [{}],
    [{ version: 2, sessions: [] }],
    [{ version: 1, sessions: "bad" }],
    [{ version: 1, sessions: [{ hermesSessionId: "", pendingOp: null }] }],
    [{ version: 1, sessions: [{ hermesSessionId: "s", pendingOp: "other" }] }],
    [
      {
        version: 1,
        disabledReceipts: [],
        sessions: [
          { hermesSessionId: "s", pendingOp: "enable" },
          { hermesSessionId: "s", pendingOp: "enable" },
        ],
      },
    ],
  ])("#347 非法 ready e2eState 拒绝：%j", (raw) => {
    const store = new E2EKeyStore(path);
    expect(() => store.applyServerState(raw)).toThrow(/fail-closed/);
  });

  it("#347 普通新设备补封只沿用既有 K_S，缺 key 不得隐式生成 K₂", () => {
    const store = new E2EKeyStore(path);
    const dev = ec.genDeviceKeypair();
    store.markServerE2E("pending", "enable");
    const first = store.wrapForEnable("pending", [{ deviceId: "A", pubKey: dev.pubB64 }]);
    const key = store.requireKey("pending");
    store.markEnableComplete("pending");
    const again = store.wrapExistingForDevices("pending", [{ deviceId: "A", pubKey: dev.pubB64 }]);
    expect(ec.unwrapKey(first[0].sealed, dev.priv).equals(key)).toBe(true);
    expect(ec.unwrapKey(again[0].sealed, dev.priv).equals(key)).toBe(true);

    expect(() => store.wrapExistingForDevices("missing", [{ deviceId: "A", pubKey: dev.pubB64 }])).toThrow(
      /no E2E key/,
    );
    expect(store.hasKey("missing")).toBe(false);
  });

  it("#347 disable 只有 completeDisable(ACK) 才撤 server floor 并持久删 key", () => {
    const store = new E2EKeyStore(path);
    store.createForEnable("d1");
    store.applyServerState({
      version: 1,
      disabledReceipts: [],
      sessions: [{ hermesSessionId: "d1", pendingOp: "disable" }],
    });
    const intent = disableIntent("d1", store.requireKey("d1"));
    store.beginDisable("d1", intent);
    expect(store.isE2E("d1")).toBe(true);
    expect(store.hasKey("d1")).toBe(true);
    expect(store.hasPendingDisable("d1")).toBe(true);

    const receipt = store.disableReceiptForBackfill("d1");
    store.completeDisable("d1", receipt);
    expect(store.isE2E("d1")).toBe(false);
    expect(store.hasKey("d1")).toBe(false);
    expect(store.hasPendingDisable("d1")).toBe(false);
    expect(readSnapshot(path)).toEqual({});
    expect(readSnapshot(backup)).toEqual({});
  });

  it("#347 pending-disable intent 兼容旧 flat reader，并在 ACK 丢失后由 ready omission 原子收敛", () => {
    const store = new E2EKeyStore(path);
    const key = store.createForEnable("d1");
    const retainedKey = store.createForEnable("retained");
    store.markServerE2E("d1", "disable");
    store.beginDisable("d1", disableIntent("d1", key));

    const legacySnapshot = readSnapshot(path);
    const legacyKeys = new Map(
      Object.entries(legacySnapshot).flatMap(([sid, encoded]) => {
        const decoded = Buffer.from(encoded, "base64");
        if (decoded.length !== 32 || decoded.toString("base64") !== encoded) return [];
        return [[sid, decoded] as const];
      }),
    );
    expect(legacyKeys.get("d1")?.equals(key)).toBe(true);
    expect(legacyKeys.get("retained")?.equals(retainedKey)).toBe(true);
    expect(legacyKeys.size).toBeGreaterThanOrEqual(3);
    expect(readSnapshot(backup)).toEqual(legacySnapshot);

    const restarted = new E2EKeyStore(path);
    expect(restarted.hasPendingDisable("d1")).toBe(true);
    const receipt = restarted.disableReceiptForBackfill("d1");
    expect(
      restarted.applyServerState({
        version: 1,
        sessions: [{ hermesSessionId: "retained", pendingOp: null }],
        disabledReceipts: [receipt],
      }),
    ).toEqual([]);
    expect(restarted.hasPendingDisable("d1")).toBe(false);
    expect(restarted.hasKey("d1")).toBe(false);
    expect(restarted.isE2E("d1")).toBe(false);
    expect(restarted.requireKey("retained").equals(retainedKey)).toBe(true);
    expect(readSnapshot(path).retained).toBe(retainedKey.toString("base64"));
    expect(readSnapshot(path).d1).toBeUndefined();
    expect(readSnapshot(backup)).toEqual(readSnapshot(path));
  });

  it("旧 K1 的 pending-disable 遇 pending-enable：无 R1 拒绝，有 matching R1 才删 K1 后生成 K2", () => {
    const store = new E2EKeyStore(path);
    const k1 = store.createForEnable("d1");
    store.markServerE2E("d1", "disable");
    store.beginDisable("d1", disableIntent("d1", k1));
    expect(() =>
      store.applyServerState({
        version: 1,
        sessions: [{ hermesSessionId: "d1", pendingOp: "enable" }],
        disabledReceipts: [],
      }),
    ).toThrow(/拒绝复用旧 K_S/);
    expect(store.requireKey("d1").equals(k1)).toBe(true);

    const receipt = store.disableReceiptForBackfill("d1");
    expect(
      store.applyServerState({
        version: 1,
        sessions: [{ hermesSessionId: "d1", pendingOp: "enable" }],
        disabledReceipts: [receipt],
      }),
    ).toEqual(["d1"]);
    expect(store.hasKey("d1")).toBe(false);
    expect(store.isE2E("d1")).toBe(true);
    const k2 = store.createForEnable("d1");
    expect(k2.equals(k1)).toBe(false);
  });

  it("同连接 disable ACK 丢失后立即 re-enable：live R1 先退休 K1，缺失/篡改 R1 均 fail closed", () => {
    const store = new E2EKeyStore(path);
    const k1 = store.createForEnable("d1");
    store.markServerE2E("d1", "disable");
    store.beginDisable("d1", disableIntent("d1", k1));
    const receipt = store.disableReceiptForBackfill("d1");

    expect(() => store.beginEnable("d1")).toThrow(/completion receipt/);
    expect(() => store.createForEnable("d1")).toThrow(/pending-disable/);
    expect(() =>
      store.beginEnable("d1", { ...receipt, mac: Buffer.alloc(32, 7).toString("base64") }),
    ).toThrow();
    expect(store.requireKey("d1").equals(k1)).toBe(true);

    store.beginEnable("d1", receipt);
    expect(store.hasKey("d1")).toBe(false);
    expect(store.hasPendingDisable("d1")).toBe(false);
    expect(store.isE2E("d1")).toBe(true);
    const k2 = store.createForEnable("d1");
    expect(k2.equals(k1)).toBe(false);
  });

  it("#347 server 仍列 E2E stable 时只撤 stale disable intent；新 pending-enable 可解除 quarantine", () => {
    const store = new E2EKeyStore(path);
    const key = store.createForEnable("d1");
    store.markServerE2E("d1", "disable");
    store.beginDisable("d1", disableIntent("d1", key));

    const restarted = new E2EKeyStore(path);
    expect(
      restarted.applyServerState({
        version: 1,
        disabledReceipts: [],
        sessions: [{ hermesSessionId: "d1", pendingOp: null }],
      }),
    ).toEqual([]);
    expect(restarted.hasPendingDisable("d1")).toBe(true);
    expect(restarted.requireKey("d1").equals(key)).toBe(true);
    restarted.cancelDisableBeforeRelease("d1");
    expect(restarted.hasPendingDisable("d1")).toBe(false);

    expect(restarted.applyServerState({ version: 1, sessions: [], disabledReceipts: [] })).toEqual(["d1"]);
    expect(() => restarted.requireKey("d1")).toThrow(/quarantine/);
    restarted.markServerE2E("d1", "enable");
    restarted.wrapForEnable("d1", []);
    expect(restarted.requireKey("d1").equals(key)).toBe(true);
  });

  it("#347 迟到 ACK 不得结算已切到另一方向的新转换", () => {
    const store = new E2EKeyStore(path);
    store.createForEnable("d1");
    store.applyServerState({
      version: 1,
      disabledReceipts: [],
      sessions: [{ hermesSessionId: "d1", pendingOp: "disable" }],
    });
    store.markServerE2E("d1", "enable");
    expect(() => store.completeDisable("d1", {})).toThrow(/stale disable receipt/);
    expect(store.hasKey("d1")).toBe(true);

    store.markServerE2E("d1", "disable");
    expect(() => store.markEnableComplete("d1")).toThrow(/stale enable ACK/);
    expect(store.hasKey("d1")).toBe(true);
  });

  it("#347 缺钥 disable ACK 不得 remove no-op 后撤掉 protection floor", () => {
    const missing = new E2EKeyStore(join(dir, "missing.json"));
    expect(() => missing.markServerE2E("missing", "disable")).toThrow(/缺少本地 K_S/);
    expect(() => missing.completeDisable("missing", {})).toThrow(/stale disable receipt/);
    expect(missing.isE2E("missing")).toBe(true);
  });

  it("encrypt* 只准使用既有 key，绝不因加密调用隐式开启 E2E", () => {
    const store = new E2EKeyStore(path);
    expect(() => store.encryptContent("d1", { text: "secret" })).toThrow(/no E2E key/);
    expect(() => store.encryptText("d1", "secret")).toThrow(/no E2E key/);
    expect(store.isE2E("d1")).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(backup)).toBe(false);

    store.createForEnable("d1");
    const obj = { text: "祕密", reasoning: "想" };
    expect(store.decryptContent("d1", store.encryptContent("d1", obj))).toEqual(obj);
    expect(store.decryptText("d1", store.encryptText("d1", "hi"))).toBe("hi");
    expect(() => store.decryptText("nope", "x")).toThrow(/no E2E key/);
  });

  it("封裝给两台设备会显式建钥；坏公钥跳过", () => {
    const store = new E2EKeyStore(path);
    const a = ec.genDeviceKeypair();
    const b = ec.genDeviceKeypair();
    const wrapped = store.wrapForDevices("d1", [
      { deviceId: "A", pubKey: a.pubB64 },
      { deviceId: "B", pubKey: b.pubB64 },
      { deviceId: "C", pubKey: "!!bad" },
    ]);
    expect(wrapped.map((item) => item.deviceId)).toEqual(["A", "B"]);
    const key = store.getOrCreateKey("d1");
    expect(ec.unwrapKey(wrapped[0].sealed, a.priv).equals(key)).toBe(true);
    expect(ec.unwrapKey(wrapped[1].sealed, b.priv).equals(key)).toBe(true);
  });

  it("每次成功写都让 main 与 .bak 同为最新快照、同为 0600", () => {
    const store = new E2EKeyStore(path);
    const d1 = store.createForEnable("d1");
    expect(readSnapshot(path)).toEqual({ d1: d1.toString("base64") });
    expect(readSnapshot(backup)).toEqual(readSnapshot(path));

    const d2 = store.createForEnable("d2");
    expect(readSnapshot(path)).toEqual({
      d1: d1.toString("base64"),
      d2: d2.toString("base64"),
    });
    expect(readSnapshot(backup)).toEqual(readSnapshot(path));

    completeDisableWithReceipt(store, "d1");
    expect(readSnapshot(path)).toEqual({ d2: d2.toString("base64") });
    expect(readSnapshot(backup)).toEqual(readSnapshot(path));
    expect0600(path);
    expect0600(backup);
    expect(tempArtifacts(dir)).toEqual([]);
  });

  it("两实例交错写按 session CAS 合并，不覆盖另一进程新增的 floor/K2", () => {
    const staleA = new E2EKeyStore(path);
    const writerB = new E2EKeyStore(path);
    writerB.markServerE2E("b", "enable");
    const k2 = writerB.createForEnable("b");

    staleA.createForEnable("a");
    const final = new E2EKeyStore(path);
    expect(final.hasKey("a")).toBe(true);
    expect(final.isE2E("b")).toBe(true);
    expect(final.requireKey("b").equals(k2)).toBe(true);
  });

  it("重载保留同一把 key，并把过宽权限原子修回 0600", () => {
    const first = new E2EKeyStore(path);
    const key = first.createForEnable("d1");
    chmodSync(path, 0o644);
    chmodSync(backup, 0o644);

    const reloaded = new E2EKeyStore(path);
    expect(reloaded.getOrCreateKey("d1").equals(key)).toBe(true);
    expect0600(path);
    expect0600(backup);
  });

  it("main 损坏时从最新 .bak 恢复，receipt 删掉的 key 不会复活", () => {
    const first = new E2EKeyStore(path);
    first.createForEnable("removed");
    const kept = first.createForEnable("kept");
    completeDisableWithReceipt(first, "removed");
    expect(readSnapshot(backup)).toEqual({ kept: kept.toString("base64") });

    writeRaw(path, "{broken json");
    const recovered = new E2EKeyStore(path);
    expect(recovered.isE2E("removed")).toBe(false);
    expect(recovered.getOrCreateKey("kept").equals(kept)).toBe(true);
    expect(readSnapshot(path)).toEqual(readSnapshot(backup));
    expect0600(path);
    expect0600(backup);
  });

  it("main 缺失但 .bak 合法时恢复并重建 main", () => {
    const first = new E2EKeyStore(path);
    const key = first.createForEnable("d1");
    unlinkSync(path);

    const recovered = new E2EKeyStore(path);
    expect(recovered.getOrCreateKey("d1").equals(key)).toBe(true);
    expect(readSnapshot(path)).toEqual(readSnapshot(backup));
  });

  it("main 合法时它是权威快照，会修复缺失、损坏或旧版 .bak", () => {
    const key = encodedKey(7);
    writeRaw(path, JSON.stringify({ d1: key }));
    writeRaw(backup, JSON.stringify({ stale: encodedKey(8) }));

    const recovered = new E2EKeyStore(path);
    expect(recovered.isE2E("d1")).toBe(true);
    expect(recovered.isE2E("stale")).toBe(false);
    expect(readSnapshot(path)).toEqual({ d1: key });
    expect(readSnapshot(backup)).toEqual({ d1: key });

    unlinkSync(backup);
    const repairedAgain = new E2EKeyStore(path);
    expect(repairedAgain.isE2E("d1")).toBe(true);
    expect(readSnapshot(backup)).toEqual({ d1: key });

    writeRaw(backup, "{broken");
    const repairedCorrupt = new E2EKeyStore(path);
    expect(repairedCorrupt.isE2E("d1")).toBe(true);
    expect(readSnapshot(backup)).toEqual({ d1: key });
  });

  it("合法空对象是明确的空快照，不从旧 .bak 复活 key", () => {
    writeRaw(path, "{}");
    writeRaw(backup, JSON.stringify({ stale: encodedKey(9) }));
    const store = new E2EKeyStore(path);
    expect(store.isE2E("stale")).toBe(false);
    expect(readSnapshot(path)).toEqual({});
    expect(readSnapshot(backup)).toEqual({});
  });

  it("main 与 .bak 都坏时响亮拒启，错误明确说明明文风险", () => {
    writeRaw(path, "{broken");
    writeRaw(backup, "also broken");
    expect(() => new E2EKeyStore(path)).toThrow(/refusing to start \(fail-closed\)/);
    expect(() => new E2EKeyStore(path)).toThrow(/plaintext/);
  });

  it.each([
    ["invalid JSON", "{"],
    ["null root", "null"],
    ["array root", "[]"],
    ["non-string value", JSON.stringify({ d1: 123 })],
    ["empty session id", JSON.stringify({ "": encodedKey(1) })],
    ["31-byte key", JSON.stringify({ d1: Buffer.alloc(31, 1).toString("base64") })],
    ["33-byte key", JSON.stringify({ d1: Buffer.alloc(33, 1).toString("base64") })],
    ["unpadded base64 that Node could decode", JSON.stringify({ d1: encodedKey(1).slice(0, -1) })],
    ["base64 with ignored whitespace", JSON.stringify({ d1: encodedKey(1) + "\n" })],
  ])("候选格式严格校验：%s", (_label, raw) => {
    writeRaw(path, raw);
    expect(() => new E2EKeyStore(path)).toThrow(/fail-closed/);
    expect(existsSync(backup)).toBe(false);
  });

  it("两份文件不可读时 fail-closed，不把权限错误当 ENOENT", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    writeRaw(path, JSON.stringify({ d1: encodedKey(1) }), 0o000);
    writeRaw(backup, JSON.stringify({ d1: encodedKey(1) }), 0o000);
    expect(() => new E2EKeyStore(path)).toThrow(/fail-closed/);
  });

  it("main 写失败采用 copy-on-write，清理唯一 tmp，并永久 poison 当前实例", () => {
    const store = new E2EKeyStore(path);
    mkdirSync(path); // atomic rename(file → existing directory) 确定性失败

    expect(() => store.createForEnable("d1")).toThrow(/poisoned/);
    const internal = (store as unknown as { keys: Map<string, Buffer> }).keys;
    expect(internal.has("d1")).toBe(false);
    expect(() => store.isE2E("d1")).toThrow(/poisoned/);
    expect(() => store.encryptText("d1", "must not continue")).toThrow(/poisoned/);
    expect(tempArtifacts(dir)).toEqual([]);
  });

  it(".bak 写失败后内存不提交且实例 poison；重启以已落 main 修复，不复活 receipt 已删 key", () => {
    const store = new E2EKeyStore(path);
    const removedKey = store.createForEnable("removed");
    store.createForEnable("kept");
    store.markServerE2E("removed", "disable");
    store.beginDisable("removed", disableIntent("removed", removedKey));
    const receipt = store.disableReceiptForBackfill("removed");
    rmSync(backup);
    mkdirSync(backup); // main 可成功，第二个 atomic rename 确定性失败

    expect(() => store.completeDisable("removed", receipt)).toThrow(/poisoned/);
    const internal = (store as unknown as { keys: Map<string, Buffer> }).keys;
    expect(internal.has("removed")).toBe(true); // copy-on-write：失败提交不换当前 map
    expect(readSnapshot(path).removed).toBeUndefined(); // main 已是最新，重启以它为权威
    expect(() => store.completeDisable("removed", receipt)).toThrow(/poisoned/);
    expect(tempArtifacts(dir)).toEqual([]);

    rmSync(backup, { recursive: true });
    const restarted = new E2EKeyStore(path);
    expect(restarted.isE2E("removed")).toBe(false);
    expect(restarted.isE2E("kept")).toBe(true);
    expect(readSnapshot(path)).toEqual(readSnapshot(backup));
  });
});

describe("#347 backfill ACK error boundary", () => {
  it("只吞 StateError，持久化/poison 等非 StateError 原样重抛", () => {
    expect(
      settleE2EBackfillAck(
        {
          markEnableComplete: () => {
            throw new E2EKeyStoreStateError("stale");
          },
          completeDisable: () => {},
        },
        "sid",
        "enable",
      ),
    ).toBe(false);
    const persistence = new Error("keystore persistence failed");
    expect(() =>
      settleE2EBackfillAck(
        {
          markEnableComplete: () => {},
          completeDisable: () => {
            throw persistence;
          },
        },
        "sid",
        "disable",
      ),
    ).toThrow(persistence);
  });
});
