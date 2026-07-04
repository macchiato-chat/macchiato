import { describe, it, expect } from "vitest";
import { Drive, keyForSid, sidForKey } from "../src/openclaw/drive";
import { MACCHIATO_PREFIX } from "../src/openclaw/mirror";

function makeDrive() {
  const calls: { method: string; params: any }[] = [];
  const gw: any = {
    handlers: [] as any[],
    onEvent(h: any) {
      this.handlers.push(h);
    },
    async request(method: string, params: any) {
      calls.push({ method, params });
      return { status: "started", runId: "r1" };
    },
    fire(evt: any) {
      for (const h of this.handlers) h(evt);
    },
  };
  const sent: any[] = [];
  const linkb: any = {
    agentLinkId: "al1",
    handlers: [] as any[],
    onFrame(h: any) {
      this.handlers.push(h);
    },
    send(m: any) {
      sent.push(m);
    },
    async deliver(m: any) {
      for (const h of this.handlers) await h(m);
    },
  };
  const mirror: any = { drivenSet: [] as string[], ff: [] as string[], setDriven(k: string) { this.drivenSet.push(k); }, fastForward(k: string) { this.ff.push(k); } };
  const drive = new Drive(gw, linkb, mirror);
  drive.wire();
  return { drive, gw, linkb, mirror, calls, sent };
}

const tui = (method: string, sessionId: string, params: any = {}) => ({
  t: "tui",
  sessionId,
  frame: { jsonrpc: "2.0", method, params: { session_id: sessionId, ...params } },
});

describe("drive key 映射", () => {
  it("agent: 開頭（鏡像來的）直接用；否則包 macchiato 前綴；雙向可逆", () => {
    expect(keyForSid("agent:main:discord:channel:1")).toBe("agent:main:discord:channel:1");
    expect(keyForSid("01ABC")).toBe(`${MACCHIATO_PREFIX}01abc`); // OpenClaw 小寫化 key
    expect(sidForKey(`${MACCHIATO_PREFIX}01abc`)).toBe("01abc");
    expect(sidForKey("agent:main:discord:channel:1")).toBe("agent:main:discord:channel:1");
  });
});

describe("drive 下行分派", () => {
  it("prompt.submit（空閒）→ chat.send + 登記 driven", async () => {
    const { linkb, calls, mirror } = makeDrive();
    await linkb.deliver(tui("prompt.submit", "01SID", { text: "你好" }));
    expect(calls[0].method).toBe("chat.send");
    expect(calls[0].params.sessionKey).toBe(`${MACCHIATO_PREFIX}01sid`);
    expect(calls[0].params.message).toBe("你好");
    expect(calls[0].params.idempotencyKey).toBeTruthy();
    expect(mirror.drivenSet).toContain(`${MACCHIATO_PREFIX}01sid`);
  });

  it("prompt.submit（回合進行中）→ sessions.steer（§18）", async () => {
    const { drive, gw, linkb, calls } = makeDrive();
    await linkb.deliver(tui("prompt.submit", "01SID", { text: "第一條" }));
    gw.fire({ event: "agent", payload: { stream: "lifecycle", data: { phase: "start" }, runId: "r1", sessionKey: `${MACCHIATO_PREFIX}01sid` } });
    await linkb.deliver(tui("prompt.submit", "01SID", { text: "追加" }));
    expect(calls[1].method).toBe("sessions.steer");
    expect(calls[1].params).toMatchObject({ key: `${MACCHIATO_PREFIX}01sid`, message: "追加" });
  });

  it("session.interrupt → sessions.abort", async () => {
    const { linkb, calls } = makeDrive();
    await linkb.deliver(tui("session.interrupt", "agent:main:discord:channel:9"));
    expect(calls[0]).toMatchObject({ method: "sessions.abort", params: { key: "agent:main:discord:channel:9" } });
  });
});

describe("drive 上行翻譯（chat/lifecycle → tui EVENT）", () => {
  it("delta → message.start（一次）+ message.delta；final → message.complete", async () => {
    const { gw, linkb, sent } = makeDrive();
    const KEY = `${MACCHIATO_PREFIX}01sid`;
    await linkb.deliver(tui("prompt.submit", "01SID", { text: "hi" })); // 登記 driven
    gw.fire({ event: "chat", payload: { runId: "r1", sessionKey: KEY, state: "delta", deltaText: "你" } });
    gw.fire({ event: "chat", payload: { runId: "r1", sessionKey: KEY, state: "delta", deltaText: "好" } });
    gw.fire({ event: "chat", payload: { runId: "r1", sessionKey: KEY, state: "final", message: { role: "assistant", content: [{ type: "text", text: "你好" }] } } });
    const types = sent.map((m) => m.frame.params.type);
    expect(types).toEqual(["message.start", "message.delta", "message.delta", "message.complete"]);
    expect(sent[1].frame.params.payload.text).toBe("你");
    expect(sent[3].frame.params.payload.text).toBe("你好");
    expect(sent[0].sessionId).toBe("01SID"); // 回傳用 server 的 sid，不是 OpenClaw key
    expect(sent[0].t).toBe("tui");
    expect(sent[0].agentLinkId).toBe("al1");
  });

  it("OpenClaw 小寫化 key：大寫 sid 驅動、小寫事件回來 → 回傳仍用原始大寫 sid", async () => {
    const { gw, linkb, sent } = makeDrive();
    await linkb.deliver(tui("prompt.submit", "01KWNFM8ZB", { text: "hi" }));
    gw.fire({ event: "chat", payload: { runId: "r9", sessionKey: `${MACCHIATO_PREFIX}01kwnfm8zb`, state: "final", message: { role: "assistant", content: [{ type: "text", text: "回" }] } } });
    expect(sent.length).toBe(2); // start + complete
    expect(sent[1].sessionId).toBe("01KWNFM8ZB"); // 原始大寫 sid 還原 ✓
    expect(sent[1].frame.params.session_id).toBe("01KWNFM8ZB");
  });

  it("非 driven 會話的事件忽略（別把 Discord live 會話誤翻譯）", async () => {
    const { gw, sent } = makeDrive();
    gw.fire({ event: "chat", payload: { runId: "rX", sessionKey: "agent:main:discord:channel:7", state: "delta", deltaText: "x" } });
    expect(sent).toEqual([]);
  });

  it("lifecycle start 立發 message.start（app 立刻顯示工作中）；end 無 final → 兜底 complete", async () => {
    const { gw, linkb, mirror, sent, calls } = makeDrive();
    const KEY = `${MACCHIATO_PREFIX}01sid`;
    await linkb.deliver(tui("prompt.submit", "01SID", { text: "hi" }));
    gw.fire({ event: "agent", payload: { stream: "lifecycle", data: { phase: "start" }, runId: "r1", sessionKey: KEY } });
    expect(sent.map((m) => m.frame.params.type)).toEqual(["message.start"]); // 回合一開跑就 start
    gw.fire({ event: "chat", payload: { runId: "r1", sessionKey: KEY, state: "delta", deltaText: "部分" } });
    gw.fire({ event: "agent", payload: { stream: "lifecycle", data: { phase: "end" }, runId: "r1", sessionKey: KEY } });
    const types = sent.map((m) => m.frame.params.type);
    expect(types).toEqual(["message.start", "message.delta", "message.complete"]); // end 兜底 complete
    expect(sent[2].frame.params.payload.text).toBe("部分"); // 用累積 delta 補全
    expect(mirror.ff).toContain(KEY);
    // 回合結束後再 submit → 走 chat.send 而非 steer
    await linkb.deliver(tui("prompt.submit", "01SID", { text: "再來" }));
    expect(calls[calls.length - 1].method).toBe("chat.send");
  });

  it("正常回合：start(lifecycle) → delta → final complete → end 不重複 complete", async () => {
    const { gw, linkb, sent } = makeDrive();
    const KEY = `${MACCHIATO_PREFIX}01sid`;
    await linkb.deliver(tui("prompt.submit", "01SID", { text: "hi" }));
    gw.fire({ event: "agent", payload: { stream: "lifecycle", data: { phase: "start" }, runId: "r1", sessionKey: KEY } });
    gw.fire({ event: "chat", payload: { runId: "r1", sessionKey: KEY, state: "delta", deltaText: "全文" } });
    gw.fire({ event: "chat", payload: { runId: "r1", sessionKey: KEY, state: "final", message: { role: "assistant", content: [{ type: "text", text: "全文" }] } } });
    gw.fire({ event: "agent", payload: { stream: "lifecycle", data: { phase: "end" }, runId: "r1", sessionKey: KEY } });
    const types = sent.map((m) => m.frame.params.type);
    expect(types).toEqual(["message.start", "message.delta", "message.complete"]); // 恰好一次 complete
  });

  it("final 只認 assistant（user 的 final 不回傳）", async () => {
    const { gw, linkb, sent } = makeDrive();
    const KEY = `${MACCHIATO_PREFIX}01sid`;
    await linkb.deliver(tui("prompt.submit", "01SID", { text: "hi" }));
    gw.fire({ event: "chat", payload: { runId: "r2", sessionKey: KEY, state: "final", message: { role: "user", content: [{ type: "text", text: "hi" }] } } });
    expect(sent).toEqual([]);
  });
});

describe("drive E2E（§19 方案 A）", () => {
  async function makeE2E() {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { E2EKeyStore } = await import("../src/e2e/keys");
    const store = new E2EKeyStore(join(mkdtempSync(join(tmpdir(), "occ-de2e-")), "e2e.json"));
    const calls: any[] = [];
    const gw: any = { handlers: [] as any[], onEvent(h: any) { this.handlers.push(h); },
      async request(method: string, params: any) { calls.push({ method, params }); return { status: "started" }; },
      fire(evt: any) { for (const h of this.handlers) h(evt); } };
    const sent: any[] = [];
    const linkb: any = { agentLinkId: "al1", handlers: [] as any[], onFrame(h: any) { this.handlers.push(h); },
      send(m: any) { sent.push(m); }, async deliver(m: any) { for (const h of this.handlers) await h(m); } };
    const mirror: any = { setDriven() {}, fastForward() {} };
    const { Drive } = await import("../src/openclaw/drive");
    const d = new Drive(gw, linkb, mirror, store);
    d.wire();
    return { store, gw, linkb, calls, sent };
  }

  it("入站密文解密後提交 agent；回合 final → 加密鏡像批（user+agent enc）、不發明文 tui", async () => {
    const { store, gw, linkb, calls, sent } = await makeE2E();
    const SID = "01E2ESID";
    store.getOrCreateKey(SID); // 開 E2E
    const cipher = store.encryptText(SID, "祕密提問");
    await linkb.deliver({ t: "tui", sessionId: SID, frame: { method: "prompt.submit", params: { session_id: SID, text: cipher } } });
    expect(calls[0].method).toBe("chat.send");
    expect(calls[0].params.message).toBe("祕密提問"); // agent 收到明文
    const KEY = `agent:main:macchiato:${SID.toLowerCase()}`;
    gw.fire({ event: "agent", payload: { stream: "lifecycle", data: { phase: "start" }, runId: "r1", sessionKey: KEY } });
    gw.fire({ event: "chat", payload: { runId: "r1", sessionKey: KEY, state: "delta", deltaText: "祕" } });
    expect(sent.filter((m) => m.t === "tui")).toEqual([]); // 無明文 tui（含 message.start/delta）
    gw.fire({ event: "chat", payload: { runId: "r1", sessionKey: KEY, state: "final", message: { role: "assistant", content: [{ type: "text", text: "祕密回覆" }] } } });
    const batches = sent.filter((m) => m.t === "mirror_append");
    expect(batches.length).toBe(1);
    const sess = batches[0].sessions[0];
    expect(sess.hermesSessionId).toBe(SID); // 原始大小寫 sid
    expect(sess.e2e).toBe(true);
    expect(sess.messages.length).toBe(2);
    expect(sess.messages[0].role).toBe("user");
    expect((store.decryptContent(SID, sess.messages[0].enc) as any).text).toBe("祕密提問");
    expect((store.decryptContent(SID, sess.messages[1].enc) as any).text).toBe("祕密回覆");
    expect(JSON.stringify(sess)).not.toContain("祕密回覆"); // 批裡無明文
  });

  it("非 E2E 會話不受影響（明文 tui 照常）", async () => {
    const { gw, linkb, sent } = await makeE2E();
    await linkb.deliver({ t: "tui", sessionId: "01PLAIN", frame: { method: "prompt.submit", params: { session_id: "01PLAIN", text: "普通" } } });
    const KEY = "agent:main:macchiato:01plain";
    gw.fire({ event: "agent", payload: { stream: "lifecycle", data: { phase: "start" }, runId: "r2", sessionKey: KEY } });
    expect(sent.filter((m) => m.t === "tui").map((m) => m.frame.params.type)).toEqual(["message.start"]);
  });
});
