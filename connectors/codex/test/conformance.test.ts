/**
 * #303 codex conformance adapter：假 app-server 傳輸層 + 共享契約 suite。
 * 覆蓋 turn.usage（thread/tokenUsage/updated）+ message.complete——與 CC 對齊的 token 計量契約。
 * codex 無 AskUserQuestion / background task 結構化事件 → caps 不宣告（避免 skip 堆積）。
 */
import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConformanceSuite } from "./_hermetic/conformance/index";
import { assertPathIsSandboxed, getSandboxHome } from "./_hermetic/index";

vi.mock("../src/codex/attachments", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/codex/attachments")>();
  return {
    ...orig,
    materializeAttachment: async () => {
      throw new Error("not used in conformance");
    },
  };
});

import { AppServerDrive } from "../src/codex/drive-appserver";
import { credPath } from "../src/linkb/creds";

const SID = "01CONFCODEX000000000000000";
const TID = "bbbbbbbb-0000-4000-8000-000000000099";

class FakeClient {
  requests: Array<{ method: string; params: unknown }> = [];
  responses = new Map<string, unknown[]>();
  ntf: ((m: string, p: unknown) => void) | null = null;
  onNotification(h: (m: string, p: unknown) => void) {
    this.ntf = h;
    return () => {};
  }
  onReverseRequest() {}
  async request(method: string, params: unknown) {
    this.requests.push({ method, params });
    const q = this.responses.get(method);
    const r = q?.shift();
    if (r instanceof Error) throw r;
    return r ?? {};
  }
  close() {}
  fire(m: string, p: unknown) {
    this.ntf!(m, p);
  }
  queueResponse(method: string, r: unknown) {
    const q = this.responses.get(method) ?? [];
    q.push(r);
    this.responses.set(method, q);
  }
}

function make() {
  process.env.MACCHIATO_CODEX_SESSIONS = join(mkdtempSync(join(tmpdir(), "cx-conf-")), "sessions.json");
  process.env.MACCHIATO_CODEX_TITLE_MODE = "off";
  const sent: Record<string, unknown>[] = [];
  const linkb: any = {
    agentLinkId: "al-conf",
    isReady: true,
    handlers: [] as Array<(m: unknown) => void>,
    onFrame(h: (m: unknown) => void) {
      this.handlers.push(h);
    },
    send(m: Record<string, unknown>) {
      sent.push(m);
    },
    async deliver(m: unknown) {
      for (const h of this.handlers) await h(m);
    },
  };
  const client = new FakeClient();
  client.queueResponse("thread/start", { thread: { id: TID } });
  const mirror: any = {
    setDriven() {},
    unsetDriven() {},
    fastForward() {},
    tombstone() {},
    srcIdSnapshot: () => [],
  };
  const d = new AppServerDrive(client as any, linkb, mirror);
  d.wire();
  return { client, linkb, sent };
}

const tui = (method: string, sessionId: string, params: Record<string, unknown> = {}) => ({
  t: "tui",
  sessionId,
  frame: { method, params: { session_id: sessionId, ...params } },
});
const tick = () => new Promise((r) => setTimeout(r, 15));

beforeEach(() => {
  delete process.env.MACCHIATO_CODEX_MODEL;
});

it("#303 hermetic: Codex credPath 落在沙箱 HOME", () => {
  delete process.env.MACCHIATO_CODEX_CRED;
  const p = credPath();
  expect(p.startsWith(getSandboxHome())).toBe(true);
  assertPathIsSandboxed(p);
});

defineConformanceSuite({
  name: "codex",
  caps: {
    turnUsage: true,
    messageComplete: true,
    // clarify / backgroundTask：codex 無對應 agent 事件 → 不宣告
  },
  async collectTurn() {
    const { client, linkb, sent } = make();
    await linkb.deliver(tui("prompt.submit", SID, { text: "你好" }));
    client.fire("turn/started", { threadId: TID, turn: { id: "t-conf" } });
    client.fire("item/agentMessage/delta", { threadId: TID, itemId: "m1", delta: "早" });
    client.fire("item/agentMessage/delta", { threadId: TID, itemId: "m1", delta: "安" });
    client.fire("item/completed", {
      threadId: TID,
      item: { type: "agentMessage", id: "m1", text: "早安" },
    });
    client.fire("thread/tokenUsage/updated", {
      threadId: TID,
      tokenUsage: { last: { inputTokens: 10, outputTokens: 5 } },
    });
    client.fire("turn/completed", { threadId: TID, turn: { id: "t-conf", status: "completed" } });
    await tick();
    return sent;
  },
});
