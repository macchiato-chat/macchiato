/**
 * #473 rewind(codex / thread-fork):
 *  - 勘察:srcId → 所屬回合;lastTurnId = 目標回合**之前**最近的不同回合(inclusive 保留);
 *    cutSrcId = 目標回合首條消息(server 憑它把刪行對齊到 agent 實際忘掉的位置);
 *  - 認領:fork 出的新 rollout 水位(offsets **和 ords**)坐到 EOF——漏了就是整段歷史重灌;
 *  - ord 計法必須與增量路徑逐字節一致(srcId 哈希含全文行號)。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Mirror, srcIdFor } from "../src/codex/mirror";
import { messagesWithTurns, nextOrdAtEof } from "../src/codex/transcripts";

const T1 = "019f0000-0000-7000-8000-000000000001";
const T2 = "019f0000-0000-7000-8000-000000000002";

const taskStarted = (turnId: string) =>
  JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "task_started", turn_id: turnId } });
const userMsg = (text: string) =>
  JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "user_message", message: text } });
const agentMsg = (text: string) =>
  JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "agent_message", message: text } });
const noise = () => JSON.stringify({ timestamp: "t", type: "world_state", payload: {} });

/**
 * 兩個回合的 rollout;turn-B 裡有**兩條** user 消息(codex 真實形態,#473 評論裡實測過)——
 * 回退到第二條時回合粒度切不準,必須靠 cutSrcId 讓 server 對齊。
 * 夾 noise 行驗 ord 是全文行號而非消息序號。
 */
const ROLLOUT =
  [
    JSON.stringify({ timestamp: "t", type: "session_meta", payload: { id: T1, cwd: "/w" } }), // ord 0
    taskStarted("turn-A"), // ord 1
    userMsg("A-u1"), // ord 2
    noise(), // ord 3
    agentMsg("A-a1"), // ord 4
    taskStarted("turn-B"), // ord 5
    userMsg("B-u1"), // ord 6
    agentMsg("B-a1"), // ord 7
    userMsg("B-u2"), // ord 8
    agentMsg("B-a2"), // ord 9
  ].join("\n") + "\n";

let root: string;
const envBackup: Record<string, string | undefined> = {};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codex-rewind-"));
  for (const k of ["MACCHIATO_CODEX_SESSIONS_DIR", "MACCHIATO_CODEX_MIRROR"]) envBackup[k] = process.env[k];
  process.env.MACCHIATO_CODEX_SESSIONS_DIR = join(root, "sessions");
  process.env.MACCHIATO_CODEX_MIRROR = join(root, "mirror.json");
  const dir = join(root, "sessions", "2026", "07", "29");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-07-29T00-00-00-${T1}.jsonl`), ROLLOUT);
});
afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const fakeLinkb = () =>
  ({ agentLinkId: "AL1", isReady: true, send: () => {}, onFrame: () => () => {} }) as never;

const srcOf = (role: "user" | "agent", text: string, ord: number) => srcIdFor(T1, { role, text, ord });

describe("#473 messagesWithTurns", () => {
  it("回合歸屬 + ord 為全文行號(夾 noise 行不亂)", () => {
    const msgs = messagesWithTurns(ROLLOUT);
    expect(msgs.map((m) => [m.text, m.ord, m.turnId])).toEqual([
      ["A-u1", 2, "turn-A"],
      ["A-a1", 4, "turn-A"],
      ["B-u1", 6, "turn-B"],
      ["B-a1", 7, "turn-B"],
      ["B-u2", 8, "turn-B"],
      ["B-a2", 9, "turn-B"],
    ]);
  });
});

describe("#473 rewindPlan(codex)", () => {
  it("目標=B 回合首條 → 保留 turn-A,cut 即目標", () => {
    const m = new Mirror(fakeLinkb());
    expect(m.rewindPlan(T1, srcOf("user", "B-u1", 6))).toEqual({
      lastTurnId: "turn-A",
      cutSrcId: srcOf("user", "B-u1", 6),
    });
  });

  it("目標=同回合**第二條** user → 只能整回合切,cutSrcId 指向回合首條(agent 忘得比目標多)", () => {
    const m = new Mirror(fakeLinkb());
    expect(m.rewindPlan(T1, srcOf("user", "B-u2", 8))).toEqual({
      lastTurnId: "turn-A",
      cutSrcId: srcOf("user", "B-u1", 6), // server 憑它向前對齊刪行
    });
  });

  it("目標在第一個回合 → lastTurnId=null(沒有回合可保留;fork 省略 lastTurnId 是全量複製,正好相反)", () => {
    const m = new Mirror(fakeLinkb());
    expect(m.rewindPlan(T1, srcOf("user", "A-u1", 2))).toEqual({
      lastTurnId: null,
      cutSrcId: srcOf("user", "A-u1", 2),
    });
  });

  it("目標 srcId 不在 rollout → null", () => {
    const m = new Mirror(fakeLinkb());
    expect(m.rewindPlan(T1, "deadbeefdeadbeefdeadbeef")).toBeNull();
  });
});

describe("#473 adoptForked(codex)", () => {
  it("水位 offsets+ords 同步坐到 EOF;一輪 poll 不把 fork 複製的歷史重灌", async () => {
    // fork 出的新 rollout = 截斷後前綴(turn-A 整段)
    const forkedContent =
      [
        JSON.stringify({ timestamp: "t", type: "session_meta", payload: { id: T2, cwd: "/w" } }),
        taskStarted("turn-A"),
        userMsg("A-u1"),
        agentMsg("A-a1"),
      ].join("\n") + "\n";
    const dir = join(root, "sessions", "2026", "07", "29");
    writeFileSync(join(dir, `rollout-2026-07-29T00-00-01-${T2}.jsonl`), forkedContent);

    const sent: Record<string, unknown>[] = [];
    const m = new Mirror({
      agentLinkId: "AL1",
      isReady: true,
      send: (f: Record<string, unknown>) => sent.push(f),
      onFrame: () => () => {},
    } as never);
    expect(m.adoptForked(T2)).toBe(true);
    const st = (m as unknown as { state: { offsets: Record<string, number>; ords: Record<string, number> } }).state;
    expect(st.offsets[T2]).toBe(Buffer.byteLength(forkedContent, "utf8"));
    expect(st.ords[T2]).toBe(nextOrdAtEof(forkedContent));

    await (m as unknown as { poll: () => Promise<void> }).poll();
    const appends = sent.filter((f) => f.t === "mirror_append");
    const forT2 = appends.filter((f) => JSON.stringify(f).includes(T2) || JSON.stringify(f).includes("A-u1"));
    expect(forT2).toHaveLength(0); // fork 複製的歷史一條都不重發
  });

  it("rollout 還沒落盤也不炸:水位 0,driven 登記仍生效", () => {
    const m = new Mirror(fakeLinkb());
    const ghost = "019f0000-0000-7000-8000-00000000dead";
    expect(m.adoptForked(ghost)).toBe(true);
    const st = (m as unknown as { state: { offsets: Record<string, number>; ords: Record<string, number> } }).state;
    expect(st.offsets[ghost]).toBe(0);
    expect(st.ords[ghost]).toBe(0);
  });
});
