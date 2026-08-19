/**
 * #949 鏡像側：派生會話（子 agent / cron / hook / node / 未知 kind）不成為用戶列表裡的一條會話，
 * 而頂層會話、app 驅動會話、E2E 會話、以及「已經鏡像過的」會話一條都不許被誤傷。
 *
 * 判別方式有兩個，互相印證：
 *  - 有沒有真的發出 `mirror_append`（用戶列表裡會不會多一條）
 *  - 有沒有給這個 key 記下水位線 —— 被過濾的 key 整條 `continue`，連 baseline 都不會落。
 */
import { describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mirror } from "../src/openclaw/mirror";

function line(text: string, i = 0): string {
  return (
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text }], timestamp: 1000 + i },
    }) + "\n"
  );
}

type Row = Record<string, unknown> & { key: string; sessionId: string };

function setup(
  rows: Row[],
  opts?: {
    offsets?: Record<string, number>;
    e2eKeys?: string[];
    /** 真正持鑰 / 被 server 標保護的 key（默認 = e2eKeys，與真 keystore 一致）。
     *  只出現在 `e2eKeys` 而不在這裡的，模擬「別名繼承來的 E2E」（父會話是 E2E）。 */
    protectedKeys?: string[];
    /** 老 schema：別名歷史不可信 —— E2E 一律維持 #949 的老路徑。 */
    aliasHistoryTrusted?: boolean;
  },
) {
  const stateDir = mkdtempSync(join(tmpdir(), "oc-origin-"));
  const mirrorPath = join(stateDir, "mirror.json");
  process.env.MACCHIATO_OPENCLAW_MIRROR = mirrorPath;
  process.env.OPENCLAW_STATE_DIR = join(stateDir, "openclaw");
  const dir = join(stateDir, "openclaw", "agents/main/sessions");
  mkdirSync(dir, { recursive: true });
  // 每條會話都先寫滿內容 —— 沒被過濾掉的話一定會發出來。
  for (const r of rows) writeFileSync(join(dir, `${r.sessionId}.jsonl`), line(`hi ${r.key}`));
  writeFileSync(
    mirrorPath,
    JSON.stringify({
      offsets: opts?.offsets ?? {},
      fileIds: Object.fromEntries(rows.map((r) => [r.key, r.sessionId])),
      fileIdAliases: Object.fromEntries(rows.map((r) => [r.key, [r.sessionId]])),
      aliasHistoryTrusted: opts?.aliasHistoryTrusted ?? true,
      pendingMirrors: [],
    }),
  );
  const sent: any[] = [];
  const linkb: any = { agentLinkId: "al-origin", isReady: true, send: (m: any) => sent.push(m) };
  const gw: any = { sessionsList: async () => ({ sessions: rows }) };
  const e2eKeys = new Set(opts?.e2eKeys ?? []);
  const protectedKeys = opts?.protectedKeys ?? opts?.e2eKeys ?? [];
  const e2e: any = opts?.e2eKeys
    ? {
        isE2E: (id: string) => e2eKeys.has(id),
        protectedSessionIds: () => [...protectedKeys],
        hasServerStateSnapshot: () => true,
        encryptText: (_sid: string, t: string) => `enc:${t}`,
        encryptContent: (_sid: string, c: unknown) => ({ enc: c }),
      }
    : undefined;
  const mirror = new Mirror(gw, linkb, e2e);
  /** 新 key 首輪只落 baseline；追加一行再 poll 一輪，可見的那些就會真的發出來。 */
  const pollWithNewContent = async () => {
    await (mirror as any).pollOnce();
    for (const r of rows) appendFileSync(join(dir, `${r.sessionId}.jsonl`), line(`more ${r.key}`, 1));
    await (mirror as any).pollOnce();
  };
  return { mirror, sent, dir, pollWithNewContent };
}

/** 被當成用戶會話發出去的 key。 */
const mirrored = (sent: any[]): string[] => [
  ...new Set(
    sent
      .filter((f) => f.t === "mirror_append")
      .flatMap((f) => (f.sessions as any[]).map((s) => s.hermesSessionId as string)),
  ),
];
const watermarked = (mirror: Mirror): string[] => Object.keys((mirror as any).state.offsets);

const TOP = {
  key: "agent:main:discord:channel:123",
  sessionId: "aaaaaaaa-0000-4000-8000-00000000aaaa",
  kind: "group",
};

describe("#949 鏡像過濾派生會話", () => {
  it("子 agent 不建會話，頂層會話照發", async () => {
    const { mirror, sent, pollWithNewContent } = setup([
      TOP,
      {
        key: "agent:main:subagent:child-1",
        sessionId: "bbbbbbbb-0000-4000-8000-00000000bbbb",
        kind: "direct",
        parentSessionKey: TOP.key,
      },
    ]);
    await pollWithNewContent();
    expect(mirrored(sent)).toEqual([TOP.key]);
    expect(watermarked(mirror)).toEqual([TOP.key]);
    expect(mirror.counters.mirrorDerivedSkipped).toBe(2); // 兩輪 poll 各記一次
  });

  it("cron / hook / node / heartbeat 全部不建會話", async () => {
    const rows: Row[] = [
      TOP,
      { key: "agent:main:cron:daily:run:1", sessionId: "cccccccc-0000-4000-8000-00000000c001", kind: "direct" },
      { key: "agent:main:hook:webhook:9", sessionId: "cccccccc-0000-4000-8000-00000000c002", kind: "direct" },
      { key: "agent:main:node:mini:talk:3", sessionId: "cccccccc-0000-4000-8000-00000000c003", kind: "direct" },
      { key: "agent:main:heartbeat", sessionId: "cccccccc-0000-4000-8000-00000000c004", kind: "direct" },
    ];
    const { mirror, sent, pollWithNewContent } = setup(rows);
    await pollWithNewContent();
    expect(mirrored(sent)).toEqual([TOP.key]);
    expect(watermarked(mirror)).toEqual([TOP.key]);
  });

  it("未知 kind → 隔離 + 打點，不建新會話", async () => {
    const { mirror, sent, pollWithNewContent } = setup([
      TOP,
      { key: "agent:main:swarm:node-7", sessionId: "dddddddd-0000-4000-8000-00000000dddd", kind: "swarm" },
    ]);
    await pollWithNewContent();
    expect(mirrored(sent)).toEqual([TOP.key]);
    expect(watermarked(mirror)).toEqual([TOP.key]);
    expect(mirror.counters.mirrorQuarantined).toBe(2);
    expect(mirror.counters.mirrorDerivedSkipped).toBe(0);
  });

  it("隔離只擋新 key：已經有水位線的會話照舊更新（不靜默停更）", async () => {
    const known = { key: "agent:main:swarm:node-7", sessionId: "dddddddd-0000-4000-8000-00000000dddd", kind: "swarm" };
    const { mirror, sent } = setup([known], { offsets: { [known.key]: 0 } });
    await (mirror as any).pollOnce();
    expect(mirrored(sent)).toEqual([known.key]);
    expect(mirror.counters.mirrorQuarantined).toBe(0);
  });

  it("形狀上就是派生的不吃「已鏡像過」的例外——它從來就不是一段對話", async () => {
    const sub = { key: "agent:main:subagent:child-1", sessionId: "bbbbbbbb-0000-4000-8000-00000000bbbb", kind: "direct" };
    const { mirror, sent } = setup([sub], { offsets: { [sub.key]: 0 } });
    await (mirror as any).pollOnce();
    expect(mirrored(sent)).toEqual([]);
    expect(mirror.counters.mirrorDerivedSkipped).toBe(1);
  });

  it("kind 缺席（老 gateway）行為一個字不變", async () => {
    const rows: Row[] = [
      { key: "agent:main:discord:channel:123", sessionId: "aaaaaaaa-0000-4000-8000-00000000aaaa" },
      { key: "agent:main:telegram:direct:7", sessionId: "eeeeeeee-0000-4000-8000-00000000eeee" },
    ];
    const { mirror, sent, pollWithNewContent } = setup(rows);
    await pollWithNewContent();
    expect(mirrored(sent).sort()).toEqual(rows.map((r) => r.key).sort());
    expect(mirror.counters.mirrorDerivedSkipped).toBe(0);
    expect(mirror.counters.mirrorQuarantined).toBe(0);
  });

  it("自己就是一條 E2E 會話 → 永不隱藏（K_S 按 hermesSessionId 存，藏掉就是靜默停更）", async () => {
    const odd = { key: "agent:main:swarm:node-7", sessionId: "dddddddd-0000-4000-8000-00000000dddd", kind: "swarm" };
    const { mirror, sent, pollWithNewContent } = setup([odd], { e2eKeys: [odd.key] });
    await pollWithNewContent();
    expect(mirrored(sent)).toEqual([odd.key]);
    expect(mirror.counters.mirrorQuarantined).toBe(0);
  });

  it("#968 放開：父會話是 E2E 不再連帶豁免它的子線程（#592 的復發路徑）", async () => {
    const sub = {
      key: "agent:main:subagent:child-1",
      sessionId: "bbbbbbbb-0000-4000-8000-00000000bbbb",
      kind: "direct",
      parentSessionKey: TOP.key,
    };
    const { mirror, sent, pollWithNewContent } = setup([TOP, sub], {
      // 父持鑰；子線程只是「別名認親」認出來的 E2E（keystore 的 aliasProtected），自己沒有鑰匙。
      e2eKeys: [TOP.key, sub.key],
      protectedKeys: [TOP.key],
    });
    await pollWithNewContent();
    expect(mirrored(sent)).toEqual([TOP.key]);
    expect(mirror.counters.mirrorDerivedSkipped).toBe(2);
  });

  it("#968 fail-closed：別名歷史不可信 → E2E 整體維持 #949 的老路徑", async () => {
    const sub = {
      key: "agent:main:subagent:child-1",
      sessionId: "bbbbbbbb-0000-4000-8000-00000000bbbb",
      kind: "direct",
      parentSessionKey: TOP.key,
    };
    const { mirror, sent, pollWithNewContent } = setup([TOP, sub], {
      e2eKeys: [TOP.key, sub.key],
      protectedKeys: [TOP.key],
      aliasHistoryTrusted: false, // 老 schema：證明不了身份歷史 → 一個字都不敢改
    });
    await pollWithNewContent();
    expect(mirrored(sent).sort()).toEqual([TOP.key, sub.key].sort());
    expect(mirror.counters.mirrorDerivedSkipped).toBe(0);
  });

  it("app 驅動的 macchiato 會話永不被隱藏（哪怕 gateway 給了未知 kind）", async () => {
    const driven = { key: "agent:main:macchiato:01hxyz", sessionId: "ffffffff-0000-4000-8000-00000000ffff", kind: "swarm" };
    const { mirror, pollWithNewContent } = setup([driven]);
    await pollWithNewContent();
    // driven 走 salvage 路徑（正文由 live 投遞，不再 append）：關鍵是它沒被 #949 的過濾整條跳掉，
    // 水位線照常記——被隱藏的 key 連 offsets 這一條都不會有。
    expect(watermarked(mirror)).toEqual([driven.key]);
    expect(mirror.counters.mirrorQuarantined).toBe(0);
    expect(mirror.counters.mirrorDerivedSkipped).toBe(0);
  });

  it("#968 mirror_append 帶上血緣：頂層會話 root/declared，身份不變", async () => {
    const { sent, pollWithNewContent } = setup([TOP]);
    await pollWithNewContent();
    const session = sent.find((f) => f.t === "mirror_append").sessions[0];
    expect(session.hermesSessionId).toBe(TOP.key);
    expect(session.origin).toEqual({
      threadId: TOP.key,
      conversationId: TOP.key,
      kind: "root",
      evidence: "declared",
    });
  });

  it("#968 老 gateway 沒有 kind → evidence:absent（server 據此走老行為，不倒退）", async () => {
    const row = { key: "agent:main:telegram:direct:7", sessionId: "eeeeeeee-0000-4000-8000-00000000eeee" };
    const { sent, pollWithNewContent } = setup([row]);
    await pollWithNewContent();
    const session = sent.find((f) => f.t === "mirror_append").sessions[0];
    expect(session.origin).toMatchObject({ kind: "root", evidence: "absent" });
  });

  it("#968 E2E 會話一樣上報血緣（元數據非正文，明文不出去）", async () => {
    const { sent, pollWithNewContent } = setup([TOP], { e2eKeys: [TOP.key] });
    await pollWithNewContent();
    const session = sent.find((f) => f.t === "mirror_append").sessions[0];
    expect(session.e2e).toBe(true);
    expect(session.origin).toMatchObject({ threadId: TOP.key, kind: "root" });
    // 正文仍是密文——血緣不是給明文開的口子。
    expect(session.messages[0].text).toBeUndefined();
  });

  it("日誌只吼一次：多輪 poll 不刷屏（計數照樣每輪累加）", async () => {
    const { mirror } = setup([
      { key: "agent:main:subagent:child-1", sessionId: "bbbbbbbb-0000-4000-8000-00000000bbbb", kind: "direct" },
    ]);
    await (mirror as any).pollOnce();
    await (mirror as any).pollOnce();
    expect((mirror as any).loggedDerived.size).toBe(1);
    expect(mirror.counters.mirrorDerivedSkipped).toBe(2);
  });
});
