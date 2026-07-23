import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  E2EKeyStore,
  E2EKeyStoreError,
  E2EKeyStoreStateError,
  settleE2EBackfillAck,
} from "../src/e2e/keys";
import * as ec from "../src/e2e/crypto";
import { e2eControlKeyId, type E2EControlEnvelopeV1 } from "../src/e2e/control";

function disableIntent(sid: string, key: Buffer): E2EControlEnvelopeV1 {
  return {
    v: 1,
    sessionId: `public-${sid}`,
    hermesSessionId: sid,
    deviceId: "device-A",
    keyId: e2eControlKeyId(key),
    msgId: "00000000-0000-4000-8000-000000000001",
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

function keyB64(byte = 1): string {
  return Buffer.alloc(32, byte).toString("base64");
}

describe("E2EKeyStore（持鑰/封裝/加解密/持久化）", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "occ-e2e-"));
    path = join(dir, "e2e.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("開啟 + isE2E + 同會話同一把", () => {
    const s = new E2EKeyStore(path);
    expect(s.isE2E("d1")).toBe(false);
    const k = s.getOrCreateKey("d1");
    expect(k.length).toBe(32);
    expect(s.isE2E("d1")).toBe(true);
    expect(s.getOrCreateKey("d1").equals(k)).toBe(true);
  });

  it("封裝給兩台設備 → 各自解出同一把 K_S；壞公鑰跳過", () => {
    const s = new E2EKeyStore(path);
    const a = ec.genDeviceKeypair();
    const b = ec.genDeviceKeypair();
    const wrapped = s.wrapForDevices("d1", [
      { deviceId: "A", pubKey: a.pubB64 },
      { deviceId: "B", pubKey: b.pubB64 },
      { deviceId: "C", pubKey: "!!bad" },
    ]);
    expect(wrapped.map((w) => w.deviceId)).toEqual(["A", "B"]);
    const k = s.getOrCreateKey("d1");
    expect(ec.unwrapKey(wrapped[0].sealed, a.priv).equals(k)).toBe(true);
    expect(ec.unwrapKey(wrapped[1].sealed, b.priv).equals(k)).toBe(true);
  });

  it("內容/文本往返 + 無鑰報錯", () => {
    const s = new E2EKeyStore(path);
    const obj = { text: "祕密", reasoning: "想" };
    expect(() => s.encryptText("d1", "hi")).toThrow(/缺少本地 K_S/);
    s.createForEnable("d1");
    expect(s.decryptContent("d1", s.encryptContent("d1", obj))).toEqual(obj);
    expect(s.decryptText("d1", s.encryptText("d1", "hi"))).toBe("hi");
    expect(() => s.decryptText("nope", "x")).toThrow();
  });

  it("持久化 0600 + 重載同鑰", () => {
    const s = new E2EKeyStore(path);
    const k = s.getOrCreateKey("d1");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}.bak`).mode & 0o777).toBe(0o600);
    const s2 = new E2EKeyStore(path);
    expect(s2.isE2E("d1")).toBe(true);
    expect(s2.getOrCreateKey("d1").equals(k)).toBe(true);
  });

  it("主檔損壞或 rename 窗口缺失時從完整校驗的 backup 恢復並重建主檔", () => {
    const s = new E2EKeyStore(path);
    const key = s.createForEnable("d1");

    writeFileSync(path, "{\"d1\":");
    const restored = new E2EKeyStore(path);
    expect(restored.requireKey("d1").equals(key)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).d1).toBe(key.toString("base64"));

    unlinkSync(path);
    const restoredAgain = new E2EKeyStore(path);
    expect(restoredAgain.requireKey("d1").equals(key)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).d1).toBe(key.toString("base64"));
  });

  it("backup 永遠是最新完整快照，恢復不漏新 key、receipt 刪除後也不復活舊 key", () => {
    const s = new E2EKeyStore(path);
    s.createForEnable("d1");
    const d2 = s.createForEnable("d2");
    completeDisableWithReceipt(s, "d1");

    writeFileSync(path, "broken");
    const restored = new E2EKeyStore(path);
    expect(restored.isE2E("d1")).toBe(false);
    expect(restored.requireKey("d2").equals(d2)).toBe(true);
  });

  it("主檔有效時會修復缺失、損壞或過期的 backup", () => {
    const s = new E2EKeyStore(path);
    const key = s.createForEnable("d1");
    writeFileSync(`${path}.bak`, JSON.stringify({ stale: keyB64(9) }));

    const reloaded = new E2EKeyStore(path);
    expect(reloaded.requireKey("d1").equals(key)).toBe(true);
    expect(JSON.parse(readFileSync(`${path}.bak`, "utf8"))).toEqual({ d1: key.toString("base64") });
  });

  it.each([
    ["截斷 JSON", "{\"d1\":"],
    ["null", "null"],
    ["array", "[]"],
    ["非 string value", JSON.stringify({ d1: 7 })],
    ["非法 base64", JSON.stringify({ d1: "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" })],
    ["非 canonical base64", JSON.stringify({ d1: keyB64().replace(/=$/, "") })],
    ["錯誤 key 長度", JSON.stringify({ d1: Buffer.alloc(31).toString("base64") })],
  ])("%s 且無有效 backup 時拒絕啟動", (_name, raw) => {
    writeFileSync(path, raw);
    expect(() => new E2EKeyStore(path)).toThrow(/fail-closed/);
  });

  it("主檔與 backup 都損壞時拒絕啟動並給可操作錯誤", () => {
    writeFileSync(path, "{");
    writeFileSync(`${path}.bak`, JSON.stringify({ d1: "bad" }));
    expect(() => new E2EKeyStore(path)).toThrow(/拒絕啟動.*fail-closed.*恢復/s);
  });

  it("非 ENOENT 的讀取錯誤不能當首次初始化", () => {
    if (process.platform === "win32") return;
    writeFileSync(path, JSON.stringify({ d1: keyB64() }), { mode: 0o600 });
    chmodSync(path, 0o000);
    try {
      expect(() => new E2EKeyStore(path)).toThrow(/fail-closed/);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("持久化失敗後 copy-on-write 不提前改內存，且整個 store poison", () => {
    if (process.platform === "win32") return;
    const s = new E2EKeyStore(path);
    s.createForEnable("d1");
    chmodSync(dir, 0o500);
    try {
      expect(() => s.createForEnable("d2")).toThrow(/fail-closed/);
      expect(() => s.isE2E("d1")).toThrow(/fail-closed/);
    } finally {
      chmodSync(dir, 0o700);
    }
    const reloaded = new E2EKeyStore(path);
    expect(reloaded.isE2E("d1")).toBe(true);
    expect(reloaded.isE2E("d2")).toBe(false);
  });

  it("ready 快照把 server E2E 与本地持钥分开：缺钥 session 隔离，其他会话仍可 ready", () => {
    const missing = new E2EKeyStore(path);
    expect(
      missing.applyServerState({
        version: 1,
        disabledReceipts: [],
        sessions: [{ hermesSessionId: "enabled", pendingOp: null }],
      }),
    ).toEqual(["enabled"]);
    expect(missing.isE2E("enabled")).toBe(true);
    expect(() => missing.encryptText("enabled", "blocked")).toThrow(/缺少本地 K_S/);

    const pending = new E2EKeyStore(join(dir, "pending.json"));
    expect(
      pending.applyServerState({
        version: 1,
        disabledReceipts: [],
        sessions: [{ hermesSessionId: "enabling", pendingOp: "enable" }],
      }),
    ).toEqual(["enabling"]);
    expect(pending.isE2E("enabling")).toBe(true);
    expect(pending.hasKey("enabling")).toBe(false);
    expect(() => pending.encryptText("enabling", "secret")).toThrow(/缺少本地 K_S/);
    pending.createForEnable("enabling");
    expect(pending.encryptText("enabling", "secret")).toBeTypeOf("string");
  });

  it("server-positive floor 跨连续 ready omission 与进程重启保持 fail-closed", () => {
    const s = new E2EKeyStore(path);
    expect(
      s.applyServerState({
        version: 1,
        disabledReceipts: [],
        sessions: [{ hermesSessionId: "remote-only", pendingOp: null }],
      }),
    ).toEqual(["remote-only"]);
    expect(s.applyServerState({ version: 1, sessions: [], disabledReceipts: [] })).toEqual(["remote-only"]);
    const restarted = new E2EKeyStore(path);
    expect(restarted.isE2E("remote-only")).toBe(true);
    expect(restarted.applyServerState({ version: 1, sessions: [], disabledReceipts: [] })).toEqual([
      "remote-only",
    ]);
    expect(() => restarted.applyServerState({ version: 1, sessions: [] })).toThrow(/disabledReceipts/);
  });

  it("server 快照遗漏本地 key 时保留 quarantine floor；新设备补封缺 key 也不生成 K₂", () => {
    const s = new E2EKeyStore(path);
    s.createForEnable("local-only");
    expect(s.applyServerState({ version: 1, sessions: [], disabledReceipts: [] })).toEqual(["local-only"]);
    expect(s.isE2E("local-only")).toBe(true);
    expect(s.hasKey("local-only")).toBe(true);
    expect(() => s.requireKey("local-only")).toThrow(/quarantine/);

    s.markServerE2E("missing", "enable");
    expect(() => s.wrapExistingForDevices("missing", [])).toThrow(/缺少本地 K_S/);
    expect(s.hasKey("missing")).toBe(false);
  });

  it("#347 pending-disable intent 保持旧 flat reader 可读，ACK 丢失后按 ready omission 原子删钥", () => {
    const s = new E2EKeyStore(path);
    const key = s.createForEnable("d1");
    const retainedKey = s.createForEnable("retained");
    s.markServerE2E("d1", "disable");
    s.beginDisable("d1", disableIntent("d1", key));

    const legacySnapshot = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    const legacyKeys = new Map(
      Object.entries(legacySnapshot).flatMap(([sid, encoded]) => {
        const decoded = Buffer.from(encoded, "base64");
        if (decoded.length !== 32 || decoded.toString("base64") !== encoded) return [];
        return [[sid, decoded] as const];
      }),
    );
    expect(legacyKeys.get("d1")?.equals(key)).toBe(true);
    expect(legacyKeys.get("retained")?.equals(retainedKey)).toBe(true);
    expect(legacyKeys.size).toBe(3);
    expect(readFileSync(`${path}.bak`, "utf8")).toBe(readFileSync(path, "utf8"));

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
    const persisted = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    expect(persisted.retained).toBe(retainedKey.toString("base64"));
    expect(persisted.d1).toBeUndefined();
  });

  it("旧 K1 的 pending-disable 遇 pending-enable：无 R1 拒绝，有 matching R1 才删 K1 后生成 K2", () => {
    const s = new E2EKeyStore(path);
    const k1 = s.createForEnable("d1");
    s.markServerE2E("d1", "disable");
    s.beginDisable("d1", disableIntent("d1", k1));
    expect(() =>
      s.applyServerState({
        version: 1,
        sessions: [{ hermesSessionId: "d1", pendingOp: "enable" }],
        disabledReceipts: [],
      }),
    ).toThrow(/拒绝复用旧 K_S/);
    expect(s.requireKey("d1").equals(k1)).toBe(true);

    const receipt = s.disableReceiptForBackfill("d1");
    expect(
      s.applyServerState({
        version: 1,
        sessions: [{ hermesSessionId: "d1", pendingOp: "enable" }],
        disabledReceipts: [receipt],
      }),
    ).toEqual(["d1"]);
    expect(s.hasKey("d1")).toBe(false);
    expect(s.isE2E("d1")).toBe(true);
    const k2 = s.createForEnable("d1");
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

  it("#347 stable server 快照清 stale intent 保留 K_S；新 pending-enable 可恢复 quarantine", () => {
    const s = new E2EKeyStore(path);
    const key = s.createForEnable("d1");
    s.markServerE2E("d1", "disable");
    s.beginDisable("d1", disableIntent("d1", key));

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

  it("迟到 ACK 不得结算已切换方向的新转换", () => {
    const s = new E2EKeyStore(path);
    s.createForEnable("d1");
    s.applyServerState({
      version: 1,
      disabledReceipts: [],
      sessions: [{ hermesSessionId: "d1", pendingOp: "disable" }],
    });
    s.markServerE2E("d1", "enable");
    expect(() => s.completeDisable("d1", {})).toThrow(/stale disable receipt/);
    expect(s.hasKey("d1")).toBe(true);

    s.markServerE2E("d1", "disable");
    expect(() => s.markEnableComplete("d1")).toThrow(/stale enable ACK/);
    expect(s.hasKey("d1")).toBe(true);
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
    const persistence = new E2EKeyStoreError("keystore persistence failed");
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
