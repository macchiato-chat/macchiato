import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announceImportAvailable, runImport } from "../src/cc/history-import";
import { Drive } from "../src/cc/drive";
import { Mirror } from "../src/cc/mirror";

const E2E_SID = "11111111-1111-4111-8111-111111111111";
const ROTATED_E2E_SID = "33333333-3333-4333-8333-333333333333";
const E2E_WIRE_SID = "01K0CCHISTORYWIRE0000000001";
const PLAIN_SID = "22222222-2222-4222-8222-222222222222";

describe("#347 history import E2E wire boundary", () => {
  let root: string;
  let previousConfigDir: string | undefined;
  let previousSessions: string | undefined;
  let previousMirror: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cc-import-e2e-"));
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    previousSessions = process.env.MACCHIATO_CC_SESSIONS;
    previousMirror = process.env.MACCHIATO_CC_MIRROR;
    process.env.CLAUDE_CONFIG_DIR = root;
    process.env.MACCHIATO_CC_SESSIONS = join(root, "drive-map.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    if (previousSessions === undefined) delete process.env.MACCHIATO_CC_SESSIONS;
    else process.env.MACCHIATO_CC_SESSIONS = previousSessions;
    if (previousMirror === undefined) delete process.env.MACCHIATO_CC_MIRROR;
    else process.env.MACCHIATO_CC_MIRROR = previousMirror;
  });

  function writeTranscript(sid: string, cwd: string, text: string): void {
    const dir = join(root, "projects", cwd.replaceAll("/", "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sid}.jsonl`),
      JSON.stringify({
        type: "user",
        uuid: `${sid}-message`,
        cwd,
        timestamp: "2026-07-23T00:00:00.000Z",
        message: { role: "user", content: text },
      }) + "\n",
    );
  }

  function mappedE2EStatus(): { isE2E(localSid: string): boolean } {
    writeFileSync(
      process.env.MACCHIATO_CC_SESSIONS!,
      JSON.stringify({
        v: 2,
        map: { [E2E_WIRE_SID]: E2E_SID, [PLAIN_SID]: PLAIN_SID },
        aliases: {
          [E2E_WIRE_SID]: [E2E_SID],
          [PLAIN_SID]: [PLAIN_SID],
        },
        aliasHistoryTrusted: true,
        cwds: {},
        permModes: {},
        models: {},
        efforts: {},
        pending: [],
      }),
    );
    const drive = new Drive(
      { onReady: () => () => {} } as any,
      undefined,
      {
        isE2E: (sid: string) => sid === E2E_WIRE_SID,
        protectedSessionIds: () => [E2E_WIRE_SID],
        hasServerStateSnapshot: () => true,
      } as any,
    );
    return drive.localSessionE2EStatus();
  }

  it("混合批剔除 E2E session，普通 session 与 announce 计数保留", () => {
    writeTranscript(E2E_SID, "/secret-project", "绝密问题");
    writeTranscript(PLAIN_SID, "/plain-project", "普通问题");
    const e2e = mappedE2EStatus();
    expect(e2e.isE2E(E2E_SID)).toBe(true); // local UUID 經反向映射命中 wire ULID
    const sent: any[] = [];
    const linkb = { send: (message: unknown) => sent.push(message) } as any;

    announceImportAvailable(linkb, e2e);
    runImport(linkb, e2e);

    expect(sent[0]).toEqual({
      t: "import_available",
      count: 1,
      projects: [{ name: "/plain-project", count: 1 }],
    });
    const batches = sent.filter((message) => message.t === "import_batch");
    expect(batches).toHaveLength(1);
    expect(batches[0].done).toBe(true);
    expect(batches[0].sessions.map((session: any) => session.hermesSessionId)).toEqual([PLAIN_SID]);
    expect(JSON.stringify(sent)).not.toContain("绝密问题");
    expect(JSON.stringify(sent)).not.toContain("/secret-project");
  });

  it("全 E2E 批仍发送空 sessions 的 done:true 终止帧", () => {
    writeTranscript(E2E_SID, "/secret-project", "绝密问题");
    const sent: any[] = [];
    const linkb = { send: (message: unknown) => sent.push(message) } as any;

    runImport(linkb, { isE2E: () => true });

    expect(sent).toEqual([{ t: "import_batch", sessions: [], done: true }]);
  });

  it("身份主档与备份都损坏 + wire E2E → 整体 fail-closed，任一本地 transcript 都不导入", () => {
    writeTranscript(PLAIN_SID, "/plain-project", "本来普通但身份已不可证明");
    writeFileSync(process.env.MACCHIATO_CC_SESSIONS!, "{broken");
    writeFileSync(`${process.env.MACCHIATO_CC_SESSIONS!}.bak`, "{also-broken");
    const drive = new Drive(
      { onReady: () => () => {} } as any,
      undefined,
      {
        isE2E: (sid: string) => sid === E2E_WIRE_SID,
        protectedSessionIds: () => [E2E_WIRE_SID],
      } as any,
    );
    expect(() => drive.assertE2EIdentitySafe()).toThrow(/identity map unavailable/);
    const sent: any[] = [];
    runImport(
      { send: (message: unknown) => sent.push(message) } as any,
      drive.localSessionE2EStatus(),
    );
    expect(sent).toEqual([{ t: "import_batch", sessions: [], done: true }]);
    expect(JSON.stringify(sent)).not.toContain("身份已不可证明");
  });

  it.each([
    ["缺 aliases 字段", undefined],
    ["aliases 空数组", { [E2E_WIRE_SID]: [] }],
    ["aliases 重复 UUID", { [E2E_WIRE_SID]: [E2E_SID, E2E_SID] }],
    ["aliases 漏 current map", { [E2E_WIRE_SID]: [ROTATED_E2E_SID] }],
  ])("畸形 trusted snapshot（%s）不能被 loader 静默修成可信", (_case, aliases) => {
    writeFileSync(
      process.env.MACCHIATO_CC_SESSIONS!,
      JSON.stringify({
        v: 2,
        map: { [E2E_WIRE_SID]: E2E_SID },
        ...(aliases === undefined ? {} : { aliases }),
        aliasHistoryTrusted: true,
        cwds: {},
        permModes: {},
        models: {},
        efforts: {},
        pending: [],
      }),
    );
    const drive = new Drive(
      { onReady: () => () => {} } as any,
      undefined,
      {
        isE2E: (sid: string) => sid === E2E_WIRE_SID,
        protectedSessionIds: () => [E2E_WIRE_SID],
        hasServerStateSnapshot: () => true,
      } as any,
    );
    expect(() => drive.assertE2EIdentitySafe()).toThrow(/identity map unavailable/);
    expect(drive.localSessionE2EStatus().isE2E(PLAIN_SID)).toBe(true);
    expect(drive.plaintextLocalMirrorAllowed(PLAIN_SID)).toBe(false);
  });

  it("全新安装无 E2E protection floor → 不被缺失身份档永久阻塞", () => {
    const drive = new Drive(
      { onReady: () => () => {} } as any,
      undefined,
      {
        isE2E: () => false,
        protectedSessionIds: () => [],
        hasServerStateSnapshot: () => true,
      } as any,
    );
    expect(() => drive.assertE2EIdentitySafe()).not.toThrow();
    expect(drive.localSessionE2EStatus().isE2E(PLAIN_SID)).toBe(false);
    expect((drive as any).saveMap()).toBe(true);
    expect(
      JSON.parse(readFileSync(process.env.MACCHIATO_CC_SESSIONS!, "utf8"))
        .aliasHistoryTrusted,
    ).toBe(true);
  });

  it("init rotation 立即持久所有 alias；同进程 import 与重启后的 mirror 都不泄露旧/新 transcript", () => {
    writeTranscript(E2E_SID, "/secret-old", "轮换前绝密");
    writeTranscript(ROTATED_E2E_SID, "/secret-new", "轮换后绝密");
    writeTranscript(PLAIN_SID, "/plain-project", "普通问题");
    // 舊 v2 沒有 aliases：只 seed current 供 live 使用，歷史完整性仍保持 untrusted。
    writeFileSync(
      process.env.MACCHIATO_CC_SESSIONS!,
      JSON.stringify({
        v: 2,
        map: { [E2E_WIRE_SID]: E2E_SID },
        cwds: {},
        permModes: {},
        models: {},
        efforts: {},
        pending: [],
      }),
    );
    const e2e = {
      isE2E: (sid: string) => sid === E2E_WIRE_SID,
      protectedSessionIds: () => [E2E_WIRE_SID],
      encryptText: (_sid: string, text: string) => `enc:${text.length}`,
      encryptContent: (_sid: string, value: unknown) => `enc:${JSON.stringify(value).length}`,
    } as any;
    const mirrorCalls: string[] = [];
    const drive = new Drive(
      { onReady: () => () => {} } as any,
      {
        setDriven: (sid: string) => mirrorCalls.push(`set:${sid}`),
        markDrivenUuid: (sid: string) => mirrorCalls.push(`mark:${sid}`),
      } as any,
      e2e,
    );

    // SDK init 回了新 uuid：handleMessage 返回前，current + aliases 已落主檔與 .bak。
    (drive as any).handleMessage(
      { sid: E2E_WIRE_SID, turn: { completed: true }, closing: false },
      { type: "system", subtype: "init", session_id: ROTATED_E2E_SID },
    );
    const persisted = JSON.parse(
      readFileSync(process.env.MACCHIATO_CC_SESSIONS!, "utf8"),
    ) as {
      map: Record<string, string>;
      aliases: Record<string, string[]>;
    };
    expect(persisted.map[E2E_WIRE_SID]).toBe(ROTATED_E2E_SID);
    expect(persisted.aliases[E2E_WIRE_SID]).toEqual([E2E_SID, ROTATED_E2E_SID]);
    expect((persisted as any).aliasHistoryTrusted).toBe(false);
    expect(
      JSON.parse(readFileSync(`${process.env.MACCHIATO_CC_SESSIONS!}.bak`, "utf8")),
    ).toEqual(persisted);
    expect(mirrorCalls).toContain(`mark:${ROTATED_E2E_SID}`);
    expect(drive.e2eWireSessionIdFor(E2E_SID)).toBe(E2E_WIRE_SID);
    expect(drive.e2eWireSessionIdFor(ROTATED_E2E_SID)).toBe(E2E_WIRE_SID);

    const immediate: any[] = [];
    runImport(
      { send: (message: unknown) => immediate.push(message) } as any,
      drive.localSessionE2EStatus(),
    );
    expect(immediate).toEqual([{ t: "import_batch", sessions: [], done: true }]);
    expect(JSON.stringify(immediate)).not.toContain("普通问题");
    expect(JSON.stringify(immediate)).not.toContain("轮换前绝密");
    expect(JSON.stringify(immediate)).not.toContain("轮换后绝密");

    // 進程重啟：Drive 從 aliases 把舊、新 uuid 都重新灌為 driven identity；
    // Mirror 即使掃到兩份仍不得建立 plaintext shadow 或推進其水位線。
    process.env.MACCHIATO_CC_MIRROR = join(root, "mirror-state.json");
    writeFileSync(
      process.env.MACCHIATO_CC_MIRROR,
      JSON.stringify({ offsets: {}, titles: {}, seeded: true }),
    );
    const afterRestart: any[] = [];
    const linkb = {
      agentLinkId: "AL1",
      isReady: true,
      send: (message: unknown) => afterRestart.push(message),
      onReady: () => () => {},
    } as any;
    let restartedDrive!: Drive;
    const restartedMirror = new Mirror(
      linkb,
      e2e,
      (localSid) => restartedDrive.e2eWireSessionIdFor(localSid),
      (localSid) => restartedDrive.plaintextLocalMirrorAllowed(localSid),
    );
    restartedDrive = new Drive(linkb, restartedMirror, e2e);
    expect(() => restartedDrive.assertE2EIdentitySafe()).not.toThrow();
    (restartedMirror as any).doPoll();
    const mirrorAppends = afterRestart.filter((message) => message.t === "mirror_append");
    expect(mirrorAppends).toEqual([]);
    expect(JSON.stringify(afterRestart)).not.toContain("轮换前绝密");
    expect(JSON.stringify(afterRestart)).not.toContain("轮换后绝密");
    expect((restartedMirror as any).state.offsets[E2E_SID]).toBe(0);
    expect((restartedMirror as any).state.offsets[ROTATED_E2E_SID]).toBe(0);
  });

  it("wire sid 本身是 UUID 时 resume fork 也持久 old/new aliases，重启后 current 跟随新 UUID", () => {
    writeTranscript(E2E_SID, "/direct-old", "direct 轮换前绝密");
    writeTranscript(ROTATED_E2E_SID, "/direct-new", "direct 轮换后绝密");
    writeFileSync(
      process.env.MACCHIATO_CC_SESSIONS!,
      JSON.stringify({
        v: 2,
        map: {},
        aliases: {},
        aliasHistoryTrusted: true,
        cwds: {},
        permModes: {},
        models: {},
        efforts: {},
        pending: [],
      }),
    );
    const e2e = {
      isE2E: (sid: string) => sid === E2E_SID,
      protectedSessionIds: () => [E2E_SID],
      hasServerStateSnapshot: () => true,
      encryptText: (_sid: string, text: string) => `enc-title:${text.length}`,
      encryptContent: (_sid: string, value: unknown) =>
        `enc-body:${JSON.stringify(value).length}`,
    } as any;
    const marked: string[] = [];
    const mirror = {
      setDriven: () => {},
      markDrivenUuid: (sid: string) => marked.push(sid),
    } as any;
    const drive = new Drive({ onReady: () => () => {} } as any, mirror, e2e);

    (drive as any).handleMessage(
      { sid: E2E_SID, turn: { completed: true }, closing: false },
      { type: "system", subtype: "init", session_id: ROTATED_E2E_SID },
    );
    const persisted = JSON.parse(
      readFileSync(process.env.MACCHIATO_CC_SESSIONS!, "utf8"),
    );
    expect(persisted.map[E2E_SID]).toBe(ROTATED_E2E_SID);
    expect(persisted.aliases[E2E_SID]).toEqual([E2E_SID, ROTATED_E2E_SID]);
    expect(persisted.aliasHistoryTrusted).toBe(true);
    expect(drive.localSessionIdFor(E2E_SID)).toBe(ROTATED_E2E_SID);
    expect(drive.e2eWireSessionIdFor(E2E_SID)).toBe(E2E_SID);
    expect(drive.e2eWireSessionIdFor(ROTATED_E2E_SID)).toBe(E2E_SID);
    expect(drive.localSessionE2EStatus().isE2E(E2E_SID)).toBe(true);
    expect(drive.localSessionE2EStatus().isE2E(ROTATED_E2E_SID)).toBe(true);
    expect(marked).toContain(ROTATED_E2E_SID);
    const imported: any[] = [];
    runImport(
      { send: (message: unknown) => imported.push(message) } as any,
      drive.localSessionE2EStatus(),
    );
    expect(imported).toEqual([{ t: "import_batch", sessions: [], done: true }]);
    expect(JSON.stringify(imported)).not.toContain("direct 轮换");

    const restartedMarked: string[] = [];
    const restarted = new Drive(
      { onReady: () => () => {} } as any,
      {
        markDrivenUuid: (sid: string) => restartedMarked.push(sid),
      } as any,
      e2e,
    );
    expect(restarted.localSessionIdFor(E2E_SID)).toBe(ROTATED_E2E_SID);
    expect(restartedMarked).toEqual([E2E_SID, ROTATED_E2E_SID]);

    process.env.MACCHIATO_CC_MIRROR = join(root, "direct-mirror-state.json");
    writeFileSync(
      process.env.MACCHIATO_CC_MIRROR,
      JSON.stringify({ offsets: {}, titles: {}, seeded: true }),
    );
    const sent: any[] = [];
    const encryptedMirror = new Mirror(
      {
        agentLinkId: "AL1",
        isReady: true,
        send: (message: unknown) => sent.push(message),
      } as any,
      e2e,
      (localSid) => restarted.e2eWireSessionIdFor(localSid),
      (localSid) => restarted.plaintextLocalMirrorAllowed(localSid),
    );
    (encryptedMirror as any).doPoll();
    const sessions = sent
      .filter((message) => message.t === "mirror_append")
      .flatMap((message) => message.sessions);
    expect(sessions).toHaveLength(2);
    expect(
      sessions.every(
        (session) =>
          session.hermesSessionId === E2E_SID &&
          session.e2e === true &&
          session.messages.every((message: any) => typeof message.enc === "string"),
      ),
    ).toBe(true);
    expect(JSON.stringify(sessions)).not.toContain("direct 轮换前绝密");
    expect(JSON.stringify(sessions)).not.toContain("direct 轮换后绝密");
  });

  it("alias history 即使可信，只要存在 protected E2E，完全未知 UUID 的 import/mirror 仍冻结", () => {
    writeTranscript(PLAIN_SID, "/unknown-fork", "未知 UUID 可能是崩溃窗口里的 E2E fork");
    writeFileSync(
      process.env.MACCHIATO_CC_SESSIONS!,
      JSON.stringify({
        v: 2,
        map: { [E2E_WIRE_SID]: E2E_SID },
        aliases: { [E2E_WIRE_SID]: [E2E_SID] },
        aliasHistoryTrusted: true,
        cwds: {},
        permModes: {},
        models: {},
        efforts: {},
        pending: [],
      }),
    );
    const e2e = {
      isE2E: (sid: string) => sid === E2E_WIRE_SID,
      protectedSessionIds: () => [E2E_WIRE_SID],
      hasServerStateSnapshot: () => true,
    } as any;
    const drive = new Drive({ onReady: () => () => {} } as any, undefined, e2e);
    expect(drive.localSessionE2EStatus().isE2E(PLAIN_SID)).toBe(true);
    expect(drive.plaintextLocalMirrorAllowed(PLAIN_SID)).toBe(false);

    process.env.MACCHIATO_CC_MIRROR = join(root, "unknown-mirror-state.json");
    writeFileSync(
      process.env.MACCHIATO_CC_MIRROR,
      JSON.stringify({ offsets: {}, titles: {}, seeded: true }),
    );
    const sent: any[] = [];
    const mirror = new Mirror(
      {
        agentLinkId: "AL1",
        isReady: true,
        send: (message: unknown) => sent.push(message),
      } as any,
      e2e,
      (localSid) => drive.e2eWireSessionIdFor(localSid),
      (localSid) => drive.plaintextLocalMirrorAllowed(localSid),
    );
    (mirror as any).doPoll();
    expect(sent.filter((message) => message.t === "mirror_append")).toEqual([]);
    expect((mirror as any).state.offsets[PLAIN_SID]).toBe(0);
    expect(JSON.stringify(sent)).not.toContain("未知 UUID");
  });

  it("重启读到 abandoned pending 时撤销 alias 完整性，清 marker 的普通 save 不得再自升", () => {
    writeFileSync(
      process.env.MACCHIATO_CC_SESSIONS!,
      JSON.stringify({
        v: 2,
        map: { [E2E_WIRE_SID]: E2E_SID },
        aliases: { [E2E_WIRE_SID]: [E2E_SID] },
        aliasHistoryTrusted: true,
        cwds: {},
        permModes: {},
        models: {},
        efforts: {},
        pending: [E2E_WIRE_SID],
      }),
    );
    const drive = new Drive(
      { onReady: () => () => {} } as any,
      undefined,
      {
        isE2E: (sid: string) => sid === E2E_WIRE_SID,
        protectedSessionIds: () => [E2E_WIRE_SID],
        hasServerStateSnapshot: () => false,
      } as any,
    );
    const persisted = JSON.parse(
      readFileSync(process.env.MACCHIATO_CC_SESSIONS!, "utf8"),
    );
    expect(persisted.pending).toEqual([]);
    expect(persisted.aliasHistoryTrusted).toBe(false);
    expect(() => drive.assertE2EIdentitySafe()).not.toThrow(); // current live 映射仍可用
    expect(drive.localSessionE2EStatus().isE2E(PLAIN_SID)).toBe(true);
    expect(drive.plaintextLocalMirrorAllowed(PLAIN_SID)).toBe(false);
  });

  it("init rotation 持久化失败即 poison/fatal，不能继续把新 UUID 交给 mirror", () => {
    writeFileSync(
      process.env.MACCHIATO_CC_SESSIONS!,
      JSON.stringify({
        v: 2,
        map: {},
        aliases: {},
        aliasHistoryTrusted: true,
        cwds: {},
        permModes: {},
        models: {},
        efforts: {},
        pending: [],
      }),
    );
    const mirrorCalls: string[] = [];
    const linkEvents: string[] = [];
    const drive = new Drive(
      {
        onReady: () => () => {},
        close: () => linkEvents.push("close"),
        onFatal: () => linkEvents.push("fatal"),
      } as any,
      {
        setDriven: (sid: string) => mirrorCalls.push(`set:${sid}`),
        markDrivenUuid: (sid: string) => mirrorCalls.push(`mark:${sid}`),
      } as any,
      {
        isE2E: (sid: string) => sid === E2E_SID,
        protectedSessionIds: () => [E2E_SID],
        hasServerStateSnapshot: () => true,
      } as any,
    );
    (drive as any).saveMap = () => false;
    expect(() =>
      (drive as any).handleMessage(
        { sid: E2E_SID, turn: { completed: true }, closing: false },
        { type: "system", subtype: "init", session_id: ROTATED_E2E_SID },
      ),
    ).toThrow(/fatal: failed to persist Claude Code identity rotation/);
    expect((drive as any).identityPersistencePoisoned).toBe(true);
    expect(linkEvents).toEqual(["close", "fatal"]);
    expect(mirrorCalls).not.toContain(`set:${ROTATED_E2E_SID}`);
    expect(mirrorCalls).not.toContain(`mark:${ROTATED_E2E_SID}`);
    expect(() => drive.localSessionIdFor(E2E_SID)).toThrow(/persistence is poisoned/);
    expect(drive.localSessionE2EStatus().isE2E(PLAIN_SID)).toBe(true);
  });
});
