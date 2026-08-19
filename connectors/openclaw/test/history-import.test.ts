import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announceImportAvailable, runImport } from "../src/openclaw/history-import";
import { keyForSid, Mirror } from "../src/openclaw/mirror";
import { applyReadyE2EIdentityState, Drive } from "../src/openclaw/drive";
import { handleE2EWrapOrDisable } from "../src/index";
import { E2EKeyStore } from "../src/_core/e2e/keys";
import { e2eControlKeyId, type E2EControlEnvelopeV1 } from "../src/_core/e2e/control";

// 渠道用戶消息（帶 OpenClaw 的 metadata wrapper）
function metaUser(channelId: string, channelName: string, text: string, ts = 1): string {
  const meta = JSON.stringify({ conversation_label: `Guild ${channelName} channel id:${channelId}`, group_channel: channelName });
  const wrapped = `Conversation info (untrusted metadata):\n\`\`\`json\n${meta}\n\`\`\`\n\n${text}`;
  return JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: wrapped }], timestamp: ts } }) + "\n";
}
function asst(text: string, ts = 2): string {
  return JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], timestamp: ts } }) + "\n";
}
function cronUser(id: string): string {
  return JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `[cron:${id} 日報]` }], timestamp: 1 } }) + "\n";
}
function plainUser(text: string, ts = 1): string {
  return JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: ts } }) + "\n";
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

function writeTrustedEmptyDrive(): void {
  writeFileSync(
    process.env.MACCHIATO_OPENCLAW_DRIVE!,
    JSON.stringify({ v: 1, driven: {}, wm: {} }),
  );
}

describe("history-import（深度：全文件 + 清洗 + 合併 + 過濾）", () => {
  let sdir: string;
  let root: string;
  let previousMirror: string | undefined;
  let previousDrive: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "occ-imp-"));
    sdir = join(root, "agents/main/sessions");
    mkdirSync(sdir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = root;
    previousMirror = process.env.MACCHIATO_OPENCLAW_MIRROR;
    previousDrive = process.env.MACCHIATO_OPENCLAW_DRIVE;
    process.env.MACCHIATO_OPENCLAW_MIRROR = join(root, "mirror.json");
    process.env.MACCHIATO_OPENCLAW_DRIVE = join(root, "drive.json");
  });
  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    if (previousMirror === undefined) delete process.env.MACCHIATO_OPENCLAW_MIRROR;
    else process.env.MACCHIATO_OPENCLAW_MIRROR = previousMirror;
    if (previousDrive === undefined) delete process.env.MACCHIATO_OPENCLAW_DRIVE;
    else process.env.MACCHIATO_OPENCLAW_DRIVE = previousDrive;
    rmSync(root, { recursive: true, force: true });
  });

  const collect = async (sessions: any[] = [], e2eSessionIds = new Set<string>()) => {
    const gw: any = { sessionsList: async () => ({ sessions }) };
    const sent: any[] = [];
    const linkb: any = { send: (m: any) => sent.push(m) };
    await runImport(gw, linkb, { isE2E: (sid: string) => e2eSessionIds.has(sid) });
    return sent;
  };

  it("歸檔頻道對話：清洗 wrapper + 頻道標題 + hermesSessionId 由 channel id", async () => {
    writeFileSync(join(sdir, "archA.jsonl"), metaUser("999", "#crypto", "舊問題", 1) + asst("舊答", 2));
    const sent = await collect([]); // 無活躍 → 純歸檔
    const ss = sent.filter((m) => m.t === "import_batch").flatMap((b) => b.sessions);
    expect(ss.length).toBe(1);
    expect(ss[0].hermesSessionId).toBe("agent:main:discord:channel:999");
    expect(ss[0].title).toBe("#crypto");
    expect(ss[0].source).toBe("discord");
    expect(ss[0].messages.find((m: any) => m.role === "user").text).toBe("舊問題"); // wrapper 已清
  });

  it("cron（[cron:）+ 純自動化（無用戶消息）都跳過", async () => {
    writeFileSync(join(sdir, "cron1.jsonl"), cronUser("x") + asst("cron 報告"));
    writeFileSync(join(sdir, "auto1.jsonl"), asst("只有助手"));
    expect(await collect([])).toEqual([{ t: "import_batch", sessions: [], done: true }]);
  });

  it("歸檔 + 活躍同頻道合併成一條，消息按 createdAt 排序", async () => {
    writeFileSync(join(sdir, "old.jsonl"), metaUser("999", "#crypto", "三月舊問", 1));
    writeFileSync(join(sdir, "act.jsonl"), metaUser("999", "#crypto", "現在新問", 3));
    const sent = await collect([
      { sessionId: "act", key: "agent:main:discord:channel:999", displayName: "discord:g#crypto", channel: "discord" },
    ]);
    const ss = sent.filter((m) => m.t === "import_batch").flatMap((b) => b.sessions);
    expect(ss.length).toBe(1); // 合併
    expect(ss[0].hermesSessionId).toBe("agent:main:discord:channel:999");
    expect(ss[0].messages.filter((m: any) => m.role === "user").map((m: any) => m.text)).toEqual(["三月舊問", "現在新問"]);
  });

  it("#968 import_batch 帶血緣：活躍會話報 root，歸檔會話不報（沒證據就別猜）", async () => {
    writeFileSync(join(sdir, "act.jsonl"), metaUser("999", "#crypto", "現在新問", 3));
    writeFileSync(join(sdir, "archived.jsonl"), metaUser("888", "#other", "舊問", 1));
    const sent = await collect([
      { sessionId: "act", key: "agent:main:discord:channel:999", channel: "discord", kind: "group" },
    ]);
    const byId = new Map(
      sent.filter((m) => m.t === "import_batch").flatMap((b) => b.sessions).map((s: any) => [s.hermesSessionId, s]),
    );
    expect(byId.get("agent:main:discord:channel:999").origin).toEqual({
      threadId: "agent:main:discord:channel:999",
      conversationId: "agent:main:discord:channel:999",
      kind: "root",
      evidence: "declared",
    });
    // 歸檔那份 gateway 已經不認得了 —— 不帶 origin = server 按 absent 走老行為。
    expect(byId.get("agent:main:discord:channel:888").origin).toBeUndefined();
  });

  it("活躍 cron key 跳過", async () => {
    writeFileSync(join(sdir, "c.jsonl"), metaUser("1", "#x", "hi"));
    const sent = await collect([{ sessionId: "c", key: "agent:main:cron:abc", channel: undefined }]);
    expect(sent).toEqual([{ t: "import_batch", sessions: [], done: true }]);
  });

  it("無文件 → 空 import_batch done:true", async () => {
    expect(await collect([])).toEqual([{ t: "import_batch", sessions: [], done: true }]);
  });

  it("announceImportAvailable 計數（合併後）", async () => {
    writeFileSync(join(sdir, "a.jsonl"), metaUser("1", "#a", "hi"));
    writeFileSync(join(sdir, "b.jsonl"), metaUser("2", "#b", "yo"));
    const sent: any[] = [];
    const linkb: any = { send: (m: any) => sent.push(m) };
    await announceImportAvailable(
      { sessionsList: async () => ({ sessions: [] }) } as any,
      linkb,
      { isE2E: () => false },
    );
    expect(sent[0]).toEqual({ t: "import_available", count: 2 });
  });

  it("#347 混合批剔除 E2E session，普通 session 与 announce 计数保留", async () => {
    writeFileSync(join(sdir, "secret.jsonl"), metaUser("3471", "#secret", "绝密问题"));
    writeFileSync(join(sdir, "plain.jsonl"), metaUser("3472", "#plain", "普通问题"));
    const protectedSid = "agent:main:discord:channel:3471";
    const sent = await collect([], new Set([protectedSid]));
    const batches = sent.filter((message) => message.t === "import_batch");
    expect(batches).toHaveLength(1);
    expect(batches[0].done).toBe(true);
    expect(batches[0].sessions.map((session: any) => session.hermesSessionId)).toEqual([
      "agent:main:discord:channel:3472",
    ]);
    expect(JSON.stringify(sent)).not.toContain("绝密问题");
    expect(JSON.stringify(sent)).not.toContain("#secret");

    const announced: any[] = [];
    await announceImportAvailable(
      { sessionsList: async () => ({ sessions: [] }) } as any,
      { send: (message: unknown) => announced.push(message) } as any,
      { isE2E: (sid: string) => sid === protectedSid },
    );
    expect(announced).toEqual([{ t: "import_available", count: 1 }]);
  });

  it("#347 全 E2E 批仍发送空 sessions 的 done:true 终止帧", async () => {
    writeFileSync(join(sdir, "secret.jsonl"), metaUser("3471", "#secret", "绝密问题"));
    expect(await collect([], new Set(["agent:main:discord:channel:3471"]))).toEqual([
      { t: "import_batch", sessions: [], done: true },
    ]);
  });

  it("#347 已归档的本地 transcript 通过持久 fileIds → wire sid 映射过滤，不产生明文 UUID shadow", async () => {
    const wireSid = "01K0OPENCLAWHISTORYWIRE0001";
    const key = keyForSid(wireSid);
    const localSid = "archived-local-session";
    const plainKey = "agent:main:discord:channel:plain-347";
    const plainLocalSid = "plain-local-session";
    writeFileSync(
      process.env.MACCHIATO_OPENCLAW_MIRROR!,
      JSON.stringify({
        offsets: { [key]: 0 },
        fileIds: { [key]: localSid, [plainKey]: plainLocalSid },
        fileIdAliases: { [key]: [localSid], [plainKey]: [plainLocalSid] },
        aliasHistoryTrusted: true,
      }),
    );
    const mirror = new Mirror(
      { sessionsList: async () => ({ sessions: [] }) } as any,
      {} as any,
      {
        isE2E: (sid: string) => sid === wireSid,
        protectedSessionIds: () => [wireSid],
      } as any,
    );
    // Drive 从持久 driven map 恢复原始大小写 wire sid；gateway 已不列出该 transcript。
    mirror.setDriven(key, wireSid);
    await mirror.reconcileIdentityPreflight();

    writeFileSync(join(sdir, `${localSid}.jsonl`), plainUser("不能明文导入的秘密"));
    writeFileSync(join(sdir, `${plainLocalSid}.jsonl`), plainUser("普通历史"));
    const sent: any[] = [];
    await runImport(
      { sessionsList: async () => ({ sessions: [] }) } as any,
      { send: (message: unknown) => sent.push(message) } as any,
      mirror.localSessionE2EStatus(),
    );

    expect(sent.at(-1)?.done).toBe(true);
    expect(sent.flatMap((frame) => frame.sessions ?? []).map((session) => session.hermesSessionId)).toEqual([
      plainLocalSid,
    ]);
    expect(JSON.stringify(sent)).not.toContain("不能明文导入的秘密");
    expect(JSON.stringify(sent)).not.toContain(localSid);
    expect(mirror.localSessionE2EStatus().isE2E("unknown-archived-uuid")).toBe(true);
  });

  it("#347 OpenClaw transcript rotation 持久保留 old+new aliases，立即 import 与重启后均不明文回灌", async () => {
    const wireSid = "agent:main:discord:channel:347-rotation";
    const key = keyForSid(wireSid);
    const oldLocalSid = "rotation-old-local";
    const newLocalSid = "rotation-new-local";
    writeFileSync(
      process.env.MACCHIATO_OPENCLAW_MIRROR!,
      JSON.stringify({
        offsets: { [key]: 0 },
        missingAt: {},
        tombstones: [],
        fileIds: { [key]: oldLocalSid },
        fileIdAliases: { [key]: [oldLocalSid] },
        aliasHistoryTrusted: true,
      }),
    );
    writeFileSync(join(sdir, `${oldLocalSid}.jsonl`), plainUser("old rotated secret"));
    writeFileSync(join(sdir, `${newLocalSid}.jsonl`), plainUser("new rotated secret"));
    const e2e = new E2EKeyStore(join(root, "rotation-e2e.json"));
    e2e.createForEnable(wireSid);
    const gw = {
      sessionsList: async () => ({
        sessions: [{ key, sessionId: newLocalSid, displayName: "rotated private" }],
      }),
    } as any;
    const mirrored: any[] = [];
    const mirror = new Mirror(
      gw,
      { agentLinkId: "al", isReady: true, send: (message: any) => mirrored.push(message) } as any,
      e2e,
    );

    // poll 在讀新 file 前同步持久 current=new 且 aliases=[old,new]；投出的內容只能是 E2E。
    await (mirror as any).pollOnce();
    expect((mirror as any).state.fileIds[key]).toBe(newLocalSid);
    expect((mirror as any).state.fileIdAliases[key]).toEqual([oldLocalSid, newLocalSid]);
    expect(mirrored.some((frame) => frame.t === "mirror_append" && frame.sessions?.[0]?.e2e === true)).toBe(true);
    expect(JSON.stringify(mirrored)).not.toContain("new rotated secret");

    await mirror.reconcileIdentityPreflight();
    const imported: any[] = [];
    await runImport(
      gw,
      { send: (message: unknown) => imported.push(message) } as any,
      mirror.localSessionE2EStatus(),
    );
    expect(imported).toEqual([{ t: "import_batch", sessions: [], done: true }]);

    const restarted = new Mirror(gw, {} as any, e2e);
    await restarted.reconcileIdentityPreflight();
    expect(restarted.localSessionE2EStatus().isE2E(oldLocalSid)).toBe(true);
    expect(restarted.localSessionE2EStatus().isE2E(newLocalSid)).toBe(true);
    expect((restarted as any).aliasHistoryTrusted).toBe(true);
  });

  it("#968 別名歷史遷進 ThreadRegistry：舊 state 的每一條別名都認得回同一把 K_S", async () => {
    const wireSid = "agent:main:discord:channel:968-migrate";
    const key = keyForSid(wireSid);
    const oldLocalSid = "migrate-old-local";
    const olderLocalSid = "migrate-older-local";
    const newLocalSid = "migrate-new-local";
    writeFileSync(
      process.env.MACCHIATO_OPENCLAW_MIRROR!,
      JSON.stringify({
        offsets: { [key]: 0 },
        missingAt: {},
        tombstones: [],
        fileIds: { [key]: oldLocalSid },
        fileIdAliases: { [key]: [olderLocalSid, oldLocalSid] },
        aliasHistoryTrusted: true,
      }),
    );
    writeFileSync(join(sdir, `${newLocalSid}.jsonl`), plainUser("migrated secret"));
    const e2e = new E2EKeyStore(join(root, "migrate-e2e.json"));
    e2e.createForEnable(wireSid);
    const gw = {
      sessionsList: async () => ({ sessions: [{ key, sessionId: newLocalSid }] }),
    } as any;
    const mirror = new Mirror(gw, { agentLinkId: "al", isReady: true, send: () => {} } as any, e2e);

    // 別名解析器：對話 = key（K_S 的鍵，永不輪換），歷代 transcript 全部認得回它。
    const resolve = mirror.identityAliasResolver();
    expect(resolve(olderLocalSid)).toContain(key);
    expect(resolve(oldLocalSid)).toContain(key);
    e2e.setIdentityAliases(resolve);
    expect(e2e.hasKey(olderLocalSid)).toBe(true); // 別名下的舊鍵照樣算「本地持鑰」

    // 輪換 + 落盤：老別名一條都不許少（只增不刪）。
    await (mirror as any).pollOnce();
    const onDisk = JSON.parse(readFileSync(process.env.MACCHIATO_OPENCLAW_MIRROR!, "utf8"));
    expect(onDisk.fileIdAliases[key]).toEqual([olderLocalSid, oldLocalSid, newLocalSid]);
    expect(onDisk.aliasHistoryTrusted).toBe(true);
    expect(onDisk.fileIds[key]).toBe(newLocalSid); // key 自己不進別名數組，磁盤格式一個字節沒動
    expect(mirror.identityAliasResolver()(newLocalSid)).toContain(key);
  });

  it("#968 fail-closed：舊 schema 沒有別名歷史 → 解析器恒空，逐字節退回改前行為", async () => {
    const wireSid = "agent:main:discord:channel:968-untrusted";
    const key = keyForSid(wireSid);
    const localSid = "untrusted-local";
    writeFileSync(
      process.env.MACCHIATO_OPENCLAW_MIRROR!,
      JSON.stringify({
        offsets: { [key]: 0 },
        missingAt: {},
        tombstones: [],
        // 故意沒有 fileIdAliases/aliasHistoryTrusted：舊 schema 可能早已丟過 rotation alias。
        fileIds: { [key]: localSid },
      }),
    );
    const e2e = new E2EKeyStore(join(root, "untrusted-e2e.json"));
    e2e.createForEnable(wireSid);
    const gw = { sessionsList: async () => ({ sessions: [{ key, sessionId: localSid }] }) } as any;
    const mirror = new Mirror(gw, { agentLinkId: "al", isReady: true, send: () => {} } as any, e2e);
    expect((mirror as any).aliasHistoryTrusted).toBe(false);
    expect(mirror.identityAliasResolver()(localSid)).toEqual([]);
    // 有 protected 會話在時，普通 save 不得把「補出來的別名」冒充成完整歷史。
    await mirror.reconcileIdentityPreflight();
    expect((mirror as any).aliasHistoryTrusted).toBe(false);
    expect(
      JSON.parse(readFileSync(process.env.MACCHIATO_OPENCLAW_MIRROR!, "utf8")).aliasHistoryTrusted,
    ).toBe(false);
  });

  it("#968 別名表自相矛盾（同一 transcript 掛兩個 key）→ 降級成不可信，但一條別名都不刪", async () => {
    const keyA = "agent:main:discord:channel:conflict-a";
    const keyB = "agent:main:discord:channel:conflict-b";
    const shared = "conflict-shared-local";
    writeFileSync(
      process.env.MACCHIATO_OPENCLAW_MIRROR!,
      JSON.stringify({
        offsets: {},
        missingAt: {},
        tombstones: [],
        fileIds: { [keyA]: shared, [keyB]: shared },
        fileIdAliases: { [keyA]: [shared], [keyB]: [shared] },
        aliasHistoryTrusted: true,
      }),
    );
    const gw = { sessionsList: async () => ({ sessions: [] }) } as any;
    const mirror = new Mirror(gw, { agentLinkId: "al", isReady: true, send: () => {} } as any);
    expect((mirror as any).aliasHistoryTrusted).toBe(false); // 證明不了 I1 → 一律 fail-closed
    expect(mirror.identityAliasResolver()(shared)).toEqual([]);
    (mirror as any).save(true);
    const onDisk = JSON.parse(readFileSync(process.env.MACCHIATO_OPENCLAW_MIRROR!, "utf8"));
    expect(onDisk.fileIdAliases).toEqual({ [keyA]: [shared], [keyB]: [shared] });
    expect(onDisk.aliasHistoryTrusted).toBe(false);
  });

  it("#347 runImport 等 gateway 期间并发 enable 后动态重判 floor，不沿用零 E2E 的旧 closure", async () => {
    const wireSid = "agent:main:discord:channel:347-race";
    const key = keyForSid(wireSid);
    const localSid = "race-archived-local";
    writeFileSync(
      process.env.MACCHIATO_OPENCLAW_MIRROR!,
      JSON.stringify({
        offsets: { [key]: 0 },
        fileIds: { [key]: localSid },
        fileIdAliases: { [key]: [localSid] },
        aliasHistoryTrusted: true,
      }),
    );
    writeFileSync(join(sdir, `${localSid}.jsonl`), plainUser("concurrent enable secret"));
    const e2e = new E2EKeyStore(join(root, "race-e2e.json"));
    let resolveImportList!: (value: any) => void;
    let listCalls = 0;
    const gw = {
      sessionsList: async () => {
        listCalls += 1;
        if (listCalls === 1) return { sessions: [{ key, sessionId: localSid }] };
        return await new Promise((resolve) => {
          resolveImportList = resolve;
        });
      },
    } as any;
    const mirror = new Mirror(gw, {} as any, e2e);
    await mirror.reconcileIdentityPreflight();
    const status = mirror.localSessionE2EStatus(); // 此刻 protection floor 為 0
    const sent: any[] = [];
    const importing = runImport(
      gw,
      { send: (message: unknown) => sent.push(message) } as any,
      status,
    );
    await Promise.resolve();

    // activeSessions 尚在 await；server 此時提升 pending-enable floor，随后只返回 archived local UUID。
    e2e.markServerE2E(wireSid, "enable");
    resolveImportList({ sessions: [] });
    await importing;

    expect(sent).toEqual([{ t: "import_batch", sessions: [], done: true }]);
    expect(JSON.stringify(sent)).not.toContain("concurrent enable secret");
  });

  it("#347 rotation alias 落盘失败后 poison 内容面，下一轮不得因内存已更新而越过保存", async () => {
    const wireSid = "agent:main:discord:channel:347-dirty";
    const key = keyForSid(wireSid);
    const oldLocalSid = "dirty-old-local";
    const newLocalSid = "dirty-new-local";
    const goodStatePath = process.env.MACCHIATO_OPENCLAW_MIRROR!;
    writeFileSync(
      goodStatePath,
      JSON.stringify({
        offsets: { [key]: 0 },
        fileIds: { [key]: oldLocalSid },
        fileIdAliases: { [key]: [oldLocalSid] },
        aliasHistoryTrusted: true,
      }),
    );
    writeFileSync(join(sdir, `${newLocalSid}.jsonl`), plainUser("must never be plaintext"));
    const e2e = new E2EKeyStore(join(root, "dirty-e2e.json"));
    e2e.createForEnable(wireSid);
    const sent: any[] = [];
    const mirror = new Mirror(
      {
        sessionsList: async () => ({
          sessions: [{ key, sessionId: newLocalSid }],
        }),
      } as any,
      { agentLinkId: "al", isReady: true, send: (message: any) => sent.push(message) } as any,
      e2e,
    );

    // 把 state parent 变成普通文件，令同步持久化确定失败；仅在本测试 temp root 内。
    const blockedParent = join(root, "not-a-directory");
    writeFileSync(blockedParent, "block");
    process.env.MACCHIATO_OPENCLAW_MIRROR = join(blockedParent, "mirror.json");
    await expect((mirror as any).pollOnce()).rejects.toThrow(/identity persistence failed/);
    expect(sent).toEqual([]);
    expect((mirror as any).identityPersistenceDirty).toBe(true);
    await expect((mirror as any).pollOnce()).rejects.toThrow(/persistence is dirty/);
    expect(sent).toEqual([]);
  });

  it("#347 旧 schema 在 protected 下补 alias/保存/重启仍持久 untrusted，unknown archive 全挡", async () => {
    const wireSid = "agent:main:discord:channel:347-legacy";
    const key = keyForSid(wireSid);
    const currentLocalSid = "legacy-current-local";
    const unknownOldSid = "legacy-unknown-old";
    writeFileSync(
      process.env.MACCHIATO_OPENCLAW_MIRROR!,
      JSON.stringify({
        offsets: { [key]: 0 },
        fileIds: { [key]: currentLocalSid },
        // 故意没有 fileIdAliases/aliasHistoryTrusted：旧 schema 可能已丢过历史 rotation。
      }),
    );
    const e2e = new E2EKeyStore(join(root, "legacy-e2e.json"));
    e2e.createForEnable(wireSid);
    const gw = {
      sessionsList: async () => ({
        sessions: [{ key, sessionId: currentLocalSid }],
      }),
    } as any;
    const mirror = new Mirror(gw, {} as any, e2e);

    await mirror.reconcileIdentityPreflight();
    expect((mirror as any).aliasHistoryTrusted).toBe(false);
    expect(mirror.localSessionE2EStatus().isE2E(unknownOldSid)).toBe(true);
    expect(JSON.parse(readFileSync(process.env.MACCHIATO_OPENCLAW_MIRROR!, "utf8"))).toMatchObject({
      aliasHistoryTrusted: false,
      fileIdAliases: { [key]: [currentLocalSid] },
    });

    const restarted = new Mirror(gw, {} as any, e2e);
    await restarted.reconcileIdentityPreflight();
    expect((restarted as any).aliasHistoryTrusted).toBe(false);
    expect(restarted.localSessionE2EStatus().isE2E(unknownOldSid)).toBe(true);
    writeFileSync(join(sdir, `${unknownOldSid}.jsonl`), plainUser("legacy unknown secret"));
    const sent: any[] = [];
    await runImport(
      gw,
      { send: (message: unknown) => sent.push(message) } as any,
      restarted.localSessionE2EStatus(),
    );
    expect(sent).toEqual([{ t: "import_batch", sessions: [], done: true }]);
    expect(JSON.stringify(sent)).not.toContain("legacy unknown secret");
  });

  it("#347 mirror 身份双坏后即使 poll 保存普通状态也永久 fail-closed，不明文导入归档 E2E transcript", async () => {
    const wireSid = "01K0OPENCLAWCORRUPTMAP00001";
    const key = keyForSid(wireSid);
    const localSid = "archived-secret-local";
    writeFileSync(
      process.env.MACCHIATO_OPENCLAW_DRIVE!,
      JSON.stringify({ v: 1, driven: { [key]: wireSid }, wm: {} }),
    );
    writeFileSync(process.env.MACCHIATO_OPENCLAW_MIRROR!, "{broken");
    writeFileSync(`${process.env.MACCHIATO_OPENCLAW_MIRROR!}.bak`, "{also-broken");
    const e2e = new E2EKeyStore(join(root, "corrupt-map-e2e.json"));
    const mirror = new Mirror({} as any, { isReady: true, send: () => {} } as any, e2e);
    const drive = new Drive({} as any, {} as any, mirror, e2e);
    // pending-enable 只豁免「当前 sid 暂缺 fileId」，绝不把损坏/backup fallback 身份档提升为可信；
    // 但 ready 保持在线，受影响内容面继续由 strict assert 隔离。
    expect(
      applyReadyE2EIdentityState(
        e2e,
        drive,
        mirror,
        {
          version: 1,
          disabledReceipts: [],
          sessions: [{ hermesSessionId: wireSid, pendingOp: "enable" }],
        },
      ),
    ).toEqual([wireSid]);
    expect(() => drive.assertE2EIdentitySafe()).not.toThrow();
    expect(() => mirror.assertE2EIdentitySafe()).toThrow(/identity state unavailable/);

    // 一次无关普通 poll/save 不能把 fallback 空 fileIds 冒充成已重建的可信身份快照。
    (mirror as any).state.offsets.unrelated = 1;
    (mirror as any).save();
    expect(() => mirror.assertE2EIdentitySafe()).toThrow(/identity state unavailable/);

    writeFileSync(join(sdir, `${localSid}.jsonl`), plainUser("绝不能回灌的归档秘密"));
    const sent: any[] = [];
    await runImport(
      { sessionsList: async () => ({ sessions: [] }) } as any,
      { send: (message: unknown) => sent.push(message) } as any,
      mirror.localSessionE2EStatus(),
    );
    expect(sent).toEqual([{ t: "import_batch", sessions: [], done: true }]);
    expect(JSON.stringify(sent)).not.toContain("归档秘密");
  });

  it("#347 valid-but-incomplete / enable crash：agent:* 缺 fileId 时 ready 保持在线且归档 UUID 全部冻结", async () => {
    const wireSid = "agent:main:discord:channel:347-agent";
    const localSid = "archived-agent-secret";
    // 主檔格式有效，只是 pending-enable 在補寫 fileId 前崩潰；agent:* 不需要 drive 大小寫映射，
    // 但仍必須靠 mirror fileIds 關聯歸檔 transcript UUID。
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
    const e2e = new E2EKeyStore(join(root, "incomplete-agent-e2e.json"));
    const mirror = new Mirror({} as any, {} as any, e2e);
    const drive = new Drive({} as any, {} as any, mirror, e2e);

    // stable/disable 快照不在 bootstrap 例外内；即使 agent:* 不需要 drive 映射，內容仍須拒絕，
    // 但不能把整條 connector 殺掉。
    expect(
      applyReadyE2EIdentityState(
        e2e,
        drive,
        mirror,
        {
          version: 1,
          disabledReceipts: [],
          sessions: [{ hermesSessionId: wireSid, pendingOp: null }],
        },
      ),
    ).toEqual([wireSid]);
    expect(() => mirror.assertE2EIdentitySafe()).toThrow(/missing=agent:main:discord:channel:347-agent/);
    expect(mirror.localSessionE2EStatus().isE2E(localSid)).toBe(true);

    writeFileSync(join(sdir, `${localSid}.jsonl`), plainUser("agent archived secret"));
    const sent: any[] = [];
    await runImport(
      { sessionsList: async () => ({ sessions: [] }) } as any,
      { send: (message: unknown) => sent.push(message) } as any,
      mirror.localSessionE2EStatus(),
    );
    expect(sent).toEqual([{ t: "import_batch", sessions: [], done: true }]);
    expect(JSON.stringify(sent)).not.toContain("agent archived secret");
  });

  it("#347 online enable backfill 先持久 fileId，随后归档仍能按 local UUID 过滤", async () => {
    const wireSid = "01K0OPENCLAWONLINEENABLE001";
    const key = keyForSid(wireSid);
    const localSid = "online-enable-local";
    writeFileSync(
      process.env.MACCHIATO_OPENCLAW_DRIVE!,
      JSON.stringify({ v: 1, driven: { [key]: wireSid }, wm: {} }),
    );
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
    writeFileSync(join(sdir, `${localSid}.jsonl`), plainUser("online enable secret") + asst("answer"));
    const e2e = new E2EKeyStore(join(root, "e2e.json"));
    e2e.createForEnable(wireSid);
    const sent: any[] = [];
    const gw = {
      sessionsList: async () => ({
        sessions: [{ key, sessionId: localSid, displayName: "private" }],
      }),
    } as any;
    const mirror = new Mirror(gw, { agentLinkId: "al", isReady: true, send: (m: any) => sent.push(m) } as any, e2e);
    const drive = new Drive({} as any, {} as any, mirror, e2e);
    expect(() => drive.assertE2EIdentitySafe()).not.toThrow();
    expect(() => mirror.assertE2EIdentitySafe()).toThrow(/missing=01K0OPENCLAWONLINEENABLE001/);

    await mirror.backfillE2E(wireSid, "enable");
    expect((mirror as any).state.fileIds[key]).toBe(localSid);
    expect(() => mirror.assertE2EIdentitySafe()).not.toThrow();
    expect(mirror.localSessionE2EStatus().isE2E(localSid)).toBe(true);
    expect(sent.at(-1)).toMatchObject({
      t: "e2e_backfill",
      hermesSessionId: wireSid,
      found: true,
    });
  });

  it("#347 agent:* online enable 仅在 backfill 补写并持久化 fileId 后恢复严格身份校验", async () => {
    const wireSid = "agent:main:discord:channel:347-online";
    const key = keyForSid(wireSid);
    const localSid = "online-agent-local";
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
    writeFileSync(join(sdir, `${localSid}.jsonl`), plainUser("agent online secret") + asst("answer"));
    const e2e = new E2EKeyStore(join(root, "agent-e2e.json"));
    const sent: any[] = [];
    const mirror = new Mirror(
      {
        sessionsList: async () => ({
          sessions: [{ key, sessionId: localSid, displayName: "private agent channel" }],
        }),
      } as any,
      { agentLinkId: "al", isReady: true, send: (message: any) => sent.push(message) } as any,
      e2e,
    );
    const drive = new Drive({} as any, {} as any, mirror, e2e);

    // 重連時 server ready 已帶 pending-enable，但 bootstrap wrap/backfill 必須排在 ready 後。
    // callback 僅精確允許這個 sid 暫缺 fileId，讓控制幀有機會補圖。
    expect(
      applyReadyE2EIdentityState(
        e2e,
        drive,
        mirror,
        {
          version: 1,
          disabledReceipts: [],
          sessions: [{ hermesSessionId: wireSid, pendingOp: "enable" }],
        },
      ),
    ).toEqual([wireSid]);

    // 內容面不吃 bootstrap 例外：補圖前 import 全擋、poll 拒絕且不發/不推水位。
    expect(() => mirror.assertE2EIdentitySafe()).toThrow(/missing=agent:main:discord:channel:347-online/);
    expect(mirror.localSessionE2EStatus().isE2E("any-local-transcript")).toBe(true);
    await expect((mirror as any).pollOnce()).rejects.toThrow(/missing=agent:main:discord:channel:347-online/);
    expect(sent).toEqual([]);
    expect((mirror as any).state.offsets).toEqual({});

    e2e.createForEnable(wireSid);
    await mirror.backfillE2E(wireSid, "enable");

    expect((mirror as any).state.fileIds[key]).toBe(localSid);
    expect(() => mirror.assertE2EIdentitySafe()).not.toThrow();
    expect(mirror.localSessionE2EStatus().isE2E(localSid)).toBe(true);
    expect(sent.at(-1)).toMatchObject({
      t: "e2e_backfill",
      hermesSessionId: wireSid,
      found: true,
    });
  });

  it("#347 全新安装且无 E2E protection floor 不被缺失身份档永久阻塞", () => {
    const e2e = { isE2E: () => false, protectedSessionIds: () => [] } as any;
    const mirror = new Mirror({} as any, {} as any, e2e);
    const drive = new Drive({} as any, {} as any, mirror, e2e);
    expect(() => drive.assertE2EIdentitySafe()).not.toThrow();
    expect(() => mirror.assertE2EIdentitySafe()).not.toThrow();
  });

  it("#687 App ULID pending-enable 無 driven map 時 allowMissing 不 throw（strict 仍擋其它 ULID）", () => {
    writeTrustedEmptyDrive();
    const ulid = "01K0OC687PENDINGENABLEULID01";
    const e2e = new E2EKeyStore(join(root, "687-allow-missing-e2e.json"));
    e2e.createForEnable(ulid);
    const drive = new Drive({} as any, {} as any, undefined, e2e);
    // strict：缺 map → throw（內容面仍 fail-closed）
    expect(() => drive.assertE2EIdentitySafe()).toThrow(/identity map unavailable/);
    // pending-enable 白名單：enable / wrap bootstrap 可過
    expect(() => drive.assertE2EIdentitySafe(new Set([ulid]))).not.toThrow();
    // 其它受保護 sid 不得借此白名單放行
    expect(() => drive.assertE2EIdentitySafe(new Set(["01OTHERSESSION000000000001"]))).toThrow(
      /identity map unavailable/,
    );
  });

  it("#687 pending-enable wrap 缺 driven map 不 throw / 不 onFatal，並能回 e2e_key", () => {
    writeTrustedEmptyDrive();
    const ulid = "01K0OC687WRAPMISSINGMAPULID1";
    const e2e = new E2EKeyStore(join(root, "687-wrap-missing-e2e.json"));
    const sent: Record<string, unknown>[] = [];
    const linkb = { agentLinkId: "al", send: (msg: Record<string, unknown>) => sent.push(msg) };
    const drive = new Drive({} as any, {} as any, undefined, e2e);
    const mirror = { assertE2EIdentitySafe() {}, async backfillE2E() {} };
    let fatal = 0;

    try {
      handleE2EWrapOrDisable(
        { t: "e2e_wrap_request", hermesSessionId: ulid, backfill: true, devices: [] },
        linkb,
        e2e,
        drive,
        mirror,
      );
    } catch {
      fatal += 1;
    }
    expect(fatal).toBe(0);
    expect(sent).toEqual([
      expect.objectContaining({ t: "e2e_key", hermesSessionId: ulid, wrapped: [] }),
    ]);
    expect(e2e.isE2E(ulid)).toBe(true);
  });

  it("#687 wrap identity Error 只軟拒、不上拋 onFatal", () => {
    writeTrustedEmptyDrive();
    const sid = "01K0OC687WRAPIDENTITYERR0001";
    const other = "01K0OC687OTHERPROTECTEDULID1";
    const e2e = new E2EKeyStore(join(root, "687-wrap-identity-e2e.json"));
    e2e.createForEnable(other);
    const sent: Record<string, unknown>[] = [];
    const linkb = { agentLinkId: "al", send: (msg: Record<string, unknown>) => sent.push(msg) };
    const drive = new Drive({} as any, {} as any, undefined, e2e);
    const mirror = { assertE2EIdentitySafe() {}, async backfillE2E() {} };

    expect(() =>
      handleE2EWrapOrDisable(
        { t: "e2e_wrap_request", hermesSessionId: sid, backfill: true, devices: [] },
        linkb,
        e2e,
        drive,
        mirror,
      ),
    ).not.toThrow();
    expect(sent).toEqual([]);
    // beginEnable 已落盤 protection floor；軟拒後進程仍活，ready 可再 bootstrap。
    expect(e2e.isE2E(sid)).toBe(true);

    const poisoned = new E2EKeyStore(join(root, "687-wrap-poisoned-e2e.json"));
    expect(() =>
      handleE2EWrapOrDisable(
        { t: "e2e_wrap_request", hermesSessionId: sid, backfill: true, devices: [] },
        linkb,
        poisoned,
        {
          beginE2ETransition() {},
          assertE2EIdentitySafe() {
            throw new Error(
              "OpenClaw E2E identity persistence is poisoned; refusing all protected identity paths",
            );
          },
        },
        mirror,
      ),
    ).not.toThrow();
    expect(sent).toEqual([]);
  });

  it("#687 disable 身份 assert 失敗只軟拒本幀，不 onFatal", () => {
    writeTrustedEmptyDrive();
    const sid = "01K0OC687DISABLEIDENTITY0001";
    const e2e = new E2EKeyStore(join(root, "687-disable-identity-e2e.json"));
    e2e.createForEnable(sid);
    e2e.markServerE2E(sid, "disable");
    e2e.beginDisable(sid, disableIntent(sid, e2e.requireKey(sid)));
    const sent: Record<string, unknown>[] = [];
    const linkb = { agentLinkId: "al", send: (msg: Record<string, unknown>) => sent.push(msg) };
    const drive = new Drive({} as any, {} as any, undefined, e2e);
    const backfills: string[] = [];
    const mirror = {
      assertE2EIdentitySafe() {},
      async backfillE2E(wireSid: string) {
        backfills.push(wireSid);
      },
    };

    expect(() =>
      handleE2EWrapOrDisable(
        { t: "e2e_disable_request", hermesSessionId: sid },
        linkb,
        e2e,
        drive,
        mirror,
      ),
    ).not.toThrow();
    expect(backfills).toEqual([]);
    expect(e2e.hasPendingDisable(sid)).toBe(true);
  });

  it("#347 本地 keys=0 但 ready 快照未同步前不得提升 alias trust；权威空快照后才安全迁移", async () => {
    const key = "agent:main:discord:channel:plain-fresh";
    const localSid = "fresh-plain-local";
    const e2e = new E2EKeyStore(join(root, "fresh-e2e.json"));
    const gw = {
      sessionsList: async () => ({ sessions: [{ key, sessionId: localSid }] }),
    } as any;
    const mirror = new Mirror(gw, {} as any, e2e);

    await mirror.reconcileIdentityPreflight();
    expect((mirror as any).aliasHistoryTrusted).toBe(false);
    expect(JSON.parse(readFileSync(process.env.MACCHIATO_OPENCLAW_MIRROR!, "utf8")).aliasHistoryTrusted).toBe(false);

    e2e.applyServerState({ version: 1, sessions: [], disabledReceipts: [] });
    await mirror.reconcileIdentityPreflight();
    expect((mirror as any).aliasHistoryTrusted).toBe(true);
    expect(JSON.parse(readFileSync(process.env.MACCHIATO_OPENCLAW_MIRROR!, "utf8"))).toMatchObject({
      aliasHistoryTrusted: true,
      fileIdAliases: { [key]: [localSid] },
    });
  });
});
