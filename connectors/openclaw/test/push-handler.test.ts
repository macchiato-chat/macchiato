import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushHandler } from "../src/push/handler";

function req(sockPath: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = connect(sockPath);
    let buf = "";
    s.on("connect", () => s.write(JSON.stringify(payload) + "\n"));
    s.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) { resolve(JSON.parse(buf.slice(0, nl))); s.end(); }
    });
    s.on("error", reject);
  });
}

describe("push handler（unix socket → connector_push）", () => {
  let dir: string;
  let handler: PushHandler;
  const sent: any[] = [];
  let protectedSids: Set<string>;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "occ-push-"));
    process.env.MACCHIATO_OPENCLAW_PUSH_SOCK = join(dir, "push.sock");
    sent.length = 0;
    protectedSids = new Set();
    const linkb: any = { isReady: true, agentLinkId: "al1", send: (m: any) => sent.push(m) };
    const e2e: any = {
      isE2E: (sid: string) => protectedSids.has(sid),
      protectedSessionIds: () => [...protectedSids],
    };
    handler = new PushHandler(linkb, e2e);
    handler.start();
    await new Promise((r) => setTimeout(r, 120)); // 等 listen
  });
  afterEach(() => {
    handler.stop();
    delete process.env.MACCHIATO_OPENCLAW_PUSH_SOCK;
    rmSync(dir, { recursive: true, force: true });
  });

  it("投遞請求 → connector_push + ack ok", async () => {
    const ack = await req(process.env.MACCHIATO_OPENCLAW_PUSH_SOCK!, { chatId: "home", text: "主動消息" });
    expect(ack.ok).toBe(true);
    expect(ack.pushId).toBe(1);
    expect(sent[0]).toMatchObject({ t: "connector_push", agentLinkId: "al1", chatId: "home", text: "主動消息", pushId: 1 });
  });

  it("缺 chatId/text → ack error，不發", async () => {
    const ack = await req(process.env.MACCHIATO_OPENCLAW_PUSH_SOCK!, { chatId: "", text: "" });
    expect(ack.ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it("replyTo/metadata 透傳；pushId 遞增", async () => {
    await req(process.env.MACCHIATO_OPENCLAW_PUSH_SOCK!, { chatId: "home", text: "一" });
    const ack = await req(process.env.MACCHIATO_OPENCLAW_PUSH_SOCK!, { chatId: "home", text: "二", replyTo: "m1", metadata: { a: 1 } });
    expect(ack.pushId).toBe(2);
    expect(sent[1]).toMatchObject({ pushId: 2, replyTo: "m1", metadata: { a: 1 } });
  });

  it("link B 未就緒 → retryable error", async () => {
    handler.stop();
    const linkb: any = { isReady: false, agentLinkId: "al1", send: () => {} };
    const e2e: any = {
      isE2E: (sid: string) => protectedSids.has(sid),
      protectedSessionIds: () => [...protectedSids],
    };
    handler = new PushHandler(linkb, e2e);
    handler.start();
    await new Promise((r) => setTimeout(r, 120));
    const ack = await req(process.env.MACCHIATO_OPENCLAW_PUSH_SOCK!, { chatId: "home", text: "x" });
    expect(ack).toMatchObject({ ok: false, retryable: true });
  });

  it.each(["home", "macchiato:home"])("E2E 目的會話 %s → 本地拒絕，不洩露明文", async (protectedSid) => {
    protectedSids.add(protectedSid);
    const ack = await req(process.env.MACCHIATO_OPENCLAW_PUSH_SOCK!, {
      chatId: "home",
      text: "secret",
    });
    expect(ack).toEqual({ ok: false, error: "E2E push unsupported" });
    expect(sent).toEqual([]);
  });

  it.each([
    ["01UPPERWIRE", "01upperwire"],
    ["01UPPERWIRE", "agent:main:macchiato:01upperwire"],
  ])("E2E wire %s 的本地身份 %s → 本地拒絕，不依賴 drive map", async (wireSid, chatId) => {
    protectedSids.add(wireSid);
    const ack = await req(process.env.MACCHIATO_OPENCLAW_PUSH_SOCK!, {
      chatId,
      text: "secret",
    });
    expect(ack).toEqual({ ok: false, error: "E2E push unsupported" });
    expect(sent).toEqual([]);
  });
});
