import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announceImportAvailable, runImport } from "../src/codex/history-import";
import { Drive } from "../src/codex/drive";

const E2E_SID = "11111111-1111-4111-8111-111111111111";
const E2E_WIRE_SID = "01K0CODEXHISTORYWIRE0000001";
const PLAIN_SID = "22222222-2222-4222-8222-222222222222";

describe("#347 history import E2E wire boundary", () => {
  let root: string;
  let previousSessionsDir: string | undefined;
  let previousDriveState: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codex-import-e2e-"));
    previousSessionsDir = process.env.MACCHIATO_CODEX_SESSIONS_DIR;
    previousDriveState = process.env.MACCHIATO_CODEX_SESSIONS;
    process.env.MACCHIATO_CODEX_SESSIONS_DIR = root;
    process.env.MACCHIATO_CODEX_SESSIONS = join(root, "drive-map.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (previousSessionsDir === undefined) delete process.env.MACCHIATO_CODEX_SESSIONS_DIR;
    else process.env.MACCHIATO_CODEX_SESSIONS_DIR = previousSessionsDir;
    if (previousDriveState === undefined) delete process.env.MACCHIATO_CODEX_SESSIONS;
    else process.env.MACCHIATO_CODEX_SESSIONS = previousDriveState;
  });

  function writeRollout(sid: string, cwd: string, userText: string): void {
    const dir = join(root, "2026", "07", "23");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2026-07-23T00-00-00-${sid}.jsonl`),
      [
        JSON.stringify({ type: "session_meta", payload: { cwd } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: userText } }),
        JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: `${userText} 回答` } }),
        "",
      ].join("\n"),
    );
  }

  function mappedE2EStatus(): { isE2E(localSid: string): boolean } {
    const drive = new Drive(
      { onFrame: () => () => {} } as any,
      undefined,
      { isE2E: (sid: string) => sid === E2E_WIRE_SID } as any,
    );
    (drive as any).map[E2E_WIRE_SID] = E2E_SID;
    return drive.localSessionE2EStatus();
  }

  it("混合批剔除 E2E session，普通 session 与 announce 计数保留", () => {
    writeRollout(E2E_SID, "/secret-project", "绝密问题");
    writeRollout(PLAIN_SID, "/plain-project", "普通问题");
    const e2e = mappedE2EStatus();
    expect(e2e.isE2E(E2E_SID)).toBe(true); // local UUID 經反向映射命中 wire ULID
    const sent: any[] = [];
    const linkb = { agentLinkId: "agent-link", send: (message: unknown) => sent.push(message) } as any;

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
    writeRollout(E2E_SID, "/secret-project", "绝密问题");
    const sent: any[] = [];
    const linkb = { agentLinkId: "agent-link", send: (message: unknown) => sent.push(message) } as any;

    runImport(linkb, { isE2E: () => true });

    expect(sent).toEqual([
      { t: "import_batch", agentLinkId: "agent-link", sessions: [], done: true },
    ]);
  });

  it("身份主档与备份都损坏 + wire E2E → 整体 fail-closed，任一本地 rollout 都不导入", () => {
    writeRollout(PLAIN_SID, "/plain-project", "本来普通但身份已不可证明");
    writeFileSync(process.env.MACCHIATO_CODEX_SESSIONS!, "{broken");
    writeFileSync(`${process.env.MACCHIATO_CODEX_SESSIONS!}.bak`, "{also-broken");
    const drive = new Drive(
      { onFrame: () => () => {} } as any,
      undefined,
      {
        isE2E: (sid: string) => sid === E2E_WIRE_SID,
        protectedSessionIds: () => [E2E_WIRE_SID],
      } as any,
    );
    expect(() => drive.assertE2EIdentitySafe()).toThrow(/identity map unavailable/);
    const sent: any[] = [];
    runImport(
      { agentLinkId: "agent-link", send: (message: unknown) => sent.push(message) } as any,
      drive.localSessionE2EStatus(),
    );
    expect(sent).toEqual([
      { t: "import_batch", agentLinkId: "agent-link", sessions: [], done: true },
    ]);
    expect(JSON.stringify(sent)).not.toContain("身份已不可证明");
  });

  it("全新安装无 E2E protection floor → 不被缺失身份档永久阻塞", () => {
    const drive = new Drive(
      { onFrame: () => () => {} } as any,
      undefined,
      { isE2E: () => false, protectedSessionIds: () => [] } as any,
    );
    expect(() => drive.assertE2EIdentitySafe()).not.toThrow();
    expect(drive.localSessionE2EStatus().isE2E(PLAIN_SID)).toBe(false);
  });
});
