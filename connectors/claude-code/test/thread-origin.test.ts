/**
 * #967（父 #926）claude-code：上報 `ThreadOrigin` + 接上 `ThreadRegistry` + 放開 E2E 身份歸屬。
 *
 * 三件事各自的驗收：
 *  1. **上報事實**：每批 `mirror_append` 帶 `origin`（`threadId`/`conversationId` = 這批消息實際
 *     掛的那條對話，`kind:"root"`，`evidence` 來自 `lineage.ts`）；連對話指紋都取不到的
 *     （`absent`）**不帶**——server 對「沒帶」與「absent」都走老行為，少發一個字段更誠實。
 *  2. **別名表下沉**：歸屬記進 `connector-core` 的 `ThreadRegistry`，隨鏡像狀態檔落盤、跨重啟；
 *     #947 的 `origins[sid].parent` 鏈一次性遷移過去。
 *  3. **E2E 放開**：判據嚴格照 #347 —— `aliasHistoryTrusted` 只認顯式 `true`；不可信時維持舊
 *     身份（fail-closed），**絕不因為查不到就新生成 K_S**。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mirror, discoverSessions } from "../src/cc/mirror";
import { collectImportSessions } from "../src/cc/history-import";
import { resetLineageMemo } from "../src/cc/lineage";

let seq = 0;
const uuid = (): string => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
};

interface Line {
  uuid?: string;
  json: Record<string, unknown>;
}

function userLine(sid: string, text: string): Line {
  const u = uuid();
  return {
    uuid: u,
    json: {
      type: "user",
      uuid: u,
      parentUuid: null,
      sessionId: sid,
      cwd: "/w/proj",
      timestamp: "2026-08-14T10:00:00.000Z",
      message: { role: "user", content: text },
    },
  };
}

function assistantLine(sid: string, text: string): Line {
  const u = uuid();
  return {
    uuid: u,
    json: {
      type: "assistant",
      uuid: u,
      sessionId: sid,
      timestamp: "2026-08-14T10:00:01.000Z",
      message: { id: `msg-${u}`, role: "assistant", content: [{ type: "text", text }] },
    },
  };
}

const render = (lines: Line[]): string => lines.map((l) => JSON.stringify(l.json)).join("\n") + "\n";

/** 續接：父檔的行整段複製，sessionId 改寫成新檔自己的 id、uuid 原樣保留（實測形態）。 */
const continuationOf = (parentLines: Line[], childSid: string): Line[] =>
  parentLines.map((l) => ({ uuid: l.uuid, json: { ...l.json, sessionId: childSid } }));

function newProjectsRoot(state: Record<string, unknown> = { offsets: {}, titles: {}, seeded: true }): string {
  const cfg = mkdtempSync(join(tmpdir(), "cc-origin-"));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
  writeFileSync(process.env.MACCHIATO_CC_MIRROR, JSON.stringify(state));
  const proj = join(cfg, "projects", "-home-x-proj");
  mkdirSync(proj, { recursive: true });
  resetLineageMemo();
  return proj;
}

function fakeLinkb(): { linkb: any; frames: Record<string, any>[] } {
  const frames: Record<string, any>[] = [];
  return {
    linkb: {
      agentLinkId: "AL1",
      isReady: true,
      send: (m: Record<string, unknown>) => frames.push(m as Record<string, any>),
      onFrame: () => () => {},
    },
    frames,
  };
}

const appends = (frames: Record<string, any>[]): Record<string, any>[] =>
  frames.filter((f) => f.t === "mirror_append");
const sessionsOf = (frames: Record<string, any>[]): Record<string, any>[] =>
  appends(frames).map((f) => f.sessions[0]);

/** 可控的 keystore 替身：受保護會話集合可變，別名解析器由 Mirror 注入。 */
function fakeKeystore(protectedSids: Set<string>, snapshot = true) {
  const store = {
    aliases: null as null | ((sid: string) => readonly string[]),
    isE2E: (sid: string) => protectedSids.has(sid) || (store.aliases?.(sid) ?? []).some((a) => protectedSids.has(a)),
    encryptText: (_sid: string, text: string) => `enc:${text}`,
    encryptContent: () => "enc",
    protectedSessionIds: () => [...protectedSids],
    hasServerStateSnapshot: () => snapshot,
    setIdentityAliases: (resolve: ((sid: string) => readonly string[]) | null) => {
      store.aliases = resolve;
    },
  };
  return store;
}

const readState = (): any => JSON.parse(readFileSync(process.env.MACCHIATO_CC_MIRROR!, "utf8"));

beforeEach(() => {
  seq = 0;
});

describe("#967 ① mirror_append 帶上 ThreadOrigin", () => {
  it("頂層會話：origin.threadId / conversationId = 上報的身份，kind=root，evidence 來自血緣", () => {
    const proj = newProjectsRoot();
    const sid = "11110000-0000-4000-8000-000000000000";
    writeFileSync(join(proj, `${sid}.jsonl`), render([userLine(sid, "第一句"), assistantLine(sid, "回答")]));

    const { linkb, frames } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();

    const [session] = sessionsOf(frames);
    expect(session.hermesSessionId).toBe(sid);
    expect(session.origin).toEqual({
      threadId: sid,
      conversationId: sid,
      kind: "root",
      evidence: "declared",
    });
  });

  it("續接檔：正文接回父會話，origin 也隨之報成父會話那條對話（server 要求兩者一致）", () => {
    const proj = newProjectsRoot();
    const parent = "22220000-0000-4000-8000-000000000000";
    const base = [userLine(parent, "第一句"), assistantLine(parent, "回答")];
    writeFileSync(join(proj, `${parent}.jsonl`), render(base));
    const { linkb, frames } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();

    const child = "22220001-0000-4000-8000-000000000000";
    writeFileSync(
      join(proj, `${child}.jsonl`),
      render([...continuationOf(base, child), userLine(child, "續接後的新問題")]),
    );
    (m as any).doPoll();

    for (const s of sessionsOf(frames)) {
      expect(s.hermesSessionId).toBe(parent);
      // origin.threadId 必須 === hermesSessionId，否則 server 判成「連接器發了自相矛盾的
      // 元數據」→ 退回老行為，這份上報等於白發。
      expect(s.origin.threadId).toBe(s.hermesSessionId);
      expect(s.origin.conversationId).toBe(parent);
      expect(s.origin.kind).toBe("root");
    }
  });

  it("連對話指紋都取不到（evidence=absent）→ 不帶 origin，server 走老行為", () => {
    const proj = newProjectsRoot();
    const sid = "33330000-0000-4000-8000-000000000000";
    // 沒有 uuid、沒有 leafUuid：解析得出消息但一個指紋都沒有。
    const line = { type: "user", sessionId: sid, message: { role: "user", content: "沒有 uuid 的老格式" } };
    writeFileSync(join(proj, `${sid}.jsonl`), `${JSON.stringify(line)}\n`);

    const { linkb, frames } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();

    const [session] = sessionsOf(frames);
    expect(session.hermesSessionId).toBe(sid);
    expect(session.origin).toBeUndefined();
    expect((m as any).counters.mirrorOriginsAbsent).toBeGreaterThan(0);
  });

  it("E2E 會話照樣帶 origin（是元數據不是正文，密文之外唯一還能做歸屬判定的憑據）", () => {
    const proj = newProjectsRoot();
    const sid = "44440000-0000-4000-8000-000000000000";
    writeFileSync(join(proj, `${sid}.jsonl`), render([userLine(sid, "秘密"), assistantLine(sid, "回答")]));

    const { linkb, frames } = fakeLinkb();
    const m = new Mirror(linkb, fakeKeystore(new Set([sid])) as any);
    (m as any).doPoll();

    const [session] = sessionsOf(frames);
    expect(session.e2e).toBe(true);
    expect(session.title.startsWith("enc:")).toBe(true); // 標題盲存
    expect(session.origin).toMatchObject({ threadId: sid, conversationId: sid, kind: "root" });
  });
});

describe("#967 ② 身份/別名狀態搬到 connector-core 的 ThreadRegistry", () => {
  it("歸屬落進 state.registry 並跨重啟生效（重啟後續接照樣接回父會話）", () => {
    const proj = newProjectsRoot();
    const parent = "55550000-0000-4000-8000-000000000000";
    const base = [userLine(parent, "第一句"), assistantLine(parent, "回答")];
    writeFileSync(join(proj, `${parent}.jsonl`), render(base));
    const child = "55550001-0000-4000-8000-000000000000";
    writeFileSync(
      join(proj, `${child}.jsonl`),
      render([...continuationOf(base, child), userLine(child, "續接")]),
    );

    const { linkb } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).resolveNewOrigins(discoverSessions());
    expect((m as any).identitySid(child)).toBe(parent);

    const persisted = readState();
    // 首次確立的身份排在最前（I2：上報與 K_S 都錨在它上面）。
    expect(persisted.registry.threads[parent]).toEqual([parent, child]);
    expect(persisted.registry.aliasHistoryTrusted).toBe(false); // 沒有 keystore 作證 → 不可信

    const restarted = new Mirror(fakeLinkb().linkb);
    expect((restarted as any).identitySid(child)).toBe(parent);
  });

  it("遷移 #947 舊狀態檔：origins[sid].parent 鏈搬進 registry，之後不再有第二個真源", () => {
    const parent = "66660000-0000-4000-8000-000000000000";
    const child = "66660001-0000-4000-8000-000000000000";
    const proj = newProjectsRoot({
      offsets: { [parent]: 0, [child]: 0 },
      titles: {},
      seeded: true,
      origins: { [parent]: { evidence: "declared" }, [child]: { parent, evidence: "declared" } },
      heads: { "u:whatever": parent },
    });
    writeFileSync(join(proj, `${parent}.jsonl`), render([userLine(parent, "第一句")]));

    const { linkb } = fakeLinkb();
    const m = new Mirror(linkb);
    expect((m as any).identitySid(child)).toBe(parent);
    (m as any).save();

    const persisted = readState();
    expect(persisted.registry.threads[parent]).toEqual([parent, child]);
    expect(persisted.origins[child].parent).toBeUndefined();
  });

  it("快照非法 → 空且不可信（絕不當成「這段對話沒有別名」放行）", () => {
    const proj = newProjectsRoot({
      offsets: {},
      titles: {},
      seeded: true,
      registry: { threads: { a: ["x"], b: ["x"] }, aliasHistoryTrusted: true }, // 同一條線程屬於兩段對話
    });
    writeFileSync(join(proj, "77770000-0000-4000-8000-000000000000.jsonl"), render([userLine("77770000-0000-4000-8000-000000000000", "hi")]));
    const m = new Mirror(fakeLinkb().linkb);
    expect((m as any).registry.historyTrusted).toBe(false);
    expect((m as any).identitySid("x")).toBe("x");
  });

  it("裁剪只在整段對話的線程全部消失時整條丟（父檔被清、續接檔還在 → 別名一條不動）", () => {
    const proj = newProjectsRoot();
    const parent = "88880000-0000-4000-8000-000000000000";
    const base = [userLine(parent, "第一句"), assistantLine(parent, "回答")];
    writeFileSync(join(proj, `${parent}.jsonl`), render(base));
    const child = "88880001-0000-4000-8000-000000000000";
    writeFileSync(
      join(proj, `${child}.jsonl`),
      render([...continuationOf(base, child), userLine(child, "續接")]),
    );
    const m = new Mirror(fakeLinkb().linkb) as any;
    m.resolveNewOrigins(discoverSessions());
    m.state.offsets[parent] = 0;
    m.state.offsets[child] = 0;

    // 父檔的 transcript 被 CC 清掉、續接檔還在：別名必須留著，否則這段對話下次就查不回身份。
    const week = 8 * 24 * 3600 * 1000; // > PRUNE_MS（默認 7 天）
    const t0 = Date.now();
    m.prune(new Set([child]), t0); // 首次缺席只記時刻
    m.prune(new Set([child]), t0 + week); // 缺席夠久 → 裁父檔的水位線
    expect(m.state.offsets[parent]).toBeUndefined();
    expect(m.identitySid(child)).toBe(parent);

    // 兩個都沒了 → 整條丟。
    m.prune(new Set<string>(), t0 + week);
    m.prune(new Set<string>(), t0 + 2 * week);
    expect(m.registry.conversationOf(child)).toBeUndefined();
    expect(m.identitySid(child)).toBe(child);
  });
});

describe("#967 ③ E2E 身份歸屬：別名可信才放開，不可信維持舊身份（fail-closed）", () => {
  it("別名歷史可信 + 父會話已 E2E → 續接接回父會話，正文用父會話的 K_S 加密", () => {
    const proj = newProjectsRoot();
    const parent = "99990000-0000-4000-8000-000000000000";
    const base = [userLine(parent, "第一句"), assistantLine(parent, "回答")];
    writeFileSync(join(proj, `${parent}.jsonl`), render(base));

    const protectedSids = new Set<string>();
    const store = fakeKeystore(protectedSids);
    const { linkb, frames } = fakeLinkb();
    const m = new Mirror(linkb, store as any);
    (m as any).doPoll(); // 此刻零受保護會話 → 別名歷史立為基線
    expect((m as any).registry.historyTrusted).toBe(true);

    // 之後這條會話開了 E2E，用戶在終端 `--resume` 續聊。
    protectedSids.add(parent);
    const child = "99990001-0000-4000-8000-000000000000";
    writeFileSync(
      join(proj, `${child}.jsonl`),
      render([...continuationOf(base, child), userLine(child, "續接")]),
    );
    (m as any).doPoll();

    expect((m as any).identitySid(child)).toBe(parent);
    expect((m as any).counters.mirrorE2EContinuationsMerged).toBe(1);
    expect((m as any).counters.mirrorE2EIdentityHeld).toBe(0);
    const encrypted = sessionsOf(frames).filter((s) => s.e2e === true);
    expect(encrypted.length).toBeGreaterThan(0);
    for (const s of encrypted) expect(s.hermesSessionId).toBe(parent); // K_S 的鍵沒變
    // 別名同時交給了 keystore：舊鍵下的 K_S 查得到（#950 setIdentityAliases）。
    expect([...store.aliases!(child)]).toEqual([parent]);
  });

  it("別名歷史不可信（機器上早有 E2E 會話）→ 維持舊身份，絕不換 K_S 的鍵", () => {
    const proj = newProjectsRoot();
    const parent = "aaaa0000-0000-4000-8000-000000000000";
    const base = [userLine(parent, "第一句"), assistantLine(parent, "回答")];
    writeFileSync(join(proj, `${parent}.jsonl`), render(base));

    // 這台機器一開始就有受保護會話 → 永遠沒有「沒有東西可丟」的那一刻 → 別名歷史持久不可信。
    const store = fakeKeystore(new Set([parent]));
    const { linkb } = fakeLinkb();
    const m = new Mirror(linkb, store as any);
    (m as any).doPoll();
    expect((m as any).registry.historyTrusted).toBe(false);

    const child = "aaaa0001-0000-4000-8000-000000000000";
    writeFileSync(
      join(proj, `${child}.jsonl`),
      render([...continuationOf(base, child), userLine(child, "續接")]),
    );
    (m as any).doPoll();

    expect((m as any).identitySid(child)).toBe(child); // 舊身份，走老路徑
    expect((m as any).counters.mirrorE2EIdentityHeld).toBe(1);
    expect((m as any).counters.mirrorE2EContinuationsMerged).toBe(0);
    // 不可信 → 解析器恆空 → keystore 逐字節退回改前行為（不會拿一個猜的鍵去解密）。
    expect([...store.aliases!(child)]).toEqual([]);
  });

  it("明文會話不受這道閘影響：沒有 E2E 就照常接回父會話（別名不可信也一樣）", () => {
    const proj = newProjectsRoot();
    const parent = "bbbb0000-0000-4000-8000-000000000000";
    const base = [userLine(parent, "第一句"), assistantLine(parent, "回答")];
    writeFileSync(join(proj, `${parent}.jsonl`), render(base));
    const store = fakeKeystore(new Set(["some-other-e2e-session"]));
    const m = new Mirror(fakeLinkb().linkb, store as any) as any;
    m.doPoll();
    expect(m.registry.historyTrusted).toBe(false);

    const child = "bbbb0001-0000-4000-8000-000000000000";
    writeFileSync(
      join(proj, `${child}.jsonl`),
      render([...continuationOf(base, child), userLine(child, "續接")]),
    );
    m.doPoll();
    expect(m.identitySid(child)).toBe(parent);
  });
});

describe("#967 歷史導入（import_batch）同樣上報血緣", () => {
  it("頂層會話帶 origin；`--resume` 複製出來的副本（指紋撞上）不帶，維持老行為", () => {
    const proj = newProjectsRoot();
    const parent = "cccc0000-0000-4000-8000-000000000000";
    const base = [userLine(parent, "第一句"), assistantLine(parent, "回答")];
    writeFileSync(join(proj, `${parent}.jsonl`), render(base));
    const child = "cccc0001-0000-4000-8000-000000000000";
    writeFileSync(
      join(proj, `${child}.jsonl`),
      render([...continuationOf(base, child), userLine(child, "續接")]),
    );
    const lone = "cccc0002-0000-4000-8000-000000000000";
    writeFileSync(join(proj, `${lone}.jsonl`), render([userLine(lone, "另一段對話")]));

    const built = collectImportSessions();
    const byId = new Map(built.map((s) => [s.hermesSessionId, s]));
    expect(byId.get(lone)!.origin).toEqual({
      threadId: lone,
      conversationId: lone,
      kind: "root",
      evidence: "declared",
    });
    // 父子指紋相同 → 兩邊都不敢報 root（導入側的歸併是切換判定權那一刀的事）。
    expect(byId.get(parent)!.origin).toBeUndefined();
    expect(byId.get(child)!.origin).toBeUndefined();
  });
});
