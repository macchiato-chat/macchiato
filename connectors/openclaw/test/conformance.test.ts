/**
 * #303 openclaw conformance adapter：假 gateway WS 傳輸層 + 共享契約 suite。
 * openclaw 無 turn.usage / clarify / background task 結構化事件——只掛 message.complete
 * 信封契約（與 CC/Codex 共用同一套 assert），caps 其餘不宣告（localchain 同款響亮省略）。
 */
import { expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConformanceSuite } from "./_hermetic/conformance/index";
import { assertPathIsSandboxed, getSandboxHome } from "./_hermetic/index";
import { Drive } from "../src/openclaw/drive";
import { MACCHIATO_PREFIX } from "../src/openclaw/mirror";
import { credPath } from "../src/_core/identity";

function makeDrive() {
  process.env.MACCHIATO_OPENCLAW_TITLED = join(mkdtempSync(join(tmpdir(), "oc-conf-t-")), "titled.json");
  process.env.MACCHIATO_OPENCLAW_DRIVE = join(mkdtempSync(join(tmpdir(), "oc-conf-d-")), "drive.json");
  process.env.MACCHIATO_OPENCLAW_TITLE_MODE = "off";
  const gw: any = {
    handlers: [] as Array<(e: unknown) => void>,
    onEvent(h: (e: unknown) => void) {
      this.handlers.push(h);
      return () => {};
    },
    onConnected() {
      return () => {};
    },
    onDisconnected() {
      return () => {};
    },
    async request() {
      return { status: "started", runId: "r-conf" };
    },
    fire(evt: unknown) {
      for (const h of [...this.handlers]) h(evt);
    },
  };
  const sent: Record<string, unknown>[] = [];
  const linkb: any = {
    agentLinkId: "al-conf",
    handlers: [] as Array<(m: unknown) => void | Promise<void>>,
    onFrame(h: (m: unknown) => void | Promise<void>) {
      this.handlers.push(h);
    },
    send(m: Record<string, unknown>) {
      sent.push(m);
    },
    async deliver(m: unknown) {
      for (const h of this.handlers) await h(m);
    },
  };
  const mirror: any = {
    setDriven() {},
    fastForward() {},
  };
  const drive = new Drive(gw, linkb, mirror);
  drive.wire();
  return { gw, linkb, sent };
}

const tui = (method: string, sessionId: string, params: Record<string, unknown> = {}) => ({
  t: "tui",
  sessionId,
  frame: { jsonrpc: "2.0", method, params: { session_id: sessionId, ...params } },
});

it("#303 hermetic: OpenClaw credPath 落在沙箱 HOME", () => {
  delete process.env.MACCHIATO_OPENCLAW_CRED;
  const p = credPath("openclaw");
  expect(p.startsWith(getSandboxHome())).toBe(true);
  assertPathIsSandboxed(p);
});

defineConformanceSuite({
  name: "openclaw",
  caps: {
    turnUsage: false,
    messageComplete: true,
  },
  async collectTurn() {
    // openclaw 只產 message.complete（無 turn.usage → caps.turnUsage=false，不註冊那條用例）
    const { gw, linkb, sent } = makeDrive();
    const sid = "01CONFOPENCLAW00000000000";
    const KEY = `${MACCHIATO_PREFIX}${sid.toLowerCase()}`;
    await linkb.deliver(tui("prompt.submit", sid, { text: "hi" }));
    gw.fire({
      event: "chat",
      payload: { runId: "r-conf", sessionKey: KEY, state: "delta", deltaText: "你" },
    });
    gw.fire({
      event: "chat",
      payload: { runId: "r-conf", sessionKey: KEY, state: "delta", deltaText: "好" },
    });
    gw.fire({
      event: "chat",
      payload: {
        runId: "r-conf",
        sessionKey: KEY,
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "你好" }] },
      },
    });
    return sent;
  },
});
