import { describe, expect, it, vi } from "vitest";
import { deriveMeta, Mirror, srcIdFor, threadIdFromFile } from "../src/codex/mirror";

describe("codex mirror 派生", () => {
  it("threadIdFromFile:從 rollout 文件名提 uuid", () => {
    expect(threadIdFromFile("rollout-2026-07-12T10-24-56-019f53b6-7e07-7832-a070-39bb197a7062.jsonl")).toBe("019f53b6-7e07-7832-a070-39bb197a7062");
    expect(threadIdFromFile("notarollout.jsonl")).toBeUndefined();
  });

  it("deriveMeta:cwd 從 session_meta、標題從首條 user 消息截斷", () => {
    const content = [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/srv/demo/repo" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "帮我把温度曲线改成24小时滚动窗口顺便修时区" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "好" } }),
    ].join("\n");
    const m = deriveMeta(content);
    expect(m.cwd).toBe("/srv/demo/repo");
    expect(m.title).toBe("帮我把温度曲线改成24小时滚动窗口顺便修时区");
    expect(m.title.length).toBeLessThanOrEqual(56);
  });

  it("無 user 消息 → 標題回退 Codex", () => {
    expect(deriveMeta(JSON.stringify({ type: "session_meta", payload: {} })).title).toBe("Codex");
  });
});

describe("#347 identity map fail-closed", () => {
  it("未知 local rollout 在身份映射不可信时不发明文且不推水位", async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "cx-identity-guard-"));
    const previousSessions = process.env.MACCHIATO_CODEX_SESSIONS_DIR;
    const previousMirror = process.env.MACCHIATO_CODEX_MIRROR;
    try {
      process.env.MACCHIATO_CODEX_SESSIONS_DIR = join(root, "sessions");
      process.env.MACCHIATO_CODEX_MIRROR = join(root, "mirror.json");
      const localSid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee3407";
      const rolloutDir = join(root, "sessions", "2026", "07", "23");
      mkdirSync(rolloutDir, { recursive: true });
      writeFileSync(
        join(rolloutDir, `rollout-2026-07-23T00-00-00-${localSid}.jsonl`),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "绝不能明文发送" } }) + "\n",
      );
      writeFileSync(process.env.MACCHIATO_CODEX_MIRROR, JSON.stringify({ offsets: {}, ords: {}, seeded: true }));
      const sent: any[] = [];
      const mirror = new Mirror(
        { agentLinkId: "al", isReady: true, send: (frame: unknown) => sent.push(frame) } as any,
        undefined,
        () => undefined,
        () => false,
      );
      (mirror as any).pollOnce();
      expect(sent.filter((frame) => frame.t === "mirror_append")).toEqual([]);
      expect((mirror as any).state.offsets[localSid]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (previousSessions === undefined) delete process.env.MACCHIATO_CODEX_SESSIONS_DIR;
      else process.env.MACCHIATO_CODEX_SESSIONS_DIR = previousSessions;
      if (previousMirror === undefined) delete process.env.MACCHIATO_CODEX_MIRROR;
      else process.env.MACCHIATO_CODEX_MIRROR = previousMirror;
    }
  });
});

describe("#393 srcId 收斂(live 回填鍵 == 鏡像鍵)", () => {
  it("srcIdSnapshot 折出 rollout 消息的 srcId 與鏡像 mirror_append 發的同鍵", async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "cx-393-"));
    const prevSessions = process.env.MACCHIATO_CODEX_SESSIONS_DIR;
    const prevMirror = process.env.MACCHIATO_CODEX_MIRROR;
    try {
      process.env.MACCHIATO_CODEX_SESSIONS_DIR = join(root, "sessions");
      process.env.MACCHIATO_CODEX_MIRROR = join(root, "mirror.json");
      const tid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0393";
      const dir = join(root, "sessions", "2026", "07", "24");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `rollout-2026-07-24T00-00-00-${tid}.jsonl`),
        [
          JSON.stringify({ type: "session_meta", payload: { cwd: "/x" } }),
          JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "你好" } }),
          JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "早上好" } }),
        ].join("\n") + "\n",
      );
      writeFileSync(process.env.MACCHIATO_CODEX_MIRROR, JSON.stringify({ offsets: {}, ords: {}, seeded: true }));
      const sent: any[] = [];
      const mirror = new Mirror({ agentLinkId: "al", isReady: true, send: (f: unknown) => sent.push(f) } as any);
      (mirror as any).pollOnce();
      const mirrored = sent
        .filter((f) => f.t === "mirror_append")
        .flatMap((f: any) => f.sessions[0].messages);
      const mUser = mirrored.find((x: any) => x.role === "user");
      const mAgent = mirrored.find((x: any) => x.role === "agent");
      // 只讀快照:同一 rollout 行折出的 srcId 必須與鏡像投遞的 dedup_key 完全一致 →
      // 跨進程重啟鏡像重投時撞 (session,dedup_key) 唯一索引被 onConflictDoNothing 吃掉。
      const snap = (mirror as any).srcIdSnapshot(tid) as Array<{ role: string; srcId: string }>;
      expect(snap.find((x) => x.role === "user")!.srcId).toBe(mUser.srcId);
      expect(snap.find((x) => x.role === "agent")!.srcId).toBe(mAgent.srcId);
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (prevSessions === undefined) delete process.env.MACCHIATO_CODEX_SESSIONS_DIR;
      else process.env.MACCHIATO_CODEX_SESSIONS_DIR = prevSessions;
      if (prevMirror === undefined) delete process.env.MACCHIATO_CODEX_MIRROR;
      else process.env.MACCHIATO_CODEX_MIRROR = prevMirror;
    }
  });
});

describe("#418 ord 記帳與增量路徑對齊(偏移路徑鍵收斂)", () => {
  /**
   * #393/#402 的收斂測試用 `{offsets:{},ords:{},seeded:true}` 從 0 起讀,繞開了 ordBase 偏移路徑。
   * #418:seed / endOrd 若用 split("\n").length,尾 \n 時 ordBase 恒多 1 → 偏移路徑重播的 srcId
   * ≠ 全量折的 srcId → server 去重失效。本組強制走「水位已在中段」再追加的路徑。
   */
  const envLine = (role: "user_message" | "agent_message", text: string) =>
    JSON.stringify({ type: "event_msg", payload: { type: role, message: text } }) + "\n";
  const metaLine = JSON.stringify({ type: "session_meta", payload: { cwd: "/x" } }) + "\n";

  async function withWorld(run: (ctx: {
    tid: string;
    file: string;
    Mirror: typeof Mirror;
    join: (...p: string[]) => string;
    appendFileSync: typeof import("node:fs").appendFileSync;
    writeFileSync: typeof import("node:fs").writeFileSync;
  }) => Promise<void> | void) {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "cx-418-"));
    const prevSessions = process.env.MACCHIATO_CODEX_SESSIONS_DIR;
    const prevMirror = process.env.MACCHIATO_CODEX_MIRROR;
    try {
      process.env.MACCHIATO_CODEX_SESSIONS_DIR = join(root, "sessions");
      process.env.MACCHIATO_CODEX_MIRROR = join(root, "mirror.json");
      const tid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0418";
      const dir = join(root, "sessions", "2026", "07", "25");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `rollout-2026-07-25T00-00-00-${tid}.jsonl`);
      await run({ tid, file, Mirror, join, appendFileSync, writeFileSync });
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (prevSessions === undefined) delete process.env.MACCHIATO_CODEX_SESSIONS_DIR;
      else process.env.MACCHIATO_CODEX_SESSIONS_DIR = prevSessions;
      if (prevMirror === undefined) delete process.env.MACCHIATO_CODEX_MIRROR;
      else process.env.MACCHIATO_CODEX_MIRROR = prevMirror;
    }
  }

  it("seed 基線後追加:偏移路徑 srcId == 全量 srcIdSnapshot", async () => {
    await withWorld(async ({ tid, file, Mirror, appendFileSync, writeFileSync }) => {
      // 存量兩行消息(含尾 \n)——首掃 seed 只基線不投;修前 ords=split 多 1。
      writeFileSync(file, metaLine + envLine("user_message", "存量 user") + envLine("agent_message", "存量 agent"));
      const sent: any[] = [];
      const m: any = new Mirror({ agentLinkId: "al", isReady: true, send: (f: unknown) => sent.push(f) } as any);
      m.pollOnce(); // seed 存量
      expect(sent.filter((f) => f.t === "mirror_append")).toHaveLength(0);
      expect(m.state.seeded).toBe(true);
      // 正確 nextOrd = 完整行數 3(meta+user+agent);split("\n").length 會是 4。
      expect(m.state.ords[tid]).toBe(3);

      appendFileSync(file, envLine("user_message", "續聊 user") + envLine("agent_message", "續聊 agent"));
      m.pollOnce();
      const pending = m.state.pendingMirrors?.[0];
      expect(pending).toBeTruthy();
      const mirrored = pending.frame.sessions[0].messages as Array<{ role: string; text: string; srcId: string }>;
      expect(mirrored.map((x) => x.text)).toEqual(["續聊 user", "續聊 agent"]);

      const snap = m.srcIdSnapshot(tid) as Array<{ role: string; text: string; srcId: string }>;
      const snapByText = Object.fromEntries(snap.map((x: any) => [x.text, x.srcId]));
      for (const msg of mirrored) {
        expect(msg.srcId).toBe(snapByText[msg.text]);
      }
    });
  });

  it("水位停在中段後追加:ACK 提交的 ordBase 偏移路徑仍與全量鍵收斂", async () => {
    await withWorld(async ({ tid, file, Mirror, appendFileSync, writeFileSync }) => {
      // seeded=true 從頭鏡像第一回合 → ACK 提交水位 → 再追加第二回合(真正走偏移 ordBase)。
      writeFileSync(
        file,
        metaLine + envLine("user_message", "第一拍 user") + envLine("agent_message", "第一拍 agent"),
      );
      writeFileSync(process.env.MACCHIATO_CODEX_MIRROR!, JSON.stringify({ offsets: {}, ords: {}, seeded: true }));
      const sent: any[] = [];
      const m: any = new Mirror({ agentLinkId: "al", isReady: true, send: (f: unknown) => sent.push(f) } as any);
      m.pollOnce();
      const first = m.state.pendingMirrors?.[0];
      expect(first).toBeTruthy();
      m.handleAck(first.batchId);
      // 修前若 seed/fastForward 用 split,此處 ords 會是 4;增量 lineCount 路徑應為 3。
      expect(m.state.ords[tid]).toBe(3);

      appendFileSync(file, envLine("user_message", "第二拍 user") + envLine("agent_message", "第二拍 agent"));
      m.pollOnce();
      const second = m.state.pendingMirrors?.[0];
      expect(second).toBeTruthy();
      const mirrored = second.frame.sessions[0].messages as Array<{ role: string; text: string; srcId: string }>;
      expect(mirrored.map((x) => x.text)).toEqual(["第二拍 user", "第二拍 agent"]);

      const snap = m.srcIdSnapshot(tid) as Array<{ text: string; srcId: string }>;
      const snapByText = Object.fromEntries(snap.map((x) => [x.text, x.srcId]));
      for (const msg of mirrored) {
        expect(msg.srcId).toBe(snapByText[msg.text]);
      }
      // 顯式對照:ord 必須是全文行號 3/4,不是 split 偏出的 4/5。
      expect(mirrored[0].srcId).toBe(srcIdFor(tid, { role: "user", text: "第二拍 user", ord: 3 }));
      expect(mirrored[1].srcId).toBe(srcIdFor(tid, { role: "agent", text: "第二拍 agent", ord: 4 }));
    });
  });

  it("E2E backfill endOrd ACK 後續聊:ord 不因尾 \\n 偏移", async () => {
    await withWorld(async ({ tid, file, Mirror, appendFileSync, writeFileSync }) => {
      writeFileSync(file, envLine("user_message", "祕密問題") + envLine("agent_message", "祕密回答"));
      const wireSid = "01K0CODEX418BACKFILLWIRE0001";
      const sent: any[] = [];
      const m: any = new Mirror(
        { agentLinkId: "al", isReady: true, send: (f: unknown) => sent.push(f) } as any,
        {
          isE2E: () => false,
          remove: () => {},
          disableReceiptForBackfill: () => ({ receipt: "test" }),
          encryptText: (_s: string, t: string) => t,
          encryptContent: (_s: string, c: { text: string }) => c,
        } as any,
      );
      await m.backfillE2E(wireSid, tid, "disable");
      const pendingKey = `disable:${wireSid}`;
      const pending = m.state.pendingE2EBackfills[pendingKey];
      expect(pending.endOrd).toBe(2); // 兩完整行;split 會給 3
      m.handleE2EBackfillResult(wireSid, "disable", pending.batchId, true);
      expect(m.state.ords[tid]).toBe(2);

      appendFileSync(file, envLine("user_message", "回灌後續聊"));
      // 清空 pending 後才能進普通 poll
      m.pollOnce();
      // seeded 未置且 offsets 已有 → 直接增量
      // 若 endOrd 多 1,鏡像鍵 ord=3 ≠ 全量折 ord=2。
      const batch = m.state.pendingMirrors?.[0];
      expect(batch).toBeTruthy();
      const msg = batch.frame.sessions[0].messages[0];
      expect(msg.text).toBe("回灌後續聊");
      expect(msg.srcId).toBe(srcIdFor(tid, { role: "user", text: "回灌後續聊", ord: 2 }));
      const snap = m.srcIdSnapshot(tid) as Array<{ text: string; srcId: string }>;
      expect(msg.srcId).toBe(snap.find((x) => x.text === "回灌後續聊")!.srcId);
    });
  });
});

describe("#347 disable backfill ACK 邊界", () => {
  it("發送明文 backfill 後保留 K_S；Mirror 不再自行 remove", async () => {
    const { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "cx-e2e-disable-"));
    const previousSessions = process.env.MACCHIATO_CODEX_SESSIONS_DIR;
    const previousMirror = process.env.MACCHIATO_CODEX_MIRROR;
    try {
      process.env.MACCHIATO_CODEX_SESSIONS_DIR = join(root, "sessions");
      process.env.MACCHIATO_CODEX_MIRROR = join(root, "mirror.json");
      const localSid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee3470";
      const wireSid = "01K0CODEXBACKFILLWIRE000001";
      const rolloutDir = join(root, "sessions", "2026", "07", "23");
      mkdirSync(rolloutDir, { recursive: true });
      const rollout = join(rolloutDir, `rollout-2026-07-23T00-00-00-${localSid}.jsonl`);
      writeFileSync(
        rollout,
        [
          JSON.stringify({
            type: "event_msg",
            payload: { type: "user_message", message: "祕密問題" },
          }),
          JSON.stringify({
            type: "event_msg",
            payload: { type: "agent_message", message: "祕密回答" },
          }),
          "",
        ].join("\n"),
      );
      const sent: any[] = [];
      const remove = vi.fn();
      const mirror = new Mirror(
        { agentLinkId: "al", isReady: true, send: (msg: any) => sent.push(msg) } as any,
        { remove, disableReceiptForBackfill: () => ({ receipt: "test" }) } as any,
      );

      await mirror.backfillE2E(wireSid, localSid, "disable");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        t: "e2e_backfill",
        hermesSessionId: wireSid,
        mode: "disable",
        found: true,
        session: { hermesSessionId: wireSid },
      });
      expect(sent[0].session.messages.map((m: any) => m.text)).toEqual(["祕密問題", "祕密回答"]);
      expect(sent[0].session.messages.map((m: any) => m.srcId)).toEqual([
        srcIdFor(localSid, { role: "user", text: "祕密問題", ord: 0 }),
        srcIdFor(localSid, { role: "agent", text: "祕密回答", ord: 1 }),
      ]);
      expect(remove).not.toHaveBeenCalled();
      expect((mirror as any).state.offsets[localSid]).toBeUndefined();
      expect((mirror as any).state.offsets[wireSid]).toBeUndefined();
      const firstBatchId = sent[0].batchId;
      expect(Object.keys((mirror as any).state.pendingE2EBackfills)).toHaveLength(1);
      mirror.fastForward(localSid);
      expect((mirror as any).state.offsets[localSid]).toBeUndefined(); // driven 回合旁路也必須服從 pending lock。

      mirror.handleE2EBackfillResult(wireSid, "disable", firstBatchId, false);
      expect((mirror as any).state.offsets[localSid]).toBeUndefined();
      expect(Object.keys((mirror as any).state.pendingE2EBackfills)).toHaveLength(0);
      expect(remove).not.toHaveBeenCalled();

      await mirror.backfillE2E(wireSid, localSid, "disable");
      const secondBatchId = sent.at(-1).batchId;
      mirror.handleE2EBackfillResult(wireSid, "disable", secondBatchId, true);
      expect((mirror as any).state.offsets[localSid]).toBe(statSync(rollout).size);
      expect((mirror as any).state.offsets[wireSid]).toBeUndefined();
      expect(Object.keys((mirror as any).state.pendingE2EBackfills)).toHaveLength(0);
      expect(remove).not.toHaveBeenCalled(); // key 刪除只歸 index 的成功 ACK 分支。
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (previousSessions === undefined) delete process.env.MACCHIATO_CODEX_SESSIONS_DIR;
      else process.env.MACCHIATO_CODEX_SESSIONS_DIR = previousSessions;
      if (previousMirror === undefined) delete process.env.MACCHIATO_CODEX_MIRROR;
      else process.env.MACCHIATO_CODEX_MIRROR = previousMirror;
    }
  });
});

describe("#6/#9 狀態文件兜底與裁剪", () => {
  it("#6 主文件損壞 → 從 .bak 恢復;#9 prune 消失超期才裁", async () => {
    const { Mirror } = await import("../src/codex/mirror");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const d = mkdtempSync(join(tmpdir(), "codex-state-"));
    process.env.MACCHIATO_CODEX_MIRROR = join(d, "mirror.json");
    const linkb: any = { agentLinkId: "AL", isReady: true, send: () => {}, onFrame: () => () => {} };
    const m1: any = new Mirror(linkb);
    m1.state = { offsets: { a: 9 }, ords: { a: 3 }, missingAt: {} };
    m1.save();
    m1.state = { offsets: { a: 12 }, ords: { a: 5 }, missingAt: {} };
    m1.save(); // 上一版落 .bak
    writeFileSync(join(d, "mirror.json"), "{corrupted");
    const m2: any = new Mirror(linkb);
    expect(m2.state.offsets.a).toBe(9); // #6:.bak 恢復
    expect(m2.state.ords.a).toBe(3);

    m2.state = {
      offsets: { live: 1, gone_old: 2, gone_new: 3 },
      ords: { live: 1, gone_old: 2 },
      missingAt: { gone_old: Date.now() - 8 * 24 * 3600 * 1000 },
    };
    m2.pruneState(new Set(["live"]));
    expect(Object.keys(m2.state.offsets).sort()).toEqual(["gone_new", "live"]);
    expect(m2.state.ords.gone_old).toBeUndefined(); // ords 同步清
    m2.pruneState(new Set(["live", "gone_new"]));
    expect(m2.state.missingAt.gone_new).toBeUndefined(); // 回歸即清
  });
});

describe("#161 墓碑", () => {
  it("tombstone 後 rollout 永不再撈;持久(load 白名單帶 tombstones)", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Mirror } = await import("../src/codex/mirror");
    const root = mkdtempSync(join(tmpdir(), "cx-tomb-"));
    process.env.MACCHIATO_CODEX_SESSIONS_DIR = join(root, "sessions");
    process.env.MACCHIATO_CODEX_MIRROR = join(root, "mirror.json");
    const tid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee61";
    const dir = join(root, "sessions", "2026", "07", "14");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `rollout-2026-07-14T00-00-00-${tid}.jsonl`);
    const line = (text: string) =>
      JSON.stringify({ timestamp: "2026-07-14T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: text } }) + "\n";
    writeFileSync(f, "");
    const sent: any[] = [];
    const linkb: any = { agentLinkId: "al", isReady: true, send: (m: any) => sent.push(m), onFrame: () => () => {} };
    const m = new Mirror(linkb);
    (m as any).pollOnce ? await (m as any).pollOnce() : (m as any).doPoll(); // baseline
    m.tombstone(tid);
    appendFileSync(f, line("刪後內容"));
    (m as any).pollOnce ? await (m as any).pollOnce() : (m as any).doPoll();
    expect(sent.filter((x) => x.t === "mirror_append")).toHaveLength(0);
    // 持久:新實例照樣跳
    const sent2: any[] = [];
    const m2 = new Mirror({ ...linkb, send: (x: any) => sent2.push(x) });
    (m2 as any).pollOnce ? await (m2 as any).pollOnce() : (m2 as any).doPoll();
    expect(sent2.filter((x) => x.t === "mirror_append")).toHaveLength(0);
  });
});

describe("#236 seeded 基線語義(pollOnce 核心路徑)", () => {
  const mkWorld = async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Mirror } = await import("../src/codex/mirror");
    const root = mkdtempSync(join(tmpdir(), "cx-seed-"));
    process.env.MACCHIATO_CODEX_SESSIONS_DIR = join(root, "sessions");
    process.env.MACCHIATO_CODEX_MIRROR = join(root, "mirror.json");
    const dir = join(root, "sessions", "2026", "07", "16");
    mkdirSync(dir, { recursive: true });
    const line = (role: "user_message" | "agent_message", text: string) =>
      JSON.stringify({ timestamp: "2026-07-16T00:00:01Z", type: "event_msg", payload: { type: role, message: text } }) + "\n";
    const rollout = (tid: string, ...texts: string[]) => {
      const f = join(dir, `rollout-2026-07-16T00-00-00-${tid}.jsonl`);
      writeFileSync(f, texts.map((t) => line("user_message", t)).join(""));
      return f;
    };
    return { Mirror, rollout, line, appendFileSync };
  };
  const T1 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee2360";
  const T2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee2361";
  const T3 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee2362";

  it("首掃基線存量會話(不回灌)並置 seeded;此後新 rollout 從頭鏡像", async () => {
    const { Mirror, rollout } = await mkWorld();
    rollout(T1, "存量歷史,不該被回灌");
    const sent: any[] = [];
    const m: any = new Mirror({ agentLinkId: "al", isReady: true, send: (x: any) => sent.push(x), onFrame: () => () => {} } as any);
    m.pollOnce();
    expect(sent.filter((x) => x.t === "mirror_append")).toHaveLength(0); // 存量只基線
    expect(m.state.seeded).toBe(true);
    rollout(T2, "終端新開會話的首拍");
    m.pollOnce();
    const batches = sent.filter((x) => x.t === "mirror_append");
    expect(batches).toHaveLength(1); // 新 rollout 從頭鏡像——原 bug 此處為 0(被誤基線)
    expect(batches[0].sessions[0].hermesSessionId).toBe(T2);
    expect(batches[0].sessions[0].messages[0].text).toBe("終端新開會話的首拍");
  });

  it("seeded 持久:重啟(新實例)後停機期間新建的 rollout 仍從頭鏡像", async () => {
    const { Mirror, rollout } = await mkWorld();
    rollout(T1, "存量");
    const m1: any = new Mirror({ agentLinkId: "al", isReady: true, send: () => {}, onFrame: () => () => {} } as any);
    m1.pollOnce(); // 首掃 + seeded 落盤
    rollout(T3, "連接器停機期間寫入的消息"); // 模擬停機窗口
    const sent: any[] = [];
    const m2: any = new Mirror({ agentLinkId: "al", isReady: true, send: (x: any) => sent.push(x), onFrame: () => () => {} } as any);
    expect(m2.state.seeded).toBe(true); // 持久載回
    m2.pollOnce();
    const batches = sent.filter((x) => x.t === "mirror_append");
    expect(batches).toHaveLength(1); // 原 bug:每進程重新基線 → 這段永丟
    expect(batches[0].sessions[0].messages[0].text).toBe("連接器停機期間寫入的消息");
  });

  it("舊安裝遷移:state 無 seeded 但有水位線 → 視為已 seeded", async () => {
    const { Mirror, rollout } = await mkWorld();
    rollout(T1, "x");
    const m1: any = new Mirror({ agentLinkId: "al", isReady: true, send: () => {}, onFrame: () => () => {} } as any);
    m1.state = { offsets: { [T1]: 5 }, ords: { [T1]: 1 } }; // 舊版落盤形狀(無 seeded)
    m1.save();
    const m2: any = new Mirror({ agentLinkId: "al", isReady: true, send: () => {}, onFrame: () => () => {} } as any);
    expect(m2.state.seeded).toBe(true);
  });

  it("linkb 未就緒的首掃不置 seeded(不誤把存量當新會話)", async () => {
    const { Mirror, rollout } = await mkWorld();
    rollout(T1, "存量");
    const sent: any[] = [];
    const linkb: any = { agentLinkId: "al", isReady: false, send: (x: any) => sent.push(x), onFrame: () => () => {} };
    const m: any = new Mirror(linkb);
    m.pollOnce(); // isReady=false → 早退
    expect(m.state.seeded).toBeUndefined();
    linkb.isReady = true;
    m.pollOnce(); // 真首掃:基線存量、置 seeded
    expect(sent.filter((x) => x.t === "mirror_append")).toHaveLength(0);
    expect(m.state.seeded).toBe(true);
  });

  it("#350 driven 會話在途不投遞也不提前推進水位", async () => {
    const { Mirror, rollout, appendFileSync, line } = await mkWorld();
    rollout(T1, "存量");
    const sent: any[] = [];
    const m: any = new Mirror({ agentLinkId: "al", isReady: true, send: (x: any) => sent.push(x), onFrame: () => () => {} } as any);
    m.pollOnce(); // seeded
    m.setDriven(T2); // T2 標為 driven(live 路徑獨佔)
    const f = rollout(T2, "driven 首拍");
    appendFileSync(f, line("agent_message", "driven 回覆"));
    m.pollOnce();
    expect(sent.filter((x) => x.t === "mirror_append")).toHaveLength(0); // driven → 不鏡像投遞
    expect(m.state.offsets[T2]).toBeUndefined(); // ACK 前不可越過 rollout
  });

  it("#349 app-driven E2E unsetDriven 後 terminal 續聊仍回 wire ULID 加密，不建明文 UUID 影子", async () => {
    const { Mirror, rollout, appendFileSync, line } = await mkWorld();
    rollout(T1, "存量");
    const wireSid = "01K0CODEXMIRRORWIRE00000001";
    const sent: any[] = [];
    const e2e: any = {
      isE2E: (sid: string) => sid === wireSid,
      encryptText: (sid: string, text: string) => `title:${sid}:${text}`,
      encryptContent: (sid: string, content: { text: string }) => `enc:${sid}:${content.text}`,
    };
    const m: any = new Mirror(
      { agentLinkId: "al", isReady: true, send: (x: any) => sent.push(x), onFrame: () => () => {} } as any,
      e2e,
      (localSid: string) => (localSid === T2 ? wireSid : undefined),
    );
    m.pollOnce(); // seeded

    m.setDriven(T2);
    const f = rollout(T2, "app live user");
    appendFileSync(f, line("agent_message", "app live reply"));
    m.pollOnce(); // live 路徑獨佔，不推本地 UUID 水位
    m.unsetDriven(T2);
    appendFileSync(f, line("user_message", "terminal secret"));
    appendFileSync(f, line("agent_message", "terminal answer"));
    // 每帧只有 server ACK 后才提交候选水位；逐帧 drain，覆盖断线可重放路径。
    for (let i = 0; i < 8; i++) {
      m.pollOnce();
      const pending = m.state.pendingMirrors?.[0];
      if (!pending) break;
      expect(m.state.offsets[T2] ?? 0).toBeLessThan(pending.offsets[T2]);
      m.handleAck(pending.batchId);
    }

    const batches = sent.filter((x) => x.t === "mirror_append");
    const sessions = batches.flatMap((batch) => batch.sessions);
    expect(sessions.every((session) => session.hermesSessionId === wireSid && session.e2e === true)).toBe(true);
    expect(sessions.flatMap((session) => session.messages).map((message) => message.enc)).toEqual([
      `enc:${wireSid}:app live user`,
      `enc:${wireSid}:app live reply`,
      `enc:${wireSid}:terminal secret`,
      `enc:${wireSid}:terminal answer`,
    ]);
    expect(sessions.flatMap((session) => session.messages).every((message: any) => message.text === undefined)).toBe(true);
    expect(sent.some((frame) => frame.sessions?.some((session: any) => session.hermesSessionId === T2))).toBe(false);
  });

  it("影子兜底:非 E2E 的 driven thread,unsetDriven 後絕不以本地 threadId 建明文會話", async () => {
    const { Mirror, rollout, appendFileSync, line } = await mkWorld();
    rollout(T1, "存量");
    const sent: any[] = [];
    const m: any = new Mirror({ agentLinkId: "al", isReady: true, send: (x: any) => sent.push(x), onFrame: () => () => {} } as any);
    m.pollOnce(); // seeded

    m.setDriven(T2);
    const f = rollout(T2, "app 發的 prompt");
    appendFileSync(f, line("agent_message", "app 收到的回覆"));
    m.unsetDriven(T2); // 內部觸發一次 poll
    m.pollOnce();
    m.pollOnce();

    // 2026-07-12 影子會話事故同款:fastForward 不再推水位後,offsets[T2] 未定義 → startOff=0 →
    // 會把整條 rollout 以 hermesSessionId=T2 全量重發,server createIfMissing 建出第二個明文會話。
    expect(sent.filter((x) => x.t === "mirror_append")).toHaveLength(0);
    expect(sent.some((frame) => frame.sessions?.some((s: any) => s.hermesSessionId === T2))).toBe(false);
    expect(m.counters.mirrorGhostBlocked).toBeGreaterThan(0);
    expect(m.state.offsets[T2]).toBeUndefined(); // 不推水位:E2E 之後開啟仍能按密文補投
  });

  it("影子兜底跨重啟:markDrivenUuid 灌入的 thread 同樣不建明文會話", async () => {
    const { Mirror, rollout } = await mkWorld();
    rollout(T1, "存量");
    const sent: any[] = [];
    const m: any = new Mirror({ agentLinkId: "al", isReady: true, send: (x: any) => sent.push(x), onFrame: () => () => {} } as any);
    m.pollOnce(); // seeded
    m.markDrivenUuid(T3); // Drive 啟動時從持久映射灌入
    rollout(T3, "重啟後終端續聊");
    m.pollOnce();
    expect(sent.filter((x) => x.t === "mirror_append")).toHaveLength(0);
  });

  it("#308 off:unsetDriven 不得全量掃 rollout(終端會話照樣不進 app)", async () => {
    const { Mirror, rollout } = await mkWorld();
    rollout(T1, "純終端會話,用戶要求不進 app");
    process.env.MACCHIATO_MIRROR = "off";
    try {
      const sent: any[] = [];
      const m: any = new Mirror({ agentLinkId: "al", isReady: true, send: (x: any) => sent.push(x), onFrame: () => () => {} } as any);
      m.setDriven(T2);
      m.unsetDriven(T2); // 修前:無條件全量 poll → 終端 rollout 被鏡像進 app
      expect(sent.filter((x) => x.t === "mirror_append")).toHaveLength(0);
      expect(m.state.offsets[T1]).toBeUndefined();
    } finally {
      delete process.env.MACCHIATO_MIRROR;
    }
  });

  it("#308 off:E2E driven 回合仍可靠投遞——定向輪詢兜住晚落盤的尾巴", async () => {
    const { Mirror, rollout, appendFileSync, line } = await mkWorld();
    rollout(T1, "終端會話,off 下絕不投");
    process.env.MACCHIATO_MIRROR = "off";
    try {
      const wireSid = "01K0CODEXMIRROROFFWIRE00001";
      const sent: any[] = [];
      const e2e: any = {
        isE2E: (sid: string) => sid === wireSid,
        encryptText: (_s: string, t: string) => `T:${t}`,
        encryptContent: (_s: string, c: { text: string }) => `E:${c.text}`,
      };
      const m: any = new Mirror(
        { agentLinkId: "al", isReady: true, send: (x: any) => sent.push(x), onFrame: () => () => {} } as any,
        e2e,
        (localSid: string) => (localSid === T2 ? wireSid : undefined),
      );
      m.setDriven(T2);
      const f = rollout(T2, "E2E driven 問題");
      vi.useFakeTimers();
      m.start(); // off:只裝定向輪詢
      m.unsetDriven(T2);
      m.handleAck(sent.filter((x) => x.t === "mirror_append").at(-1).batchId);
      appendFileSync(f, line("agent_message", "晚落盤的最後一塊")); // 尾巴晚落盤
      vi.advanceTimersByTime(30_000);
      vi.useRealTimers();

      const byBatch = new Map<string, any>();
      for (const frame of sent.filter((x) => x.t === "mirror_append")) byBatch.set(frame.batchId, frame);
      const msgs = [...byBatch.values()].flatMap((x: any) => x.sessions[0].messages);
      expect(msgs.map((x: any) => x.enc)).toEqual(["E:E2E driven 問題", "E:晚落盤的最後一塊"]);
      expect([...byBatch.values()].every((x: any) => x.sessions[0].hermesSessionId === wireSid)).toBe(true);
      expect(m.state.offsets[T1]).toBeUndefined(); // 終端 rollout 一幀未發、水位未動
      expect(m.state.seeded).not.toBe(true); // 定向輪詢不得謊稱首掃完成
    } finally {
      delete process.env.MACCHIATO_MIRROR;
    }
  });

  it("#350 E2E 回合末尾巴在亞秒內追平,不必等滿一個 5s 輪詢周期", async () => {
    // 取消 fire-and-forget 直發後 E2E 回覆只剩 rollout 檔一條路;回合 result 常早於 Codex
    // 寫完尾巴 → unsetDriven 那次即時 poll 讀不到最後一塊,舊行為要等下一個 POLL_MS(5s)tick。
    const { Mirror, rollout, appendFileSync, line } = await mkWorld();
    rollout(T1, "存量");
    const wireSid = "01K0CODEXTAILPOLLWIRE000001";
    const sent: any[] = [];
    const e2e: any = {
      isE2E: (sid: string) => sid === wireSid,
      encryptText: (_s: string, t: string) => `T:${t}`,
      encryptContent: (_s: string, c: { text: string }) => `E:${c.text}`,
    };
    const m: any = new Mirror(
      { agentLinkId: "al", isReady: true, send: (x: any) => sent.push(x), onFrame: () => () => {} } as any,
      e2e,
      (localSid: string) => (localSid === T2 ? wireSid : undefined),
    );
    m.pollOnce(); // seeded
    m.setDriven(T2);
    const f = rollout(T2, "E2E 問題");
    vi.useFakeTimers();
    try {
      m.start();
      m.unsetDriven(T2); // 即時 poll:此刻尾巴還沒落盤
      m.handleAck(sent.filter((x) => x.t === "mirror_append").at(-1).batchId);
      appendFileSync(f, line("agent_message", "回合末晚落盤的回覆"));
      // 只推進 1s——遠不到一個 POLL_MS(5s)。修前這裡一幀都不會有。
      vi.advanceTimersByTime(1_000);
      const tail = sent.filter((x) => x.t === "mirror_append").at(-1);
      expect(tail.sessions[0].messages.map((x: any) => x.enc)).toEqual(["E:回合末晚落盤的回覆"]);
      expect(tail.sessions[0].hermesSessionId).toBe(wireSid);
      // 排程有界:停掉鏡像後不再有殘留定時器繼續打。
      m.stop();
      const before = sent.filter((x) => x.t === "mirror_append").length;
      vi.advanceTimersByTime(60_000);
      expect(sent.filter((x) => x.t === "mirror_append")).toHaveLength(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("#268 mirror_nack 回退水位線 → 重發同批", async () => {
    const { Mirror, rollout } = await mkWorld();
    rollout(T1, "存量");
    const sent: any[] = [];
    const m: any = new Mirror({ agentLinkId: "al", isReady: true, send: (x: any) => sent.push(x), onFrame: () => () => {} } as any);
    m.pollOnce(); // seeded
    rollout(T2, "要被 nack 的消息");
    m.pollOnce();
    const batch = sent.filter((x) => x.t === "mirror_append").at(-1);
    expect(batch.sessions[0].messages[0].text).toBe("要被 nack 的消息");
    m.handleNack(batch.batchId); // 回退
    m.pollOnce();
    const re = sent.filter((x) => x.t === "mirror_append").at(-1);
    expect(re.sessions[0].messages[0].text).toBe("要被 nack 的消息"); // 重發
  });

  it("#350 断线重建实例重放同一 batchId，ACK 前水位不动、ACK 后才提交", async () => {
    const { Mirror, rollout } = await mkWorld();
    rollout(T1, "存量");
    const m1: any = new Mirror({
      agentLinkId: "al",
      isReady: true,
      send: () => {},
      onFrame: () => () => {},
    } as any);
    m1.pollOnce();
    rollout(T2, "必须重放");
    const first: any[] = [];
    const live1: any = new Mirror({
      agentLinkId: "al",
      isReady: true,
      send: (frame: any) => first.push(frame),
      onFrame: () => () => {},
    } as any);
    live1.pollOnce();
    const original = first.find((frame) => frame.t === "mirror_append");
    expect(live1.state.offsets[T2]).toBeUndefined();

    const replayed: any[] = [];
    const m2: any = new Mirror({
      agentLinkId: "al",
      isReady: true,
      send: (frame: any) => replayed.push(frame),
      onFrame: () => () => {},
    } as any);
    m2.pollOnce();
    const replay = replayed.find((frame) => frame.t === "mirror_append");
    expect(replay.batchId).toBe(original.batchId);
    expect(replay.sessions).toEqual(original.sessions);
    expect(m2.state.offsets[T2]).toBeUndefined();
    m2.handleAck(replay.batchId);
    expect(m2.state.offsets[T2]).toBeGreaterThan(0);
  });
});
