/**
 * #946 鏡像側：會話身份改用源系統聲明的歸屬後的端到端行為。
 *
 * 三條驗收（對應 issue 的「574 條派生線程 100% 歸位或隔離、825 條用戶線程 0 誤傷、
 * 老格式行為不變」）：
 *   1. 終端側 rewind/fork → 內容**繼續投進父會話**（此前整檔跳過 = 那條會話靜默停更）
 *   2. 子 agent（thread_spawn）→ 一條新會話都不建
 *   3. 老格式（無任何聲明）與根線程 → 身份逐字節不變
 * 外加落地順序約束：E2E 會話**先不改身份**（走老路徑）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { E2EKeyStore } from "../src/_core/e2e/keys";
import { collectImportSessions } from "../src/codex/history-import";
import { deriveMeta, Mirror, stripIdeContext } from "../src/codex/mirror";
import { resetSessionIndexCache } from "../src/codex/session-index";

const PARENT = "019f497b-f579-7e93-829b-9242759d4f98";
const FORK = "019f497d-6f8e-7e72-85b1-961382e83d7f";

const meta = (payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: "2026-07-10T00:46:25.191Z", type: "session_meta", payload });
const user = (message: string) =>
  JSON.stringify({ type: "event_msg", payload: { type: "user_message", message } });
const agent = (message: string) =>
  JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message } });

let root: string;
let prevSessions: string | undefined;
let prevMirror: string | undefined;
let prevIndex: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-946-"));
  prevSessions = process.env.MACCHIATO_CODEX_SESSIONS_DIR;
  prevMirror = process.env.MACCHIATO_CODEX_MIRROR;
  prevIndex = process.env.MACCHIATO_CODEX_SESSION_INDEX;
  process.env.MACCHIATO_CODEX_SESSIONS_DIR = join(root, "sessions");
  process.env.MACCHIATO_CODEX_MIRROR = join(root, "mirror.json");
  process.env.MACCHIATO_CODEX_SESSION_INDEX = join(root, "session_index.jsonl");
  mkdirSync(join(root, "sessions", "2026", "08", "14"), { recursive: true });
  resetSessionIndexCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("MACCHIATO_CODEX_SESSIONS_DIR", prevSessions);
  restore("MACCHIATO_CODEX_MIRROR", prevMirror);
  restore("MACCHIATO_CODEX_SESSION_INDEX", prevIndex);
  resetSessionIndexCache();
});

function writeRollout(threadId: string, lines: string[], stamp = "00-00-00"): string {
  const file = join(root, "sessions", "2026", "08", "14", `rollout-2026-08-14T${stamp}-${threadId}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function newMirror(
  sent: Record<string, unknown>[],
  e2eWireSidForLocal?: (sid: string) => string | undefined,
  e2e?: E2EKeyStore,
): any {
  return new Mirror(
    { agentLinkId: "al", isReady: true, send: (f: Record<string, unknown>) => sent.push(f) } as any,
    e2e,
    e2eWireSidForLocal,
  );
}

/** 真 keystore（別名/持鑰語義是本組測試的被測對象，假對象測不出 #347 那條 fail-closed）。 */
function newKeyStore(): E2EKeyStore {
  return new E2EKeyStore(join(root, `e2e-${Math.random().toString(36).slice(2)}.json`));
}

/** 直接把一份 registry 快照塞進鏡像狀態檔（模擬「身份換過、K_S 壓在舊鍵下」的存量）。 */
function seedRegistry(threads: Record<string, string[]>, aliasHistoryTrusted?: boolean): void {
  const path = process.env.MACCHIATO_CODEX_MIRROR!;
  const prev = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(
    path,
    JSON.stringify({
      ...prev,
      threadRegistry: {
        threads,
        ...(aliasHistoryTrusted === undefined ? {} : { aliasHistoryTrusted }),
      },
    }),
  );
}

/** 父會話已鏡像完（水位坐在 EOF），本輪只看派生線程怎麼走。 */
function seedState(parentFile: string, parentLines: number): void {
  writeFileSync(
    process.env.MACCHIATO_CODEX_MIRROR!,
    JSON.stringify({
      offsets: { [PARENT]: statSync(parentFile).size },
      ords: { [PARENT]: parentLines },
      seeded: true,
    }),
  );
}

describe("#946 終端側 rewind/fork：接回父會話而不是靜默停更", () => {
  it("fork 複製的歷史一條不重灌，fork 之後的新消息投進父會話", () => {
    const parentFile = writeRollout(PARENT, [
      meta({ session_id: PARENT, id: PARENT, cwd: "/w", thread_source: "user", source: "vscode" }),
      user("第一問"),
      agent("第一答"),
    ]);
    // 終端裡 rewind：Codex fork 出新 thread，檔頭是父會話歷史的逐字副本
    const forkFile = writeRollout(
      FORK,
      [
        meta({
          session_id: PARENT,
          id: FORK,
          forked_from_id: PARENT,
          cwd: "/w",
          thread_source: "user",
          source: "vscode",
        }),
        user("第一問"),
        agent("第一答"),
      ],
      "00-00-01",
    );
    seedState(parentFile, 3);

    const sent: Record<string, unknown>[] = [];
    const mirror = newMirror(sent);
    mirror.pollOnce();
    // 首次見到：水位坐到分叉點，複製的歷史一條都不投
    expect(sent.filter((f) => f.t === "mirror_append")).toHaveLength(0);
    expect(mirror.counters.mirrorForkAdopted).toBe(1);
    expect(mirror.state.offsets[FORK]).toBe(statSync(forkFile).size);

    // 用戶在終端裡繼續聊
    writeFileSync(forkFile, [
      meta({
        session_id: PARENT,
        id: FORK,
        forked_from_id: PARENT,
        cwd: "/w",
        thread_source: "user",
        source: "vscode",
      }),
      user("第一問"),
      agent("第一答"),
      user("改成別的做法"),
      agent("好"),
    ].join("\n") + "\n");
    mirror.pollOnce();

    const appends = sent.filter((f: any) => f.t === "mirror_append") as any[];
    expect(appends).toHaveLength(1);
    const entry = appends[0].sessions[0];
    expect(entry.hermesSessionId).toBe(PARENT); // ← 歸位，而不是另起一條會話
    expect(entry.messages.map((m: any) => m.text)).toEqual(["改成別的做法", "好"]);
  });

  it("父 rollout 已不在（壓縮/裁剪）→ 保守坐到 EOF，絕不把歷史複製進會話", () => {
    writeFileSync(process.env.MACCHIATO_CODEX_MIRROR!, JSON.stringify({ offsets: {}, ords: {}, seeded: true }));
    const forkFile = writeRollout(FORK, [
      meta({ session_id: PARENT, id: FORK, forked_from_id: PARENT, cwd: "/w", thread_source: "user" }),
      user("父會話的歷史"),
      agent("父會話的回答"),
    ]);
    const sent: Record<string, unknown>[] = [];
    const mirror = newMirror(sent);
    mirror.pollOnce();
    expect(sent.filter((f) => f.t === "mirror_append")).toHaveLength(0);
    expect(mirror.state.offsets[FORK]).toBe(statSync(forkFile).size);
  });
});

describe("#946 派生線程 100% 歸位或隔離、用戶線程 0 誤傷", () => {
  it("子 agent（thread_spawn 真形態）→ 一條新會話都不建", () => {
    const parentFile = writeRollout(PARENT, [
      meta({ session_id: PARENT, id: PARENT, cwd: "/w", thread_source: "user", source: "vscode" }),
      user("開三個子 agent 審一遍"),
    ]);
    writeRollout(
      FORK,
      [
        meta({
          session_id: PARENT,
          id: FORK,
          forked_from_id: PARENT,
          parent_thread_id: PARENT,
          cwd: "/w",
          thread_source: "subagent",
          source: {
            subagent: {
              thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_path: "/root/x", agent_nickname: "Mill" },
            },
          },
          agent_nickname: "Mill",
        }),
        user("開三個子 agent 審一遍"),
        agent("子 agent 的長篇輸出"),
      ],
      "00-00-01",
    );
    seedState(parentFile, 2);

    const sent: Record<string, unknown>[] = [];
    const mirror = newMirror(sent);
    mirror.pollOnce();
    expect(sent.filter((f) => f.t === "mirror_append")).toHaveLength(0);
    expect(mirror.counters.mirrorInternalSkipped).toBe(1);
    expect(mirror.counters.mirrorForkAdopted).toBe(0);
  });

  it("老格式根線程（無任何聲明）→ 身份仍是自己，行為與今天逐字節相同", () => {
    writeFileSync(process.env.MACCHIATO_CODEX_MIRROR!, JSON.stringify({ offsets: {}, ords: {}, seeded: true }));
    const tid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0946";
    writeRollout(tid, [meta({ cwd: "/legacy", timestamp: "t" }), user("老 Codex 的普通會話")]);
    const sent: Record<string, unknown>[] = [];
    const mirror = newMirror(sent);
    mirror.pollOnce();
    const appends = sent.filter((f: any) => f.t === "mirror_append") as any[];
    expect(appends).toHaveLength(1);
    expect(appends[0].sessions[0].hermesSessionId).toBe(tid);
    expect(mirror.counters.mirrorInferredSkipped).toBe(0);
  });

  it("兜底判據單獨打點：老格式 guardian 只能靠正文猜出來", () => {
    writeFileSync(process.env.MACCHIATO_CODEX_MIRROR!, JSON.stringify({ offsets: {}, ords: {}, seeded: true }));
    const tid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0918";
    writeRollout(tid, [
      meta({ cwd: "/legacy" }),
      user("The following is the Codex agent history added since your last approval\nxxx"),
    ]);
    const sent: Record<string, unknown>[] = [];
    const mirror = newMirror(sent);
    mirror.pollOnce();
    expect(sent.filter((f) => f.t === "mirror_append")).toHaveLength(0);
    expect(mirror.counters.mirrorInferredSkipped).toBe(1);
    expect(mirror.counters.mirrorInternalSkipped).toBe(1);
  });
});

describe("#946 墓碑對父會話同樣有效", () => {
  it("app 刪過父會話 → 派生線程不許把它借屍還魂", () => {
    const parentFile = writeRollout(PARENT, [
      meta({ session_id: PARENT, id: PARENT, cwd: "/w", thread_source: "user", source: "vscode" }),
      user("刪掉的會話"),
    ]);
    writeRollout(
      FORK,
      [
        meta({ session_id: PARENT, id: FORK, forked_from_id: PARENT, cwd: "/w", thread_source: "user" }),
        user("刪掉的會話"),
        user("rewind 後繼續"),
      ],
      "00-00-01",
    );
    writeFileSync(
      process.env.MACCHIATO_CODEX_MIRROR!,
      JSON.stringify({
        offsets: { [PARENT]: statSync(parentFile).size },
        ords: { [PARENT]: 2 },
        seeded: true,
        tombstones: [PARENT],
      }),
    );
    const sent: Record<string, unknown>[] = [];
    const mirror = newMirror(sent);
    mirror.pollOnce();
    expect(sent.filter((f) => f.t === "mirror_append")).toHaveLength(0);
    expect(mirror.counters.mirrorForkAdopted).toBe(0);
  });
});

/**
 * #966 E2E 身份放開（#946 落地時的「E2E 一律走老路徑」到此為止）。
 *
 * 被修掉的症狀：**E2E 會話在終端裡 rewind 之後，後續回合的正文一條都不鏡像**——fork 檔整檔
 * 跳過，app 裡那條會話靜默停更、零提示，E2E 用戶尤其看不出所以然（#926 的「第三種症狀」）。
 */
describe("#966 E2E 會話 rewind 之後正文恢復鏡像", () => {
  /** 父會話已鏡像完 + 終端裡 rewind 出一份 fork 檔（開頭是父歷史的逐字副本）。 */
  function rewindScene(): { forkFile: string } {
    const parentFile = writeRollout(PARENT, [
      meta({ session_id: PARENT, id: PARENT, cwd: "/w", thread_source: "user", source: "vscode" }),
      user("加密會話"),
    ]);
    const forkFile = writeRollout(
      FORK,
      [
        meta({ session_id: PARENT, id: FORK, forked_from_id: PARENT, cwd: "/w", thread_source: "user" }),
        user("加密會話"),
      ],
      "00-00-01",
    );
    seedState(parentFile, 2);
    return { forkFile };
  }

  function keepTalking(forkFile: string): void {
    writeFileSync(
      forkFile,
      [
        meta({ session_id: PARENT, id: FORK, forked_from_id: PARENT, cwd: "/w", thread_source: "user" }),
        user("加密會話"),
        user("rewind 後繼續"),
        agent("好"),
      ].join("\n") + "\n",
    );
  }

  it("終端側 rewind：fork 之後的新消息用**對話那把鑰匙**加密投回原會話", () => {
    const { forkFile } = rewindScene();
    const e2e = newKeyStore();
    e2e.createForEnable(PARENT); // 這條終端會話已被 app 開啟 E2E，K_S 掛在會話身份上
    const sent: Record<string, unknown>[] = [];
    const mirror = newMirror(sent, undefined, e2e);

    mirror.pollOnce(); // 首次見到 fork 檔：水位坐到分叉點，複製的歷史一條不重灌
    expect(mirror.counters.mirrorForkAdopted).toBe(1);
    expect(mirror.counters.mirrorE2EIdentityHeld).toBe(0);

    keepTalking(forkFile);
    mirror.pollOnce();
    const appends = sent.filter((f: any) => f.t === "mirror_append") as any[];
    expect(appends).toHaveLength(1);
    const entry = appends[0].sessions[0];
    expect(entry.hermesSessionId).toBe(PARENT); // 接回原會話，而不是靜默停更
    expect(entry.e2e).toBe(true);
    expect(entry.messages).toHaveLength(2);
    expect(entry.messages.every((m: any) => typeof m.enc === "string" && m.text === undefined)).toBe(true);
    // 密文確實是那把鑰匙加的（能解回原文），且**沒有**憑空多出一把 K_S
    expect((e2e.decryptContent(PARENT, entry.messages[0].enc) as { text: string }).text).toBe("rewind 後繼續");
    expect(e2e.protectedSessionIds()).toEqual([PARENT]);
  });

  it("app-driven E2E（身份是 server 的 wire ULID）：照樣投回那條 wire 會話", () => {
    const { forkFile } = rewindScene();
    const wire = "01K0CODEXWIRESID00000000001";
    const e2e = newKeyStore();
    e2e.createForEnable(wire);
    const sent: Record<string, unknown>[] = [];
    // 本地 thread PARENT ↔ wire ULID 的映射只認父線程；fork 出來的 FORK 不在映射裡。
    const mirror = newMirror(sent, (sid: string) => (sid === PARENT ? wire : undefined), e2e);
    mirror.pollOnce();
    keepTalking(forkFile);
    mirror.pollOnce();
    const entry = (sent.filter((f: any) => f.t === "mirror_append") as any[])[0].sessions[0];
    expect(entry.hermesSessionId).toBe(wire);
    expect(entry.e2e).toBe(true);
  });

  it("fail-closed：派生線程自己持着**另一把** K_S → 維持舊身份，不降級明文也不新生成 K_S", () => {
    const { forkFile } = rewindScene();
    const e2e = newKeyStore();
    e2e.createForEnable(FORK); // 存量：#946 之前它自己就是一條獨立的 E2E 會話
    const sent: Record<string, unknown>[] = [];
    const mirror = newMirror(sent, undefined, e2e);
    mirror.pollOnce();
    keepTalking(forkFile);
    mirror.pollOnce();

    expect(sent.filter((f) => f.t === "mirror_append")).toHaveLength(0);
    expect(mirror.counters.mirrorForkAdopted).toBe(0);
    expect(mirror.counters.mirrorE2EIdentityHeld).toBeGreaterThan(0);
    expect(mirror.state.offsets[FORK]).toBe(statSync(forkFile).size);
    expect(e2e.protectedSessionIds()).toEqual([FORK]); // 一把都沒多生成
  });

  it("aliasHistoryTrusted 不可信 → 認不出舊鍵下的同一段對話，維持舊身份", () => {
    const OLD = "019f4980-0000-7000-8000-000000000001";
    const { forkFile } = rewindScene();
    seedRegistry({ [PARENT]: [PARENT, OLD] }); // 缺字段 = 不可信（#347：不可由字段存在推斷）
    const e2e = newKeyStore();
    e2e.createForEnable(OLD); // 這段對話的 K_S 壓在**換身份之前**的舊鍵下
    const sent: Record<string, unknown>[] = [];
    const mirror = newMirror(sent, undefined, e2e);

    expect(e2e.isE2E(PARENT)).toBe(false); // 別名恒空 → 逐字節退回改前行為
    mirror.pollOnce();
    keepTalking(forkFile);
    mirror.pollOnce();
    expect(sent.filter((f) => f.t === "mirror_append")).toHaveLength(0);
    expect(mirror.counters.mirrorE2EIdentityHeld).toBeGreaterThan(0);
    expect(e2e.protectedSessionIds()).toEqual([OLD]);
  });

  it("aliasHistoryTrusted=true → keystore 按別名認親，舊鍵下的 K_S 照樣用得上", () => {
    const OLD = "019f4980-0000-7000-8000-000000000001";
    rewindScene();
    seedRegistry({ [PARENT]: [PARENT, OLD] }, true);
    const e2e = newKeyStore();
    const key = e2e.createForEnable(OLD);
    newMirror([], undefined, e2e); // 構造即注入別名解析器
    expect(e2e.isE2E(PARENT)).toBe(true);
    expect(e2e.hasKey(PARENT)).toBe(true);
    expect(e2e.requireKey(PARENT).equals(key)).toBe(true);
  });

  it("別名歷史只在「零受保護會話 + 權威快照」時才敢標可信，且永不自升", () => {
    writeFileSync(process.env.MACCHIATO_CODEX_MIRROR!, JSON.stringify({ offsets: {}, ords: {}, seeded: true }));
    const ready = { version: 1, sessions: [], disabledReceipts: [] };

    const clean = newKeyStore();
    const mirrorA = newMirror([], undefined, clean);
    mirrorA.adoptThreadHistoryIfProvable();
    expect(mirrorA.registry.historyTrusted).toBe(false); // 快照還沒套用 → 不敢
    clean.applyServerState(ready);
    mirrorA.adoptThreadHistoryIfProvable();
    expect(mirrorA.registry.historyTrusted).toBe(true);
    expect(JSON.parse(readFileSync(process.env.MACCHIATO_CODEX_MIRROR!, "utf8")).threadRegistry.aliasHistoryTrusted)
      .toBe(true);

    writeFileSync(process.env.MACCHIATO_CODEX_MIRROR!, JSON.stringify({ offsets: {}, ords: {}, seeded: true }));
    const withKeys = newKeyStore();
    withKeys.createForEnable(PARENT);
    withKeys.applyServerState({ version: 1, sessions: [{ hermesSessionId: PARENT, pendingOp: null }], disabledReceipts: [] });
    const mirrorB = newMirror([], undefined, withKeys);
    mirrorB.adoptThreadHistoryIfProvable();
    expect(mirrorB.registry.historyTrusted).toBe(false); // 已有 E2E 會話 → 持久 false
  });
});

/**
 * #966/#985 上報血緣。連接器**繼續**按本地判定工作（老 server 兼容）：獨立 session 據實
 * 報 kind，已經併進父的批次仍是 root。真正停本地過濾要等生產 server 已跑判定 + 熔斷。
 */
describe("#966 mirror_append 帶 ThreadOrigin", () => {
  it("根線程：threadId ≡ conversationId ≡ 上報身份，kind=root、evidence=declared（server 認得）", () => {
    writeFileSync(process.env.MACCHIATO_CODEX_MIRROR!, JSON.stringify({ offsets: {}, ords: {}, seeded: true }));
    writeRollout(PARENT, [
      meta({ session_id: PARENT, id: PARENT, cwd: "/w", thread_source: "user", source: "vscode" }),
      user("普通會話"),
    ]);
    const sent: Record<string, unknown>[] = [];
    newMirror(sent).pollOnce();
    const entry = (sent.filter((f: any) => f.t === "mirror_append") as any[])[0].sessions[0];
    expect(entry.hermesSessionId).toBe(PARENT);
    expect(entry.origin).toEqual({
      threadId: PARENT,
      conversationId: PARENT,
      kind: "root",
      evidence: "declared",
    });
  });

  it("老格式（源系統壓根沒這概念）→ 整個字段不上線，server 走老行為、不倒退", () => {
    writeFileSync(process.env.MACCHIATO_CODEX_MIRROR!, JSON.stringify({ offsets: {}, ords: {}, seeded: true }));
    const tid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0966";
    writeRollout(tid, [meta({ cwd: "/legacy" }), user("老 Codex 的普通會話")]);
    const sent: Record<string, unknown>[] = [];
    newMirror(sent).pollOnce();
    const entry = (sent.filter((f: any) => f.t === "mirror_append") as any[])[0].sessions[0];
    expect(entry.origin).toBeUndefined();
    expect("origin" in entry).toBe(false);
  });

  it("已在本地歸屬的派生線程：origin 描述的是**掛載身份**（協議要求 threadId ≡ hermesSessionId）", () => {
    const parentFile = writeRollout(PARENT, [
      meta({ session_id: PARENT, id: PARENT, cwd: "/w", thread_source: "user", source: "vscode" }),
      user("第一問"),
    ]);
    const forkFile = writeRollout(
      FORK,
      [
        meta({ session_id: PARENT, id: FORK, forked_from_id: PARENT, cwd: "/w", thread_source: "user" }),
        user("第一問"),
      ],
      "00-00-01",
    );
    seedState(parentFile, 2);
    const sent: Record<string, unknown>[] = [];
    const mirror = newMirror(sent);
    mirror.pollOnce();
    writeFileSync(
      forkFile,
      [
        meta({ session_id: PARENT, id: FORK, forked_from_id: PARENT, cwd: "/w", thread_source: "user" }),
        user("第一問"),
        user("rewind 後繼續"),
      ].join("\n") + "\n",
    );
    mirror.pollOnce();
    const entry = (sent.filter((f: any) => f.t === "mirror_append") as any[])[0].sessions[0];
    // 派生線程在**本地**就已經並進父會話了，所以這批內容對 server 而言就是那條對話自己的
    // 內容。報 continuation 只會被 classifyThreadOrigin 判成自相矛盾丟掉（threadId ≠ 掛載
    // 身份）——判定權交回 server 時把 hermesSessionId 換成線程自己的 id，那時才報得出去。
    expect(entry.hermesSessionId).toBe(PARENT);
    expect(entry.origin).toEqual({
      threadId: PARENT,
      conversationId: PARENT,
      kind: "root",
      evidence: "declared",
    });
  });

  it("E2E 會話：血緣是元數據不是正文，照樣帶（身份用 server 的 wire ULID）", () => {
    const parentFile = writeRollout(PARENT, [
      meta({ session_id: PARENT, id: PARENT, cwd: "/w", thread_source: "user", source: "vscode" }),
      user("加密會話"),
    ]);
    seedState(parentFile, 2);
    writeFileSync(
      parentFile,
      [
        meta({ session_id: PARENT, id: PARENT, cwd: "/w", thread_source: "user", source: "vscode" }),
        user("加密會話"),
        user("再說一句"),
      ].join("\n") + "\n",
    );
    const wire = "01K0CODEXWIRESID00000000002";
    const e2e = newKeyStore();
    e2e.createForEnable(wire);
    const sent: Record<string, unknown>[] = [];
    newMirror(sent, (sid: string) => (sid === PARENT ? wire : undefined), e2e).pollOnce();
    const entry = (sent.filter((f: any) => f.t === "mirror_append") as any[])[0].sessions[0];
    expect(entry.e2e).toBe(true);
    expect(entry.origin).toEqual({
      threadId: wire,
      conversationId: wire,
      kind: "root",
      evidence: "declared",
    });
  });

  it("登記表讓上報身份不隨父 rollout 消失而漂移", () => {
    const parentFile = writeRollout(PARENT, [
      meta({ session_id: PARENT, id: PARENT, cwd: "/w", thread_source: "user", source: "vscode" }),
      user("第一問"),
    ]);
    const forkFile = writeRollout(
      FORK,
      [meta({ session_id: PARENT, id: FORK, forked_from_id: PARENT, cwd: "/w", thread_source: "user" }), user("第一問")],
      "00-00-01",
    );
    seedState(parentFile, 2);
    const sent: Record<string, unknown>[] = [];
    const mirror = newMirror(sent);
    mirror.pollOnce();
    expect(mirror.registry.conversationOf(FORK)).toBe(PARENT);
    expect(mirror.registry.wireIdentityOf(PARENT)).toBe(PARENT);

    // 父 rollout 被壓縮成 .zst / 被裁掉：判據鏈已經走不通，登記過的身份必須紋絲不動
    rmSync(parentFile);
    writeFileSync(
      forkFile,
      [
        meta({ session_id: PARENT, id: FORK, forked_from_id: PARENT, cwd: "/w", thread_source: "user" }),
        user("第一問"),
        user("rewind 後繼續"),
      ].join("\n") + "\n",
    );
    mirror.pollOnce();
    const entry = (sent.filter((f: any) => f.t === "mirror_append") as any[])[0].sessions[0];
    expect(entry.hermesSessionId).toBe(PARENT);
  });

  it("import_batch 同樣帶：導入口徑下派生線程整檔不進來，故恒是 root", () => {
    writeRollout(PARENT, [
      meta({ session_id: PARENT, id: PARENT, cwd: "/w", thread_source: "user", source: "vscode" }),
      user("要導入的會話"),
      agent("答"),
    ]);
    writeRollout(
      FORK,
      [
        meta({ session_id: PARENT, id: FORK, cwd: "/w", thread_source: "subagent" }),
        user("子 agent"),
        agent("答"),
      ],
      "00-00-01",
    );
    const { built } = collectImportSessions();
    expect(built.map((s) => s.hermesSessionId)).toEqual([PARENT]); // 派生線程不進導入
    expect(built[0]!.origin).toEqual({
      threadId: PARENT,
      conversationId: PARENT,
      kind: "root",
      evidence: "declared",
    });
  });

  it("根線程不佔登記表（別讓它跟着 rollout 數量無界長）", () => {
    writeFileSync(process.env.MACCHIATO_CODEX_MIRROR!, JSON.stringify({ offsets: {}, ords: {}, seeded: true }));
    writeRollout(PARENT, [meta({ session_id: PARENT, id: PARENT, cwd: "/w", thread_source: "user" }), user("普通會話")]);
    const mirror = newMirror([]);
    mirror.pollOnce();
    expect(mirror.registry.toJSON().threads).toEqual({});
  });
});

describe("#946 標題：源系統的名字優先，回退時剝掉 IDE 注入塊", () => {
  it("session_index.jsonl 的 thread_name 勝過首條消息截斷", () => {
    writeFileSync(
      process.env.MACCHIATO_CODEX_SESSION_INDEX!,
      JSON.stringify({ id: PARENT, thread_name: "Convert AssemblyAI webhook flow", updated_at: "t" }) + "\n",
    );
    const content = [meta({ id: PARENT, cwd: "/w" }), user("# Files mentioned by the user:\n## a.txt: /x")].join("\n");
    expect(deriveMeta(content, PARENT)).toEqual({ title: "Convert AssemblyAI webhook flow", cwd: "/w" });
  });

  it("沒有 thread_name → 剝掉 IDE 上下文塊，取用戶真正說的那句", () => {
    const injected =
      "# Context from my IDE setup:\n\n## Open tabs:\n- messages.json: public/_locales/en/messages.json\n\n"
      + "## My request for Codex:\n修改我的插件版本号为1.0.0";
    expect(stripIdeContext(injected).trim()).toBe("修改我的插件版本号为1.0.0");
    const content = [meta({ id: PARENT, cwd: "/w" }), user(injected)].join("\n");
    expect(deriveMeta(content, PARENT).title).toBe("修改我的插件版本号为1.0.0");
  });

  it("IDE 塊裡沒寫請求（只貼了附件）→ 換下一條真人消息當標題", () => {
    const content = [
      meta({ id: PARENT, cwd: "/w" }),
      user("# Files mentioned by the user:\n\n## pasted-text.txt: /x\n\n## My request for Codex:\n"),
      user("看看啥情况"),
    ].join("\n");
    expect(deriveMeta(content, PARENT).title).toBe("看看啥情况");
  });
});
