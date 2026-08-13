import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsCalls = vi.hoisted(() => ({ rolloutReadFileSync: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => {
      const target = args[0];
      if (typeof target === "string" && target.endsWith(".jsonl")) {
        fsCalls.rolloutReadFileSync.push(target);
      }
      return (actual.readFileSync as (...values: unknown[]) => unknown)(...args);
    },
  };
});

import { Mirror } from "../src/codex/mirror";

const previousSessions = process.env.MACCHIATO_CODEX_SESSIONS_DIR;
const previousMirror = process.env.MACCHIATO_CODEX_MIRROR;

afterEach(() => {
  fsCalls.rolloutReadFileSync.length = 0;
  if (previousSessions === undefined) delete process.env.MACCHIATO_CODEX_SESSIONS_DIR;
  else process.env.MACCHIATO_CODEX_SESSIONS_DIR = previousSessions;
  if (previousMirror === undefined) delete process.env.MACCHIATO_CODEX_MIRROR;
  else process.env.MACCHIATO_CODEX_MIRROR = previousMirror;
});

describe("#889 mirror 活跃 rollout 尾读", () => {
  it("已有 per-thread 水位后不再 readFileSync 历史前缀，ACK 前后水位语义不变", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-mirror-tail-"));
    try {
      const sessions = join(root, "sessions", "2026", "08", "12");
      mkdirSync(sessions, { recursive: true });
      const threadId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0889";
      const rollout = join(
        sessions,
        `rollout-2026-08-12T00-00-00-${threadId}.jsonl`,
      );
      const line = (role: "user_message" | "agent_message", text: string) =>
        `${JSON.stringify({
          type: "event_msg",
          payload: { type: role, message: text },
        })}\n`;
      const history =
        `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } })}\n`
        + line("user_message", "历史问题");
      writeFileSync(rollout, history);

      process.env.MACCHIATO_CODEX_SESSIONS_DIR = join(root, "sessions");
      process.env.MACCHIATO_CODEX_MIRROR = join(root, "mirror.json");
      const committedOffset = Buffer.byteLength(history, "utf8");
      writeFileSync(
        process.env.MACCHIATO_CODEX_MIRROR,
        JSON.stringify({
          offsets: { [threadId]: committedOffset },
          ords: { [threadId]: 2 },
          seeded: true,
          pendingMirrors: [],
          pendingE2EBackfills: {},
        }),
      );

      const sent: any[] = [];
      const mirror: any = new Mirror({
        agentLinkId: "al",
        isReady: true,
        send: (frame: unknown) => sent.push(frame),
      } as any);
      fsCalls.rolloutReadFileSync.length = 0;

      appendFileSync(rollout, line("agent_message", "新增回答"));
      mirror.pollOnce();

      expect(fsCalls.rolloutReadFileSync).toEqual([]);
      expect(sent.at(-1).sessions[0].messages).toMatchObject([
        { role: "agent", text: "新增回答" },
      ]);
      expect(mirror.state.offsets[threadId]).toBe(committedOffset);
      const pending = mirror.state.pendingMirrors[0];
      expect(pending.ords[threadId]).toBe(3);
      expect(pending.offsets[threadId]).toBe(statSync(rollout).size);

      mirror.handleAck(pending.batchId);
      expect(mirror.state.offsets[threadId]).toBe(statSync(rollout).size);
      expect(mirror.state.ords[threadId]).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
