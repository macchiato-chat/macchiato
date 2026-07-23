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
      expect((mirror as any).pendingE2EBackfills.size).toBe(1);
      mirror.fastForward(localSid);
      expect((mirror as any).state.offsets[localSid]).toBeUndefined(); // driven 回合旁路也必須服從 pending lock。

      mirror.handleE2EBackfillResult(wireSid, "disable", false);
      expect((mirror as any).state.offsets[localSid]).toBeUndefined();
      expect((mirror as any).pendingE2EBackfills.size).toBe(0);
      expect(remove).not.toHaveBeenCalled();

      await mirror.backfillE2E(wireSid, localSid, "disable");
      mirror.handleE2EBackfillResult(wireSid, "disable", true);
      expect((mirror as any).state.offsets[localSid]).toBe(statSync(rollout).size);
      expect((mirror as any).state.offsets[wireSid]).toBeUndefined();
      expect((mirror as any).pendingE2EBackfills.size).toBe(0);
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

  it("#268 driven 會話只快進不投遞(live 獨佔)", async () => {
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
    expect(m.state.offsets[T2]).toBeGreaterThan(0); // 只快進水位線
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
    m.pollOnce(); // live 路徑獨佔，只快進本地 UUID 水位
    m.unsetDriven(T2);
    appendFileSync(f, line("user_message", "terminal secret"));
    appendFileSync(f, line("agent_message", "terminal answer"));
    m.pollOnce();

    const batches = sent.filter((x) => x.t === "mirror_append");
    expect(batches).toHaveLength(1);
    expect(batches[0].sessions).toHaveLength(1);
    expect(batches[0].sessions[0]).toMatchObject({
      hermesSessionId: wireSid,
      e2e: true,
      messages: [
        { role: "user", enc: `enc:${wireSid}:terminal secret` },
        { role: "agent", enc: `enc:${wireSid}:terminal answer` },
      ],
    });
    expect(batches[0].sessions[0].messages.every((message: any) => message.text === undefined)).toBe(true);
    expect(sent.some((frame) => frame.sessions?.some((session: any) => session.hermesSessionId === T2))).toBe(false);
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
});
