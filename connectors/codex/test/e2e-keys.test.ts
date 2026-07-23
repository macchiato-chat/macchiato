import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  E2EKeyStore,
  E2EKeyStoreLoadError,
  E2EKeyStorePersistenceError,
  E2EKeyStorePoisonedError,
  E2EKeyStoreStateError,
  settleE2EBackfillAck,
} from "../src/e2e/keys";
import * as ec from "../src/e2e/crypto";
import { e2eControlKeyId, type E2EControlEnvelopeV1 } from "../src/e2e/control";

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

describe("E2EKeyStore（持鑰/封裝/加解密/持久化）", () => {
  let dir: string;
  let path: string;
  let backupPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "occ-e2e-"));
    path = join(dir, "e2e.json");
    backupPath = `${path}.bak`;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("只有主檔與備份都 ENOENT 時才初始化空 store", () => {
    const s = new E2EKeyStore(path);
    expect(s.hasKey("d1")).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(backupPath)).toBe(false);
  });

  it("顯式 enable + isE2E + 同會話同一把", () => {
    const s = new E2EKeyStore(path);
    expect(s.isE2E("d1")).toBe(false);
    const k = s.createForEnable("d1");
    expect(k.length).toBe(32);
    expect(s.isE2E("d1")).toBe(true);
    expect(s.requireKey("d1").equals(k)).toBe(true);
    expect(s.createForEnable("d1").equals(k)).toBe(true);
    // 舊 API 僅保留 enable 呼叫點相容。
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
    const k = s.requireKey("d1");
    expect(ec.unwrapKey(wrapped[0].sealed, a.priv).equals(k)).toBe(true);
    expect(ec.unwrapKey(wrapped[1].sealed, b.priv).equals(k)).toBe(true);
  });

  it("encrypt/decrypt 只接受既有 key，絕不隱式 enable", () => {
    const s = new E2EKeyStore(path);
    expect(() => s.encryptContent("d1", { text: "不能建鑰" })).toThrow(E2EKeyStoreStateError);
    expect(() => s.encryptText("d1", "不能建鑰")).toThrow(E2EKeyStoreStateError);
    expect(s.isE2E("d1")).toBe(false);
    expect(existsSync(path)).toBe(false);

    s.createForEnable("d1");
    const obj = { text: "祕密", reasoning: "想" };
    expect(s.decryptContent("d1", s.encryptContent("d1", obj))).toEqual(obj);
    expect(s.decryptText("d1", s.encryptText("d1", "hi"))).toBe("hi");
    expect(() => s.decryptText("nope", "x")).toThrow();
  });

  it("ready 快照：任一 server E2E 缺鑰都按 session 隔离，其它会话仍可 ready", () => {
    const enabled = new E2EKeyStore(path);
    expect(
      enabled.applyServerState({
        version: 1,
        disabledReceipts: [],
        sessions: [{ hermesSessionId: "enabled", pendingOp: null }],
      }),
    ).toEqual(["enabled"]);
    expect(enabled.isE2E("enabled")).toBe(true);
    expect(() => enabled.encryptText("enabled", "blocked")).toThrow(E2EKeyStoreStateError);

    const disabling = new E2EKeyStore(join(dir, "disabling.json"));
    expect(
      disabling.applyServerState({
        version: 1,
        disabledReceipts: [],
        sessions: [{ hermesSessionId: "disabling", pendingOp: "disable" }],
      }),
    ).toEqual(["disabling"]);
    expect(disabling.isE2E("disabling")).toBe(true);

    const enabling = new E2EKeyStore(join(dir, "enabling.json"));
    expect(
      enabling.applyServerState({
        version: 1,
        disabledReceipts: [],
        sessions: [{ hermesSessionId: "enabling", pendingOp: "enable" }],
      }),
    ).toEqual(["enabling"]);
    expect(enabling.isE2E("enabling")).toBe(true);
    expect(enabling.hasKey("enabling")).toBe(false);
    expect(() => enabling.encryptText("enabling", "secret")).toThrow(E2EKeyStoreStateError);
    enabling.createForEnable("enabling");
    expect(enabling.encryptText("enabling", "secret")).toBeTypeOf("string");
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
  });

  it("畸形/重複 ready state 拒絕且不發布半套 server 狀態", () => {
    const s = new E2EKeyStore(path);
    s.applyServerState({
      version: 1,
      disabledReceipts: [],
      sessions: [{ hermesSessionId: "keep-protected", pendingOp: "enable" }],
    });
    expect(() => s.applyServerState(undefined)).toThrow(E2EKeyStoreStateError);
    expect(() => s.applyServerState({ version: 1, sessions: [] })).toThrow(E2EKeyStoreStateError);
    expect(() =>
      s.applyServerState({
        version: 1,
        disabledReceipts: [],
        sessions: [
          { hermesSessionId: "duplicate", pendingOp: "enable" },
          { hermesSessionId: "duplicate", pendingOp: "enable" },
        ],
      }),
    ).toThrow(E2EKeyStoreStateError);
    expect(s.isE2E("keep-protected")).toBe(true);
    expect(s.isE2E("duplicate")).toBe(false);
  });

  it("effective E2E 是本地 key ∪ server IDs；ready 漏報本地 key 时保留 quarantine floor", () => {
    const s = new E2EKeyStore(path);
    s.createForEnable("local-only");
    expect(s.applyServerState({ version: 1, sessions: [], disabledReceipts: [] })).toEqual(["local-only"]);
    expect(s.isE2E("local-only")).toBe(true);
    expect(s.hasKey("local-only")).toBe(true);
    expect(() => s.requireKey("local-only")).toThrow(/quarantine/);

    const synced = new E2EKeyStore(join(dir, "synced.json"));
    expect(synced.applyServerState({ version: 1, sessions: [], disabledReceipts: [] })).toEqual([]);
    expect(() => synced.createForEnable("not-pending")).toThrow(E2EKeyStoreStateError);
    synced.markServerE2E("enabling", "enable");
    expect(() => synced.wrapExistingForDevices("enabling", [])).toThrow(E2EKeyStoreStateError);
    expect(synced.hasKey("enabling")).toBe(false); // 補封缺鑰絕不生成 K₂。
    synced.wrapForEnable("enabling", []);
    expect(synced.hasKey("enabling")).toBe(true);
    synced.markEnableComplete("enabling");
    expect(synced.isE2E("enabling")).toBe(true);
  });

  it("#347 pending-disable intent 与 K_S 同快照持久化；ACK 丢失后按 ready 权威状态收敛", () => {
    const s = new E2EKeyStore(path);
    const key = s.createForEnable("d1");
    const retainedKey = s.createForEnable("retained");
    s.markServerE2E("d1", "disable");
    s.beginDisable("d1", disableIntent("d1", key));
    expect(s.hasPendingDisable("d1")).toBe(true);

    // 旧版 reader 仍只看到 flat sid → canonical 32-byte base64，不会因新 metadata fail-open。
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
    expect(legacyKeys.size).toBe(3); // 两把真 K_S + 不可达 metadata sentinel。
    expect(readFileSync(path, "utf8")).toBe(readFileSync(backupPath, "utf8"));

    const afterAckLoss = new E2EKeyStore(path);
    expect(afterAckLoss.hasPendingDisable("d1")).toBe(true);
    expect(afterAckLoss.requireKey("d1").equals(key)).toBe(true);
    const receipt = afterAckLoss.disableReceiptForBackfill("d1");
    // 仅匹配的 completion receipt 才证明 disable 事务已提交；omission 本身不删钥。
    expect(
      afterAckLoss.applyServerState({
        version: 1,
        sessions: [{ hermesSessionId: "retained", pendingOp: null }],
        disabledReceipts: [receipt],
      }),
    ).toEqual([]);
    expect(afterAckLoss.hasPendingDisable("d1")).toBe(false);
    expect(afterAckLoss.hasKey("d1")).toBe(false);
    expect(afterAckLoss.isE2E("d1")).toBe(false);
    expect(afterAckLoss.requireKey("retained").equals(retainedKey)).toBe(true);
    const persisted = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    expect(persisted.retained).toBe(retainedKey.toString("base64"));
    expect(persisted.d1).toBeUndefined();
  });

  it("旧 K1 的 pending-disable 遇 pending-enable：无 R1 拒绝，有 matching R1 才删 K1 后生成 K2", () => {
    const noReceipt = new E2EKeyStore(path);
    const k1 = noReceipt.createForEnable("d1");
    noReceipt.markServerE2E("d1", "disable");
    noReceipt.beginDisable("d1", disableIntent("d1", k1));
    expect(() =>
      noReceipt.applyServerState({
        version: 1,
        sessions: [{ hermesSessionId: "d1", pendingOp: "enable" }],
        disabledReceipts: [],
      }),
    ).toThrow(/拒绝复用旧 K_S/);
    expect(noReceipt.requireKey("d1").equals(k1)).toBe(true);

    const receipt = noReceipt.disableReceiptForBackfill("d1");
    expect(
      noReceipt.applyServerState({
        version: 1,
        sessions: [{ hermesSessionId: "d1", pendingOp: "enable" }],
        disabledReceipts: [receipt],
      }),
    ).toEqual(["d1"]);
    expect(noReceipt.hasKey("d1")).toBe(false);
    expect(noReceipt.isE2E("d1")).toBe(true);
    const k2 = noReceipt.createForEnable("d1");
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

  it("#347 ready 仍列 E2E 但不再 pending-disable 时只清 stale intent，保留 K_S", () => {
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
  });

  it("#347 quarantine 可由新的权威 pending-enable 恢复，并沿用原 K_S", () => {
    const s = new E2EKeyStore(path);
    const key = s.createForEnable("d1");
    expect(s.applyServerState({ version: 1, sessions: [], disabledReceipts: [] })).toEqual(["d1"]);
    expect(() => s.requireKey("d1")).toThrow(/quarantine/);

    s.markServerE2E("d1", "enable");
    s.wrapForEnable("d1", []);
    expect(s.requireKey("d1").equals(key)).toBe(true);
    s.markEnableComplete("d1");
  });

  it("completeDisable 只有持有舊 key 時才能刪鑰並撤掉 server protection floor", () => {
    const s = new E2EKeyStore(path);
    const key = s.createForEnable("d1");
    s.applyServerState({
      version: 1,
      disabledReceipts: [],
      sessions: [{ hermesSessionId: "d1", pendingOp: "disable" }],
    });
    s.beginDisable("d1", disableIntent("d1", key));
    const receipt = s.disableReceiptForBackfill("d1");
    s.completeDisable("d1", receipt);
    expect(s.isE2E("d1")).toBe(false);
    expect(s.hasKey("d1")).toBe(false);
    expect(s.hasPendingDisable("d1")).toBe(false);

    const reloaded = new E2EKeyStore(path);
    expect(reloaded.hasKey("d1")).toBe(false);
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

  it("主檔與備份持久化同一份最新快照、0600，重載同鑰", () => {
    const s = new E2EKeyStore(path);
    const k = s.createForEnable("d1");
    s.createForEnable("d2");
    expect(readFileSync(path, "utf8")).toBe(readFileSync(backupPath, "utf8"));
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    }
    const s2 = new E2EKeyStore(path);
    expect(s2.isE2E("d1")).toBe(true);
    expect(s2.requireKey("d1").equals(k)).toBe(true);
    expect(s2.isE2E("d2")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(readFileSync(backupPath, "utf8"));
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

  it("主檔損壞時從包含最新 key 的備份恢復並重建主檔", () => {
    const s = new E2EKeyStore(path);
    const d1 = s.createForEnable("d1");
    const d2 = s.createForEnable("d2");
    writeFileSync(path, "{broken");

    const recovered = new E2EKeyStore(path);
    expect(recovered.requireKey("d1").equals(d1)).toBe(true);
    expect(recovered.requireKey("d2").equals(d2)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(readFileSync(backupPath, "utf8"));
  });

  it("主檔缺失時從備份恢復", () => {
    const s = new E2EKeyStore(path);
    const key = s.createForEnable("d1");
    rmSync(path);

    const recovered = new E2EKeyStore(path);
    expect(recovered.requireKey("d1").equals(key)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(readFileSync(backupPath, "utf8"));
  });

  it("主檔有效時以主檔為權威並修復損壞備份", () => {
    const s = new E2EKeyStore(path);
    const key = s.createForEnable("d1");
    writeFileSync(backupPath, "{broken");

    const recovered = new E2EKeyStore(path);
    expect(recovered.requireKey("d1").equals(key)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(readFileSync(backupPath, "utf8"));
  });

  it("receipt 刪除同步到最新備份，恢復時不復活已刪 key", () => {
    const s = new E2EKeyStore(path);
    s.createForEnable("removed");
    const kept = s.createForEnable("kept");
    completeDisableWithReceipt(s, "removed");
    expect(JSON.parse(readFileSync(backupPath, "utf8"))).not.toHaveProperty("removed");
    writeFileSync(path, "{broken");

    const recovered = new E2EKeyStore(path);
    expect(recovered.isE2E("removed")).toBe(false);
    expect(recovered.requireKey("kept").equals(kept)).toBe(true);
  });

  it.each([
    ["主檔損壞、備份缺失", "{broken", undefined],
    ["主檔缺失、備份損壞", undefined, "{broken"],
    ["主檔與備份都損壞", "{broken", "{also-broken"],
  ])("%s 時 fail-closed", (_name, primary, backup) => {
    if (primary !== undefined) writeFileSync(path, primary);
    if (backup !== undefined) writeFileSync(backupPath, backup);
    expect(() => new E2EKeyStore(path)).toThrow(E2EKeyStoreLoadError);
  });

  it.each([
    ["陣列頂層", "[]"],
    ["非字串值", JSON.stringify({ d1: 1 })],
    ["非法 base64", JSON.stringify({ d1: "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!=" })],
    ["31-byte key", JSON.stringify({ d1: Buffer.alloc(31).toString("base64") })],
    ["缺 padding", JSON.stringify({ d1: Buffer.alloc(32).toString("base64").slice(0, -1) })],
    [
      "URL-safe base64",
      JSON.stringify({ d1: Buffer.alloc(32, 0xfb).toString("base64").replaceAll("+", "-").replaceAll("/", "_") }),
    ],
    [
      "非 canonical pad bits",
      JSON.stringify({ d1: `${Buffer.alloc(32).toString("base64").slice(0, -2)}B=` }),
    ],
  ])("%s 快照拒絕載入", (_name, snapshot) => {
    writeFileSync(path, snapshot);
    writeFileSync(backupPath, snapshot);
    expect(() => new E2EKeyStore(path)).toThrow(E2EKeyStoreLoadError);
  });

  it("持久化失敗後 copy-on-write 不發布新狀態，且整個實例 poison", () => {
    const s = new E2EKeyStore(path);
    const d1 = s.createForEnable("d1");

    // 讓主檔目標變成目錄，注入第一個 atomic rename 失敗；備份仍是提交前的有效快照。
    rmSync(path);
    mkdirSync(path);
    expect(() => s.createForEnable("d2")).toThrow(E2EKeyStorePersistenceError);
    expect(() => s.hasKey("d1")).toThrow(E2EKeyStorePoisonedError);
    expect(() => s.requireKey("d1")).toThrow(E2EKeyStorePoisonedError);
    expect(() => s.markServerE2E("d1", null)).toThrow(E2EKeyStorePoisonedError);
    expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);

    rmSync(path, { recursive: true });
    const recovered = new E2EKeyStore(path);
    expect(recovered.requireKey("d1").equals(d1)).toBe(true);
    expect(recovered.isE2E("d2")).toBe(false);
  });

  it("主檔已更新但備份寫失敗時仍 poison；重啟以主檔修復而不丟最新 key", () => {
    const s = new E2EKeyStore(path);
    s.createForEnable("d1");

    // 注入 pair 的第二步失敗：主檔已是 d1+d2，備份仍停在 d1。
    rmSync(backupPath);
    mkdirSync(backupPath);
    expect(() => s.createForEnable("d2")).toThrow(E2EKeyStorePersistenceError);
    expect(() => s.isE2E("d1")).toThrow(E2EKeyStorePoisonedError);

    rmSync(backupPath, { recursive: true });
    const recovered = new E2EKeyStore(path);
    expect(recovered.isE2E("d1")).toBe(true);
    expect(recovered.isE2E("d2")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(readFileSync(backupPath, "utf8"));
  });
});

describe("#144 keystore 路徑隔離(fork 殘留回歸)", () => {
  it("默認路徑是 codex 專屬,絕不與 CC 共用(兩常駐進程整檔重寫會互相覆蓋 K_S)", async () => {
    const prev = process.env.MACCHIATO_CODEX_E2E_STORE;
    delete process.env.MACCHIATO_CODEX_E2E_STORE;
    const { e2eStorePath } = await import("../src/e2e/keys");
    expect(e2eStorePath()).toContain("codex-e2e.json");
    expect(e2eStorePath()).not.toContain("claude-code-e2e.json");
    // env 覆蓋走 codex 專屬變量
    process.env.MACCHIATO_CODEX_E2E_STORE = "/x/custom.json";
    expect(e2eStorePath()).toBe("/x/custom.json");
    if (prev === undefined) delete process.env.MACCHIATO_CODEX_E2E_STORE;
    else process.env.MACCHIATO_CODEX_E2E_STORE = prev;
  });
});

describe("#347 backfill ACK error boundary", () => {
  it("只把 StateError 当 stale；Persistence/poison 类错误必须重抛给 outer fatal", () => {
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
    const persistence = new E2EKeyStorePersistenceError("disk failed");
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
