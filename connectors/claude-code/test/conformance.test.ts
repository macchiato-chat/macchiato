/**
 * #303 claude-code conformance adapter：假 SDK 傳輸層 + 共享契約 suite。
 * 覆蓋 turn.usage / message.complete / clarify.request / task.start——CC 是四家裡
 * 這幾項契約最全的一家；共享 suite 同時被 codex/openclaw 掛載，防各家漂移。
 */
import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConformanceSuite } from "./_hermetic/conformance/index";
import { assertPathIsSandboxed, getSandboxHome } from "./_hermetic/index";

// ── fake Agent SDK（與 drive.test.ts 同構，獨立於其 mock 狀態）──
let emitScript: Array<Record<string, unknown>> = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  renameSession: async () => {},
  forkSession: async () => ({ sessionId: "forked" }),
  query: (args: { prompt: unknown; options: unknown }) => {
    void args;
    const script = [...emitScript];
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of script) yield e;
      },
      interrupt: async () => {},
    };
  },
}));

import { Drive } from "../src/cc/drive";
import { credPath } from "../src/_core/identity";

const CC_SID = "6966afc5-2dca-477d-a987-848421d25124";

function fakeLinkb() {
  const sent: Record<string, unknown>[] = [];
  const handlers: Array<(m: Record<string, unknown>) => void> = [];
  return {
    sent,
    fire: (m: Record<string, unknown>) => handlers.forEach((h) => h(m)),
    linkb: {
      agentLinkId: "AL-conf",
      isReady: true,
      send: (m: Record<string, unknown>) => sent.push(m),
      onFrame: (h: (m: Record<string, unknown>) => void) => {
        handlers.push(h);
        return () => {};
      },
      onReady: () => () => {},
    } as any,
  };
}

function tuiFrame(sid: string, method: string, params: Record<string, unknown> = {}) {
  return { t: "tui", sessionId: sid, frame: { method, params: { session_id: sid, ...params } } };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  emitScript = [];
  process.env.MACCHIATO_CC_SESSIONS = join(mkdtempSync(join(tmpdir(), "cc-conf-")), "sessions.json");
  delete process.env.MACCHIATO_CC_TITLE_MODE;
  delete process.env.MACCHIATO_CC_MODEL;
});

// 本家特有：默認憑證路徑必須落沙箱（共享 suite 的 hermetic 斷言的實例化）
it("#303 hermetic: CC credPath 落在沙箱 HOME", () => {
  delete process.env.MACCHIATO_CLAUDE_CODE_CRED;
  const p = credPath("claude-code");
  expect(p.startsWith(getSandboxHome())).toBe(true);
  assertPathIsSandboxed(p);
});

defineConformanceSuite({
  name: "claude-code",
  caps: {
    turnUsage: true,
    messageComplete: true,
    clarify: true,
    backgroundTask: true,
  },
  async collectTurn() {
    emitScript = [
      { type: "system", subtype: "init", session_id: CC_SID },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "pong" } },
      },
      // force=true 邊界：assistant.usage → turn.usage
      {
        type: "assistant",
        message: {
          id: "msg_conf_1",
          role: "assistant",
          content: [{ type: "text", text: "pong" }],
          usage: { output_tokens: 9 },
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "pong",
        usage: { input_tokens: 3, output_tokens: 9 },
        total_cost_usd: 0.001,
      },
    ];
    const { linkb, sent, fire } = fakeLinkb();
    new Drive(linkb).wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "ping" }));
    await tick(40);
    return sent;
  },
  async collectClarify() {
    const { linkb, sent } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    // 不 await 完整應答——只收 request 幀即夠契約
    const pending = (d as any).requestAnswers(
      CC_SID,
      {
        questions: [
          {
            question: "Pick one?",
            header: "Choice",
            options: [
              { label: "A", description: "alpha" },
              { label: "B" },
            ],
          },
        ],
      },
      "toolu_conf",
    );
    void pending; // 掛起等 respond；測試只看 outbound request
    await tick(10);
    return sent;
  },
  async collectBackgroundTask() {
    emitScript = [
      { type: "system", subtype: "init", session_id: CC_SID },
      {
        type: "system",
        subtype: "task_started",
        task_id: "bg-conf-1",
        tool_use_id: "tu-conf",
        description: "conformance bg",
        subagent_type: "",
      },
      {
        type: "system",
        subtype: "task_notification",
        task_id: "bg-conf-1",
        tool_use_id: "tu-conf",
        status: "completed",
        summary: "done",
      },
      { type: "result", subtype: "success", result: "ok" },
    ];
    const { linkb, sent, fire } = fakeLinkb();
    new Drive(linkb).wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "go" }));
    await tick(40);
    return sent;
  },
});
