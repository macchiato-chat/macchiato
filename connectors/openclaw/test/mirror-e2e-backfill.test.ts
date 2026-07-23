/** §19 D2：轉換已有會話為 E2E → Mirror.backfillE2E 全量歷史重加密回灌。 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCommittedE2EBackfillResult, Mirror, keyForSid, srcIdFor } from "../src/openclaw/mirror";
import { E2EKeyStore } from "../src/e2e/keys";
import { e2eControlKeyId, type E2EControlEnvelopeV1 } from "../src/e2e/control";

const SID = "01ABCDEF"; // server ULID（大寫）；OpenClaw key 為小寫 macchiato 前綴
const KEY = keyForSid(SID);

function disableIntent(key: Buffer): E2EControlEnvelopeV1 {
  return {
    v: 1,
    sessionId: `public-${SID}`,
    hermesSessionId: SID,
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

function line(role: string, text: string, ts: number): string {
  return JSON.stringify({ type: "message", timestamp: ts, message: { role, content: [{ type: "text", text }], timestamp: ts } });
}

describe("Mirror.backfillE2E（§19 D2 歷史重加密回灌）", () => {
  let dir: string;
  let sent: any[];
  let store: E2EKeyStore;
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "occ-bf-"));
    envBackup.OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
    envBackup.MACCHIATO_OPENCLAW_MIRROR = process.env.MACCHIATO_OPENCLAW_MIRROR;
    process.env.OPENCLAW_STATE_DIR = join(dir, ".openclaw");
    process.env.MACCHIATO_OPENCLAW_MIRROR = join(dir, "mirror.json");
    mkdirSync(join(dir, ".openclaw/agents/main/sessions"), { recursive: true });
    sent = [];
    store = new E2EKeyStore(join(dir, "e2e.json"));
  });
  afterEach(() => {
    process.env.OPENCLAW_STATE_DIR = envBackup.OPENCLAW_STATE_DIR;
    process.env.MACCHIATO_OPENCLAW_MIRROR = envBackup.MACCHIATO_OPENCLAW_MIRROR;
    rmSync(dir, { recursive: true, force: true });
  });

  function makeMirror(sessions: any[]): Mirror {
    const gw = { sessionsList: async () => ({ sessions }) } as any;
    const linkb = { isReady: true, agentLinkId: "al1", send: (m: any) => sent.push(m) } as any;
    writeFileSync(
      process.env.MACCHIATO_OPENCLAW_MIRROR!,
      JSON.stringify({
        offsets: {},
        missingAt: {},
        tombstones: [],
        fileIds: {},
        fileIdAliases: {},
        aliasHistoryTrusted: true,
      }),
    );
    const mirror = new Mirror(gw, linkb, store);
    mirror.setDriveIdentityResolver((identity) => (identity === KEY ? SID : undefined), () => true);
    return mirror;
  }

  it("全量歷史加密回灌 + 水位線推到快照末（防重複追加）", async () => {
    const file = join(dir, ".openclaw/agents/main/sessions/S1.jsonl");
    const content = line("user", "舊明文提問", 1) + "\n" + line("assistant", "舊回覆", 2) + "\n";
    writeFileSync(file, content);
    store.createForEnable(SID);
    const mirror = makeMirror([{ key: KEY, sessionId: "S1", displayName: "My chat" }]);
    await mirror.backfillE2E(SID);

    const bf = sent.filter((m) => m.t === "e2e_backfill");
    expect(bf).toHaveLength(1);
    expect(bf[0].found).toBe(true);
    expect(bf[0].hermesSessionId).toBe(SID);
    const entry = bf[0].session;
    expect(entry.e2e).toBe(true);
    expect(entry.messages).toHaveLength(2);
    expect(entry.messages.map((m: any) => m.srcId)).toEqual([
      srcIdFor({ role: "user", text: "舊明文提問", createdAt: 1 }),
      srcIdFor({ role: "agent", text: "舊回覆", createdAt: 2 }),
    ]);
    for (const m of entry.messages) {
      expect(m.enc).toBeTruthy();
      expect(m.text).toBeUndefined(); // 不洩明文
    }
    // K_S 按 server sid 鍵控（iOS 持同一把可解）
    expect((store.decryptContent(SID, entry.messages[0].enc) as any).text).toBe("舊明文提問");
    expect(store.decryptText(SID, entry.title)).toBe("My chat");
    // send 不等于 server 提交；ACK 前绝不推进水位线。
    expect((mirror as any).state.offsets[KEY]).toBeUndefined();
    mirror.handleE2EBackfillResult(SID, "enable", true);
    expect((mirror as any).state.offsets[KEY]).toBe(Buffer.byteLength(content));
  });

  it("找不到會話 / 無消息 → found:false、不帶 session、不動水位線", async () => {
    const mirror = makeMirror([]);
    await mirror.backfillE2E(SID);
    expect(sent).toHaveLength(1);
    expect(sent[0].t).toBe("e2e_backfill");
    expect(sent[0].found).toBe(false);
    expect(sent[0].session).toBeUndefined();
    expect((mirror as any).state.offsets[KEY]).toBeUndefined();
  });

  it("關閉（mode=disable）：明文回灌后等 ACK 才刪 K_S / 推水位線", async () => {
    const file = join(dir, ".openclaw/agents/main/sessions/S1.jsonl");
    const content = line("user", "提問", 1) + "\n" + line("assistant", "回覆", 2) + "\n";
    writeFileSync(file, content);
    const key = store.getOrCreateKey(SID); // 會話已 E2E
    store.beginDisable(SID, disableIntent(key));
    const mirror = makeMirror([{ key: KEY, sessionId: "S1", displayName: "My chat" }]);
    await mirror.backfillE2E(SID, "disable");

    const bf = sent.filter((m) => m.t === "e2e_backfill");
    expect(bf).toHaveLength(1);
    expect(bf[0].mode).toBe("disable");
    expect(bf[0].found).toBe(true);
    const entry = bf[0].session;
    expect(entry.e2e).toBeUndefined(); // 明文回灌：無 e2e 標記
    expect(entry.title).toBe("My chat");
    expect(entry.messages.map((m: any) => m.text)).toEqual(["提問", "回覆"]);
    expect(entry.messages.map((m: any) => m.srcId)).toEqual([
      srcIdFor({ role: "user", text: "提問", createdAt: 1 }),
      srcIdFor({ role: "agent", text: "回覆", createdAt: 2 }),
    ]);
    for (const m of entry.messages) expect(m.enc).toBeUndefined();
    expect(store.isE2E(SID)).toBe(true); // ACK 前 K_S 必須保留
    expect((mirror as any).state.offsets[KEY]).toBeUndefined();

    mirror.handleE2EBackfillResult(SID, "disable", true);
    store.completeDisable(SID, bf[0].disableReceipt);
    expect(store.isE2E(SID)).toBe(false);
    expect((mirror as any).state.offsets[KEY]).toBe(Buffer.byteLength(content));
  });

  it("disable 被 server 拒绝时保留 K_S 且不推进水位线", async () => {
    const file = join(dir, ".openclaw/agents/main/sessions/S1.jsonl");
    writeFileSync(file, line("user", "提問", 1) + "\n");
    const key = store.createForEnable(SID);
    store.beginDisable(SID, disableIntent(key));
    const mirror = makeMirror([{ key: KEY, sessionId: "S1", displayName: "My chat" }]);
    await mirror.backfillE2E(SID, "disable");
    mirror.handleE2EBackfillResult(SID, "disable", false);
    expect(store.isE2E(SID)).toBe(true);
    expect((mirror as any).state.offsets[KEY]).toBeUndefined();
  });

  it("ACK 前 fastForward/poll 都不能旁路推进该会话水位线", async () => {
    const file = join(dir, ".openclaw/agents/main/sessions/S1.jsonl");
    const initial = line("user", "提問", 1) + "\n";
    writeFileSync(file, initial);
    store.createForEnable(SID);
    const mirror = makeMirror([{ key: KEY, sessionId: "S1", displayName: "My chat" }]);
    mirror.setDriven(KEY, SID);
    await mirror.backfillE2E(SID);

    writeFileSync(file, initial + line("assistant", "ACK 前尾巴", 2) + "\n");
    mirror.fastForward(KEY);
    await (mirror as any).pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((mirror as any).state.offsets[KEY]).toBeUndefined();

    mirror.handleE2EBackfillResult(SID, "enable", true);
    expect((mirror as any).state.offsets[KEY]).toBe(Buffer.byteLength(initial));
  });

  it.each([
    ["enable", true, true, true],
    ["enable", true, false, false],
    ["enable", false, true, false],
    ["enable", false, false, false],
    ["disable", true, false, true],
    ["disable", true, true, false],
    ["disable", false, false, false],
    ["disable", false, true, false],
  ] as const)("严格校验 backfill ACK tuple：%s/%s/%s → %s", (mode, ok, e2e, expected) => {
    expect(isCommittedE2EBackfillResult(mode, ok, e2e)).toBe(expected);
  });

  it("關閉但找不到會話 → found:false、K_S 保留（關閉失敗保持加密）", async () => {
    store.getOrCreateKey(SID);
    const mirror = makeMirror([]);
    await mirror.backfillE2E(SID, "disable");
    expect(sent[0].mode).toBe("disable");
    expect(sent[0].found).toBe(false);
    expect(store.isE2E(SID)).toBe(true); // K_S 保留
  });
});
