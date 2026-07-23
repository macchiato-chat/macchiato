import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2EKeyStore, E2EKeyStoreStateError } from "../src/e2e/keys";
import * as ec from "../src/e2e/crypto";
import { handleE2EControlFrame } from "../src/index";
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

describe("#347 E2E 控制 roundtrip", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-e2e-control-"));
    path = join(dir, "keys.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("pending enable → 建鑰/封裝/backfill ACK → disable 回灌/ACK 後才刪鑰", () => {
    const sid = "01K0CODEXCONTROLRNDTRIP001";
    const localSid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee3490";
    const e2e = new E2EKeyStore(path);
    expect(
      e2e.applyServerState({
        version: 1,
        disabledReceipts: [],
        sessions: [{ hermesSessionId: sid, pendingOp: "enable" }],
      }),
    ).toEqual([sid]);

    const sent: Record<string, any>[] = [];
    const unblocked: string[] = [];
    const backfills: Array<{ sid: string; localSid: string | undefined; mode: "enable" | "disable" }> = [];
    const results: Array<{ sid: string; mode: "enable" | "disable"; committed: boolean }> = [];
    const linkb = {
      agentLinkId: "al",
      send: (msg: Record<string, unknown>) => sent.push(msg),
      unblockSession: (unblockedSid: string) => unblocked.push(unblockedSid),
    };
    const mirror = {
      backfillE2E: async (
        backfillSid: string,
        backfillLocalSid: string | undefined,
        mode: "enable" | "disable" = "enable",
      ) => {
        backfills.push({ sid: backfillSid, localSid: backfillLocalSid, mode });
      },
      handleE2EBackfillResult: (
        resultSid: string,
        mode: "enable" | "disable",
        committed: boolean,
      ) => {
        results.push({ sid: resultSid, mode, committed });
      },
    };
    const sessions = { localSessionIdFor: (wireSid: string) => (wireSid === sid ? localSid : undefined) };
    const device = ec.genDeviceKeypair();

    expect(
      handleE2EControlFrame(
        {
          t: "e2e_wrap_request",
          hermesSessionId: sid,
          backfill: true,
          devices: [{ deviceId: "phone", pubKey: device.pubB64 }],
        },
        linkb,
        e2e,
        mirror,
        sessions,
      ),
    ).toBe(true);
    expect(e2e.hasKey(sid)).toBe(true);
    expect(e2e.isE2E(sid)).toBe(true);
    expect(backfills).toEqual([{ sid, localSid, mode: "enable" }]);
    const keyFrame = sent.at(-1)!;
    expect(keyFrame.t).toBe("e2e_key");
    expect(ec.unwrapKey(keyFrame.wrapped[0].sealed, device.priv).equals(e2e.requireKey(sid))).toBe(true);

    handleE2EControlFrame(
      { t: "e2e_backfill_result", hermesSessionId: sid, mode: "enable", ok: true, e2e: false },
      linkb,
      e2e,
      mirror,
      sessions,
    );
    expect(results.at(-1)).toEqual({ sid, mode: "enable", committed: false });
    expect(e2e.hasKey(sid)).toBe(true);

    handleE2EControlFrame(
      { t: "e2e_backfill_result", hermesSessionId: sid, mode: "enable", ok: true, e2e: true },
      linkb,
      e2e,
      mirror,
      sessions,
    );
    expect(e2e.isE2E(sid)).toBe(true);
    expect(results.at(-1)).toEqual({ sid, mode: "enable", committed: true });
    expect(unblocked).toEqual([sid]);

    // 正式发起来自已认证 e2e.control；这里直接模拟其已原子持久化的 local intent。
    e2e.beginDisable(sid, disableIntent(sid, e2e.requireKey(sid)));
    handleE2EControlFrame(
      { t: "e2e_disable_request", hermesSessionId: sid },
      linkb,
      e2e,
      mirror,
      sessions,
    );
    expect(backfills.at(-1)).toEqual({ sid, localSid, mode: "disable" });
    expect(e2e.hasKey(sid)).toBe(true);
    expect(e2e.hasPendingDisable(sid)).toBe(true);
    expect(new E2EKeyStore(path).hasPendingDisable(sid)).toBe(true);

    // pending-disable 期间的新设备补封只沿用现有 K_S，不能把转换模式覆盖成 stable。
    const secondDevice = ec.genDeviceKeypair();
    handleE2EControlFrame(
      {
        t: "e2e_wrap_request",
        hermesSessionId: sid,
        backfill: false,
        devices: [{ deviceId: "tablet", pubKey: secondDevice.pubB64 }],
      },
      linkb,
      e2e,
      mirror,
      sessions,
    );
    const rewrapFrame = sent.at(-1)!;
    expect(ec.unwrapKey(rewrapFrame.wrapped[0].sealed, secondDevice.priv).equals(e2e.requireKey(sid))).toBe(true);

    // 發送 backfill 或收到拒絕都不能刪 K_S。
    handleE2EControlFrame(
      {
        t: "e2e_backfill_result",
        hermesSessionId: sid,
        mode: "disable",
        ok: true,
        e2e: true,
        error: "inconsistent tuple",
      },
      linkb,
      e2e,
      mirror,
      sessions,
    );
    expect(results.at(-1)).toEqual({ sid, mode: "disable", committed: false });
    expect(e2e.hasKey(sid)).toBe(true);
    expect(e2e.isE2E(sid)).toBe(true);

    // 只有 server 明確確認事務提交且 e2e=false 才完成關閉。
    const receipt = e2e.disableReceiptForBackfill(sid);
    handleE2EControlFrame(
      {
        t: "e2e_backfill_result",
        hermesSessionId: sid,
        mode: "disable",
        ok: true,
        e2e: false,
        disableReceipt: receipt,
      },
      linkb,
      e2e,
      mirror,
      sessions,
    );
    expect(results.at(-1)).toEqual({ sid, mode: "disable", committed: true });
    expect(e2e.hasKey(sid)).toBe(false);
    expect(e2e.hasPendingDisable(sid)).toBe(false);
    expect(e2e.isE2E(sid)).toBe(false);
    expect(new E2EKeyStore(path).hasKey(sid)).toBe(false);
  });

  it("裸 disable 不能从 stable 发起；仅本地 authenticated pending 可跨重启恢复", () => {
    const sid = "01K0CODEXDISABLERESUME0001";
    const e2e = new E2EKeyStore(path);
    e2e.createForEnable(sid);
    e2e.applyServerState({
      version: 1,
      disabledReceipts: [],
      sessions: [{ hermesSessionId: sid, pendingOp: null }],
    });
    const backfills: string[] = [];
    const sent: Record<string, unknown>[] = [];
    const linkb = { agentLinkId: "al", send: (frame: Record<string, unknown>) => sent.push(frame) };
    const mirror = {
      backfillE2E: async () => {
        backfills.push(sid);
      },
      handleE2EBackfillResult: () => {},
    };
    const sessions = { localSessionIdFor: () => "local-1" };

    handleE2EControlFrame(
      { t: "e2e_disable_request", hermesSessionId: sid },
      linkb,
      e2e,
      mirror,
      sessions,
    );
    expect(backfills).toEqual([]);
    expect(e2e.hasPendingDisable(sid)).toBe(false);
    expect(sent).toEqual([{
      t: "e2e_backfill",
      agentLinkId: "al",
      hermesSessionId: sid,
      mode: "disable",
      found: false,
    }]);

    e2e.beginDisable(
      sid,
      disableIntent(sid, e2e.requireKey(sid)),
    ); // 模拟签封 session.e2e.disable 已验证并持久化 intent。
    const restarted = new E2EKeyStore(path);
    restarted.applyServerState({
      version: 1,
      disabledReceipts: [],
      sessions: [{ hermesSessionId: sid, pendingOp: "disable" }],
    });
    handleE2EControlFrame(
      { t: "e2e_disable_request", hermesSessionId: sid },
      linkb,
      restarted,
      mirror,
      sessions,
    );
    expect(backfills).toEqual([sid]);
    expect(restarted.hasPendingDisable(sid)).toBe(true);
  });

  it("新設備補封沿用既有 K_S；缺鑰時拒絕且不生成 K₂", () => {
    const sid = "existing";
    const e2e = new E2EKeyStore(path);
    const original = e2e.createForEnable(sid);
    e2e.applyServerState({
      version: 1,
      disabledReceipts: [],
      sessions: [{ hermesSessionId: sid, pendingOp: null }],
    });
    const sent: Record<string, any>[] = [];
    const linkb = { agentLinkId: "al", send: (msg: Record<string, unknown>) => sent.push(msg) };
    const mirror = { backfillE2E: async () => {}, handleE2EBackfillResult: () => {} };
    const sessions = { localSessionIdFor: (wireSid: string) => wireSid };
    const device = ec.genDeviceKeypair();

    handleE2EControlFrame(
      {
        t: "e2e_wrap_request",
        hermesSessionId: sid,
        devices: [{ deviceId: "new-phone", pubKey: device.pubB64 }],
      },
      linkb,
      e2e,
      mirror,
      sessions,
    );
    expect(ec.unwrapKey(sent[0].wrapped[0].sealed, device.priv).equals(original)).toBe(true);

    const missing = new E2EKeyStore(join(dir, "missing.json"));
    missing.applyServerState({
      version: 1,
      disabledReceipts: [],
      sessions: [{ hermesSessionId: "missing", pendingOp: "enable" }],
    });
    expect(() =>
      handleE2EControlFrame(
        { t: "e2e_wrap_request", hermesSessionId: "missing", devices: [] },
        linkb,
        missing,
        mirror,
        sessions,
      ),
    ).toThrow(E2EKeyStoreStateError);
    expect(missing.hasKey("missing")).toBe(false);
    expect(missing.isE2E("missing")).toBe(true);
  });
});
