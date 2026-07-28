/**
 * #348 / F-10 OpenClaw durable mirror：ACK 後才推水位、nack 終態 code、斷線同 batchId 重放。
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mirror } from "../src/openclaw/mirror";

const KEY = "agent:main:discord:channel:durable";
const FILE_ID = "dddddddd-0000-4000-8000-0000000000d1";

function msg(text: string, i = 0): string {
  return (
    JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: 1000 + i,
      },
    }) + "\n"
  );
}

function setup(opts?: { seedOffset?: number }) {
  const stateDir = mkdtempSync(join(tmpdir(), "oc-dur-"));
  const mirrorPath = join(stateDir, "mirror.json");
  process.env.MACCHIATO_OPENCLAW_MIRROR = mirrorPath;
  process.env.OPENCLAW_STATE_DIR = join(stateDir, "openclaw");
  const dir = join(stateDir, "openclaw", "agents/main/sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${FILE_ID}.jsonl`);
  if (opts?.seedOffset !== undefined) {
    writeFileSync(
      mirrorPath,
      JSON.stringify({
        offsets: { [KEY]: opts.seedOffset },
        fileIds: { [KEY]: FILE_ID },
        fileIdAliases: { [KEY]: [FILE_ID] },
        aliasHistoryTrusted: true,
        pendingMirrors: [],
      }),
    );
  }
  const sent: any[] = [];
  const linkb: any = {
    agentLinkId: "al-dur",
    isReady: true,
    send: (m: any) => sent.push(m),
    onFrame: () => () => {},
  };
  const gw: any = {
    sessionsList: async () => ({
      sessions: [{ key: KEY, sessionId: FILE_ID, displayName: "discord:1#d", channel: "discord" }],
    }),
  };
  const mirror = new Mirror(gw, linkb);
  return { mirror, file, sent, mirrorPath, linkb };
}

const appends = (sent: any[]) => sent.filter((f) => f.t === "mirror_append");

describe("#348 / F-10 OpenClaw durable outbox", () => {
  it("ACK 前 offset 不動；handleAck 後提交", async () => {
    const { mirror, file, sent } = setup({ seedOffset: 0 });
    writeFileSync(file, msg("wait-ack"));
    await (mirror as any).pollOnce();
    const batch = appends(sent)[0] as any;
    expect((mirror as any).state.offsets[KEY]).toBe(0);
    expect((mirror as any).state.pendingMirrors).toHaveLength(1);
    mirror.handleAck(batch.batchId);
    expect((mirror as any).state.offsets[KEY]).toBeGreaterThan(0);
    expect((mirror as any).state.pendingMirrors).toHaveLength(0);
  });

  it("重啟後 durable outbox 原 batchId 重放", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "oc-dur2-"));
    const mirrorPath = join(stateDir, "mirror.json");
    process.env.MACCHIATO_OPENCLAW_MIRROR = mirrorPath;
    process.env.OPENCLAW_STATE_DIR = join(stateDir, "openclaw");
    const dir = join(stateDir, "openclaw", "agents/main/sessions");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${FILE_ID}.jsonl`);
    writeFileSync(file, msg("replay-me"));
    writeFileSync(
      mirrorPath,
      JSON.stringify({
        offsets: { [KEY]: 0 },
        fileIds: { [KEY]: FILE_ID },
        fileIdAliases: { [KEY]: [FILE_ID] },
        aliasHistoryTrusted: true,
      }),
    );

    const sent1: any[] = [];
    const linkb1: any = {
      agentLinkId: "al",
      isReady: true,
      send: (m: any) => sent1.push(m),
      onFrame: () => () => {},
    };
    const gw: any = {
      sessionsList: async () => ({
        sessions: [{ key: KEY, sessionId: FILE_ID, displayName: "x", channel: "discord" }],
      }),
    };
    const m1 = new Mirror(gw, linkb1);
    await (m1 as any).pollOnce();
    const original = appends(sent1)[0] as any;
    expect(original.batchId).toBeTruthy();
    expect((m1 as any).state.offsets[KEY]).toBe(0);

    const sent2: any[] = [];
    const linkb2: any = {
      agentLinkId: "al",
      isReady: true,
      send: (m: any) => sent2.push(m),
      onFrame: () => () => {},
    };
    const m2 = new Mirror(gw, linkb2);
    await (m2 as any).pollOnce(); // sentBatchAt 空 → 立刻重放
    const replay = appends(sent2)[0] as any;
    expect(replay.batchId).toBe(original.batchId);
    expect(replay.sessions).toEqual(original.sessions);
    expect((m2 as any).state.offsets[KEY]).toBe(0);
    m2.handleAck(replay.batchId);
    expect((m2 as any).state.offsets[KEY]).toBeGreaterThan(0);
  });

  it("同 key 亂序 ACK 不越过前序未 ACK 批", () => {
    const { mirror } = setup({ seedOffset: 0 });
    // 直接注入兩批 pending（BATCH_MAX 是模組載入常量，測試內改 env 無效）
    const b0 = "batch-first";
    const b1 = "batch-second";
    (mirror as any).state.pendingMirrors = [
      {
        batchId: b0,
        key: KEY,
        endOffset: 50,
        frame: { t: "mirror_append", batchId: b0, sessions: [{ hermesSessionId: KEY, messages: [{ text: "a" }] }] },
      },
      {
        batchId: b1,
        key: KEY,
        endOffset: 100,
        frame: { t: "mirror_append", batchId: b1, sessions: [{ hermesSessionId: KEY, messages: [{ text: "b" }] }] },
      },
    ];

    mirror.handleAck(b1);
    expect((mirror as any).state.offsets[KEY]).toBe(0); // 前序未 ACK
    expect((mirror as any).state.pendingMirrors).toHaveLength(2);
    expect((mirror as any).state.pendingMirrors[1].acked).toBe(true);

    mirror.handleNack(b0); // 無 code → 保留 outbox
    expect((mirror as any).state.offsets[KEY]).toBe(0);
    expect((mirror as any).state.pendingMirrors).toHaveLength(2);

    mirror.handleAck(b0);
    // 隊首 ACK 後連續提交已 acked 的後批
    expect((mirror as any).state.pendingMirrors).toHaveLength(0);
    expect((mirror as any).state.offsets[KEY]).toBe(100);
  });

  it("e2e_direction:丟棄該 key 全部凍結批、水位回退重讀", async () => {
    const { mirror, file, sent } = setup({ seedOffset: 0 });
    writeFileSync(file, msg("plain-before-e2e"));
    await (mirror as any).pollOnce();
    const first = appends(sent)[0] as any;
    expect((mirror as any).state.pendingMirrors).toHaveLength(1);

    mirror.handleNack(first.batchId, "e2e direction mismatch", "e2e_direction");
    expect((mirror as any).state.pendingMirrors).toHaveLength(0);
    expect((mirror as any).state.offsets[KEY] ?? 0).toBe(0);
    expect(mirror.counters.mirrorDirectionRewinds).toBe(1);

    const before = appends(sent).length;
    await (mirror as any).pollOnce();
    const again = appends(sent).slice(before) as any[];
    expect(again).toHaveLength(1);
    expect(again[0].batchId).not.toBe(first.batchId);
    expect(again[0].sessions[0].messages[0].text).toBe("plain-before-e2e");
  });

  it("malformed:丟批並跳過該段,水位前進,lastError 留給 health", async () => {
    const { mirror, file, sent } = setup({ seedOffset: 0 });
    writeFileSync(file, msg("poison"));
    await (mirror as any).pollOnce();
    const first = appends(sent)[0] as any;
    mirror.handleNack(first.batchId, "sessions too large", "malformed");
    expect((mirror as any).state.pendingMirrors).toHaveLength(0);
    expect((mirror as any).state.offsets[KEY]).toBeGreaterThan(0);
    expect(mirror.counters.mirrorDropped).toBe(1);
    expect(mirror.lastError).toBe("sessions too large");
  });

  it("無 code(舊 server)仍是保留重發語義", async () => {
    const { mirror, file, sent } = setup({ seedOffset: 0 });
    writeFileSync(file, msg("transient"));
    await (mirror as any).pollOnce();
    const first = appends(sent)[0] as any;
    mirror.handleNack(first.batchId, "mirror transaction failed");
    expect((mirror as any).state.pendingMirrors).toHaveLength(1);
    expect((mirror as any).state.offsets[KEY]).toBe(0);
  });

  it("lastError 不被下一輪 poll 抹掉:仍有卡住的待確認批就一直報錯", async () => {
    const { mirror, file, sent } = setup({ seedOffset: 0 });
    writeFileSync(file, msg("sticky-err"));
    await (mirror as any).poll();
    const first = appends(sent)[0] as any;
    mirror.handleNack(first.batchId, "mirror transaction failed");
    expect(mirror.lastError).toBe("mirror transaction failed");
    await (mirror as any).poll();
    expect(mirror.lastError).toBe("mirror transaction failed");
    mirror.handleAck(first.batchId);
    await (mirror as any).poll();
    expect(mirror.lastError).toBeNull();
  });

  it("狀態檔 0600(裡面裝完整正文);.bak 同權限", async () => {
    const { mirror, file, mirrorPath } = setup({ seedOffset: 0 });
    writeFileSync(file, msg("body-in-state"));
    await (mirror as any).pollOnce();
    await (mirror as any).pollOnce(); // 觸發 .bak
    const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8);
    expect(mode(mirrorPath)).toBe("600");
    if (existsSync(`${mirrorPath}.bak`)) {
      expect(mode(`${mirrorPath}.bak`)).toBe("600");
    }
  });

  it("未 ACK 再 poll 不重複編批(pendingOffset)", async () => {
    const { mirror, file, sent } = setup({ seedOffset: 0 });
    writeFileSync(file, msg("once"));
    await (mirror as any).pollOnce();
    expect(appends(sent)).toHaveLength(1);
    await (mirror as any).pollOnce(); // <15s 不重放、也不新編
    expect(appends(sent)).toHaveLength(1);
  });
});
