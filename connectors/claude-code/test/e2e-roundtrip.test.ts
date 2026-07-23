/**
 * #74 E2E 路徑運行時驗證:模擬 iOS 設備(真 X25519 密鑰對),走連接器完整 E2E 鏈路,驗證
 * 設備能用 K_S 解出明文。之前 E2E 只有 crypto 單測,這裡驗**連接器編排**(wrap→鏡像加密→
 * 驅動加密回合→D2 回灌 enable/disable)端到端對得上。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2EKeyStore } from "../src/e2e/keys";
import { decrypt, genDeviceKeypair, unwrapKey } from "../src/e2e/crypto";
import { isCommittedE2EBackfillResult } from "../src/cc/mirror";
import { e2eControlKeyId, type E2EControlEnvelopeV1 } from "../src/e2e/control";

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function freshStore(): E2EKeyStore {
  return new E2EKeyStore(join(mkdtempSync(join(tmpdir(), "cc-e2e-")), "e2e.json"));
}

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

/** 模擬設備:拿到 sealed K_S → 解封 → 用 K_S 解 blob。 */
function device() {
  const kp = genDeviceKeypair();
  return {
    deviceId: "dev-1",
    pubKey: kp.pubB64,
    open: (sealed: string, blob: string) => decrypt(unwrapKey(sealed, kp.priv), blob),
  };
}

describe("#74 E2E 連接器編排端到端", () => {
  it.each([
    ["enable", true, true, true],
    ["enable", true, false, false],
    ["enable", false, true, false],
    ["enable", true, undefined, false],
    ["disable", true, false, true],
    ["disable", true, true, false],
    ["disable", false, false, false],
    ["disable", true, undefined, false],
  ] as const)(
    "#347 backfill ACK tuple mode=%s ok=%s e2e=%s → committed=%s",
    (mode, ok, e2e, expected) => {
      expect(isCommittedE2EBackfillResult(mode, ok, e2e)).toBe(expected);
    },
  );

  it("wrap → 設備解封 K_S → 解 encryptContent/encryptText 明文一致", () => {
    const e2e = freshStore();
    const dev = device();
    const [w] = e2e.wrapForDevices(SID, [{ deviceId: dev.deviceId, pubKey: dev.pubKey }]);
    expect(w).toBeTruthy();
    // 內容塊
    const enc = e2e.encryptContent(SID, { text: "secret hi", reasoning: "think", tools: [] });
    expect(JSON.parse(dev.open(w!.sealed, enc))).toMatchObject({ text: "secret hi", reasoning: "think" });
    // 標題
    const encT = e2e.encryptText(SID, "私密標題");
    expect(dev.open(w!.sealed, encT)).toBe("私密標題");
    expect(e2e.isE2E(SID)).toBe(true);
  });

  it("鏡像加密批(Mirror.entry E2E 分支):title+每條 enc 設備可解,srcId 明文保留", async () => {
    const e2e = freshStore();
    const dev = device();
    const [w] = e2e.wrapForDevices(SID, [{ deviceId: dev.deviceId, pubKey: dev.pubKey }]);
    // 直接調 Mirror 的私有 entry(E2E 分支)
    const { Mirror } = await import("../src/cc/mirror");
    const m = new Mirror({ agentLinkId: "AL", isReady: true, send: () => {}, onFrame: () => () => {} } as any, e2e);
    const entry = (m as any).entry(SID, "T", [
      { role: "user", text: "u-msg", srcId: "s1", createdAt: 1 },
      { role: "agent", text: "a-msg", reasoning: "r", srcId: "s2", createdAt: 2 },
    ]);
    expect(entry.e2e).toBe(true);
    expect(dev.open(w!.sealed, entry.title)).toBe("T");
    expect(entry.messages[0].srcId).toBe("s1"); // srcId 是元數據,明文保留(去重用)
    expect(JSON.parse(dev.open(w!.sealed, entry.messages[0].enc))).toMatchObject({ text: "u-msg" });
    expect(JSON.parse(dev.open(w!.sealed, entry.messages[1].enc))).toMatchObject({ text: "a-msg", reasoning: "r" });
    // enc 存在時不應洩漏明文 text 字段
    expect(entry.messages[0].text).toBeUndefined();
  });

  it("D2 回灌 enable:全歷史重加密設備可解;disable:回明文但 ACK 前保留 K_S", async () => {
    const e2e = freshStore();
    const dev = device();
    const wireSid = "01K0CCBACKFILLWIRE000000001";
    e2e.wrapForDevices(wireSid, [{ deviceId: dev.deviceId, pubKey: dev.pubKey }]);
    const [w] = e2e.wrapForDevices(wireSid, [{ deviceId: dev.deviceId, pubKey: dev.pubKey }]);
    // 造一個 transcript 讓 backfillE2E 讀
    const cfg = mkdtempSync(join(tmpdir(), "cc-e2e-cfg-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(cfg, "projects", "-x"), { recursive: true });
    const f = join(cfg, "projects", "-x", `${SID}.jsonl`);
    writeFileSync(
      f,
      JSON.stringify({ type: "user", uuid: "u1", sessionId: SID, timestamp: "2026-07-06T00:00:00Z", message: { role: "user", content: "hist question" } }) +
        "\n" +
        JSON.stringify({ type: "assistant", uuid: "a1", sessionId: SID, timestamp: "2026-07-06T00:00:01Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "hist answer" }] } }) +
        "\n",
    );
    const { Mirror } = await import("../src/cc/mirror");
    const sent: any[] = [];
    const m = new Mirror({ agentLinkId: "AL", isReady: true, send: (x: any) => sent.push(x), onFrame: () => () => {} } as any, e2e);

    await m.backfillE2E(wireSid, SID, "enable");
    const enBatch = sent.at(-1);
    expect(enBatch.t).toBe("e2e_backfill");
    expect(enBatch.found).toBe(true);
    expect(enBatch.mode).toBe("enable");
    expect(enBatch).not.toHaveProperty("title");
    expect(enBatch).not.toHaveProperty("messages");
    expect(enBatch).toMatchObject({ hermesSessionId: wireSid });
    expect(enBatch.session).toMatchObject({ hermesSessionId: wireSid, source: "claude-code", e2e: true });
    // 設備解回灌內容
    expect(dev.open(w!.sealed, enBatch.session.title)).toBe("Claude Code");
    const decoded = enBatch.session.messages.map((x: any) => JSON.parse(dev.open(w!.sealed, x.enc)));
    expect(decoded.map((d: any) => d.text)).toEqual(["hist question", "hist answer"]);
    // send 不是提交：成功 ACK 前不推进 transcript 水位线。
    expect((m as any).state.offsets[SID]).toBeUndefined();
    expect((m as any).state.offsets[wireSid]).toBeUndefined();
    m.handleE2EBackfillResult(wireSid, "enable", true);
    expect((m as any).state.offsets[SID]).toBe(statSync(f).size);
    expect((m as any).state.offsets[wireSid]).toBeUndefined();

    e2e.beginDisable(wireSid, disableIntent(wireSid, e2e.requireKey(wireSid)));
    await m.backfillE2E(wireSid, SID, "disable");
    const disBatch = sent.at(-1);
    expect(disBatch.mode).toBe("disable");
    expect(disBatch).not.toHaveProperty("title");
    expect(disBatch).not.toHaveProperty("messages");
    expect(disBatch).toMatchObject({ hermesSessionId: wireSid });
    expect(disBatch.session).toMatchObject({ hermesSessionId: wireSid, source: "claude-code" });
    expect(disBatch.session.e2e).toBeUndefined();
    expect(disBatch.session.messages[0].text).toBe("hist question"); // 明文回灌
    expect(disBatch.session.messages[0].enc).toBeUndefined();
    expect(e2e.isE2E(wireSid)).toBe(true);
    expect(e2e.hasKey(wireSid)).toBe(true); // 仅发送成功不等于 server 事务提交，ACK 前绝不删
    expect((m as any).pendingE2EBackfills.size).toBe(1);

    m.handleE2EBackfillResult(wireSid, "disable", true);
    e2e.completeDisable(wireSid, disBatch.disableReceipt); // 模拟带 completion receipt 的成功结果
    expect((m as any).pendingE2EBackfills.size).toBe(0);
    expect(e2e.isE2E(wireSid)).toBe(false);
    expect(e2e.hasKey(wireSid)).toBe(false);
  });

  it("#347 server 拒绝 backfill 时不推进暂存水位线", async () => {
    const e2e = freshStore();
    const wireSid = "01K0CCBACKFILLWIRE000000002";
    e2e.createForEnable(wireSid);
    const cfg = mkdtempSync(join(tmpdir(), "cc-e2e-reject-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(cfg, "projects", "-x"), { recursive: true });
    writeFileSync(
      join(cfg, "projects", "-x", `${SID}.jsonl`),
      JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId: SID,
        message: { role: "user", content: "do not skip me" },
      }) + "\n",
    );
    const { Mirror } = await import("../src/cc/mirror");
    const sent: any[] = [];
    const m = new Mirror(
      { agentLinkId: "AL", isReady: true, send: (x: any) => sent.push(x), onFrame: () => () => {} } as any,
      e2e,
    );

    e2e.beginDisable(wireSid, disableIntent(wireSid, e2e.requireKey(wireSid)));
    await m.backfillE2E(wireSid, SID, "disable");
    expect(sent.at(-1)).toMatchObject({
      t: "e2e_backfill",
      hermesSessionId: wireSid,
      mode: "disable",
      found: true,
      session: { hermesSessionId: wireSid },
    });
    expect((m as any).state.offsets[SID]).toBeUndefined();
    m.fastForward(SID);
    (m as any).doPoll();
    expect((m as any).state.offsets[SID]).toBeUndefined(); // pending 时显式快进/普通 poll 都必须冻结
    expect(sent).toHaveLength(1);
    m.handleE2EBackfillResult(wireSid, "disable", false);
    expect((m as any).state.offsets[SID]).toBeUndefined();
    expect((m as any).pendingE2EBackfills.size).toBe(0);
    expect(e2e.hasKey(wireSid)).toBe(true);
  });

  it("found:false — 無此會話 transcript 時回灌不編造內容", async () => {
    const e2e = freshStore();
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cc-e2e-empty-"));
    const { Mirror } = await import("../src/cc/mirror");
    const sent: any[] = [];
    const m = new Mirror({ agentLinkId: "AL", isReady: true, send: (x: any) => sent.push(x), onFrame: () => () => {} } as any, e2e);
    await m.backfillE2E("01K0MISSINGWIRE00000000001", undefined, "enable");
    expect(sent.at(-1)).toMatchObject({
      t: "e2e_backfill",
      hermesSessionId: "01K0MISSINGWIRE00000000001",
      found: false,
    });
    expect(sent.at(-1)).not.toHaveProperty("session");
  });

  it("文件存在但無已結算消息 → found:false；disable 保留 K_S", async () => {
    const e2e = freshStore();
    const dev = device();
    e2e.wrapForDevices(SID, [{ deviceId: dev.deviceId, pubKey: dev.pubKey }]);
    const cfg = mkdtempSync(join(tmpdir(), "cc-e2e-title-only-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(cfg, "projects", "-x"), { recursive: true });
    writeFileSync(
      join(cfg, "projects", "-x", `${SID}.jsonl`),
      JSON.stringify({ type: "custom-title", sessionId: SID, customTitle: "只有標題" }) + "\n",
    );
    const { Mirror } = await import("../src/cc/mirror");
    const sent: any[] = [];
    const m = new Mirror({ agentLinkId: "AL", isReady: true, send: (x: any) => sent.push(x), onFrame: () => () => {} } as any, e2e);

    await m.backfillE2E(SID, SID, "disable");

    expect(sent.at(-1)).toMatchObject({ t: "e2e_backfill", mode: "disable", found: false });
    expect(sent.at(-1)).not.toHaveProperty("session");
    expect(e2e.isE2E(SID)).toBe(true);
  });
});
