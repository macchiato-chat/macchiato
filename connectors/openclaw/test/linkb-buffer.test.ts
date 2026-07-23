import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { WebSocketServer } from "ws";
import { LinkBClient } from "../src/linkb/client";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  closes = 0;
  send(raw: string): void {
    this.sent.push(raw);
  }
  close(): void {
    this.closes++;
    this.readyState = 3;
    this.emit("close");
  }
  terminate(): void {
    this.close();
  }
}

/** 真 WS 服務:收 hello → 回 ready;記錄收到的幀。 */
function fakeServer() {
  const wss = new WebSocketServer({ port: 0 });
  const got: Record<string, unknown>[] = [];
  let delayReady = 0;
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === "hello") setTimeout(() => ws.send(JSON.stringify({ t: "ready" })), delayReady);
      else got.push(m);
    });
  });
  const port = (wss.address() as { port: number }).port;
  return { wss, got, port, setDelay: (ms: number) => (delayReady = ms) };
}

describe("Link B 出站緩衝(影子會話修復:斷線期間幀不再靜默丟)", () => {
  let srv: ReturnType<typeof fakeServer>;
  afterEach(() => srv?.wss.close());

  it("未連接時 send → 緩衝;ready 後按序補發", async () => {
    srv = fakeServer();
    const c = new LinkBClient({ serverUrl: `ws://127.0.0.1:${srv.port}`, connectorToken: "t", agentLinkId: "al" } as any);
    // 未 start 就發:全部進緩衝
    c.send({ t: "tui", n: 1 });
    c.send({ t: "tui", n: 2 });
    c.send({ t: "mirror_append", n: 3 }); // 鏡像有水位線自愈 → 不緩衝
    expect((c as any).pending.length).toBe(2);
    await c.start(); // 連上 + ready → flush
    await new Promise((r) => setTimeout(r, 100));
    expect(srv.got.map((m: any) => m.n)).toEqual([1, 2]); // 按序、無鏡像幀
    expect((c as any).pending.length).toBe(0);
    c.close();
  });

  it("#243 E2E 加密批例外:斷線入緩衝、ready 後送達(明文鏡像批照舊丟)", async () => {
    srv = fakeServer();
    const c = new LinkBClient({ serverUrl: `ws://127.0.0.1:${srv.port}`, connectorToken: "t", agentLinkId: "al" } as any);
    // 未連接:E2E 批緩衝(唯一一份,對賬/打撈都跳過 E2E);明文批丟(有水位線自愈)
    c.send({ t: "mirror_append", n: 1, sessions: [{ hermesSessionId: "s", e2e: true, messages: [] }] });
    c.send({ t: "mirror_append", n: 2, sessions: [{ hermesSessionId: "p", messages: [] }] });
    expect((c as any).pending.length).toBe(1);
    await c.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(srv.got.map((m: any) => m.n)).toEqual([1]); // E2E 批送達,明文批沒重發
    c.close();
  });

  it("緩衝有界:超過上限丟最舊", () => {
    srv = fakeServer();
    const c = new LinkBClient({ serverUrl: `ws://127.0.0.1:${srv.port}`, connectorToken: "t", agentLinkId: "al" } as any);
    for (let i = 0; i < 520; i++) c.send({ t: "tui", n: i });
    const p = (c as any).pending;
    expect(p.length).toBe(500);
    expect(JSON.parse(p[0]).n).toBe(20); // 最舊的 20 條被擠掉
    c.close();
  });

  it("#347 ready 先套 E2E 快照并丢弃 pending-enable 的旧明文，再 flush 其余帧", async () => {
    const wss = new WebSocketServer({ port: 0 });
    const got: Record<string, unknown>[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.t === "hello") {
          ws.send(
            JSON.stringify({
              t: "ready",
              e2eState: {
                version: 1,
                disabledReceipts: [],
                sessions: [{ hermesSessionId: "secure", pendingOp: "enable" }],
              },
            }),
          );
        } else got.push(msg);
      });
    });
    const port = (wss.address() as { port: number }).port;
    const applied: unknown[] = [];
    const c = new LinkBClient(
      { serverUrl: `ws://127.0.0.1:${port}`, connectorToken: "t", agentLinkId: "al" } as any,
      (state) => {
        applied.push(state);
        return ["secure"];
      },
    );
    c.send({
      t: "tui",
      sessionId: "secure",
      frame: { method: "event", params: { session_id: "secure", payload: { text: "plaintext secret" } } },
    });
    c.send({ t: "voice_transcript", sessionId: "secure", text: "voice secret" });
    c.send({ t: "connector_push", chatId: "secure", text: "push secret" });
    c.send({
      t: "tui",
      sessionId: "plain",
      frame: { method: "event", params: { session_id: "plain", payload: { text: "ok" } } },
    });
    c.send({
      t: "import_batch",
      sessions: [
        { hermesSessionId: "secure", messages: [{ role: "user", text: "import secret" }] },
        { hermesSessionId: "plain", messages: [{ role: "user", text: "safe import" }] },
      ],
      done: false,
    });
    c.send({
      t: "import_batch",
      sessions: [{ hermesSessionId: "secure", messages: [{ role: "user", text: "final secret" }] }],
      done: true,
    });
    // 明文 mirror 正常不入缓冲；直接造出一帧覆盖 ready 清理的纵深边界与未来策略改动。
    (c as any).pending.push(
      JSON.stringify({
        t: "mirror_append",
        sessions: [
          { hermesSessionId: "secure", messages: [{ role: "user", text: "mirror secret" }] },
          { hermesSessionId: "plain", messages: [{ role: "user", text: "safe mirror" }] },
        ],
      }),
    );
    await c.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(applied).toHaveLength(1);
    expect(got[0]?.sessionId).toBe("plain");
    expect((got[1] as any).sessions.map((session: any) => session.hermesSessionId)).toEqual(["plain"]);
    expect(got[2]).toMatchObject({ t: "import_batch", done: true, sessions: [] });
    expect((got[3] as any).sessions.map((session: any) => session.hermesSessionId)).toEqual(["plain"]);
    expect(JSON.stringify(got)).not.toContain("secret");
    c.close();
    await new Promise((resolve) => wss.close(resolve));
  });

  it("#347 新 connector 收到 bare ready 时 fail closed，不 flush 缓冲", async () => {
    srv = fakeServer();
    const c = new LinkBClient(
      { serverUrl: `ws://127.0.0.1:${srv.port}`, connectorToken: "t", agentLinkId: "al" } as any,
      (state) => {
        if (!state) throw new Error("missing e2eState");
        return [];
      },
    );
    c.send({ t: "tui", sessionId: "maybe-secure", secret: "plaintext" });
    let fatal = 0;
    c.onFatal = () => {
      fatal++;
    };
    void c.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fatal).toBe(1);
    expect(srv.got).toEqual([]);
    c.close();
  });
});

describe("#347 per-session runtime 隔离与 socket generation", () => {
  it("#370 e2e_control_result 最终闸只放行 exact route 与稳定结果码", () => {
    const c = new LinkBClient(
      { serverUrl: "ws://unused", connectorToken: "t", agentLinkId: "al" } as any,
    );
    const filter = (message: Record<string, unknown>) =>
      (c as any).filterBlockedOutbound(message);
    const accepted = {
      t: "e2e_control_result",
      agentLinkId: "al",
      sessionId: "public",
      hermesSessionId: "wire",
      msgId: "msg-1",
      ok: true,
    };
    expect(filter(accepted)).toEqual(accepted);
    expect(filter({ ...accepted, ok: false, error: "control_rejected" })).not.toBeNull();
    expect(filter({ ...accepted, ok: false, error: "side_effect_failed" })).not.toBeNull();
    expect(filter({ ...accepted, error: "本地路径 /secret" })).toBeNull();
    expect(filter({ ...accepted, ok: false, error: "arbitrary detail" })).toBeNull();
    expect(filter({ ...accepted, agentLinkId: "other" })).toBeNull();
    expect(filter({ ...accepted, sessionId: "" })).toBeNull();
    expect(filter({ ...accepted, extra: "covert channel" })).toBeNull();
  });

  it("#370 authoritative floor 最终拦截 deferred title 与 active-turn flush race", () => {
    let protectedNow = false;
    const liveSocket = new FakeSocket();
    const live = new LinkBClient(
      { serverUrl: "ws://unused", connectorToken: "t", agentLinkId: "al" } as any,
      undefined,
      undefined,
      (sid) => protectedNow && sid === "secure",
    );
    const deferredTitle = {
      t: "tui",
      sessionId: "secure",
      frame: {
        jsonrpc: "2.0",
        method: "event",
        params: { type: "session.title", session_id: "secure", payload: { title: "secret" } },
      },
    };
    protectedNow = true;
    (live as any).ws = liveSocket;
    (live as any).ready = true;
    live.send(deferredTitle);
    live.send({
      t: "tui",
      sessionId: "secure",
      frame: {
        jsonrpc: "2.0",
        method: "event",
        params: { type: "message.complete", session_id: "secure", payload: { text: "secret" } },
      },
    });
    expect(liveSocket.sent).toEqual([]);

    const ciphertext = Buffer.alloc(28, 0xa5).toString("base64");
    live.send({
      t: "tui",
      sessionId: "secure",
      frame: {
        jsonrpc: "2.0",
        method: "event",
        params: { type: "turn.usage", session_id: "secure", payload: { output_tokens: 3 } },
      },
    });
    live.send({
      t: "mirror_append",
      sessions: [{
        hermesSessionId: "secure",
        e2e: true,
        messages: [{ role: "agent", enc: ciphertext }],
      }],
    });
    expect(liveSocket.sent.map((raw) => JSON.parse(raw).t)).toEqual(["tui", "mirror_append"]);

    protectedNow = false;
    const queuedSocket = new FakeSocket();
    const queued = new LinkBClient(
      { serverUrl: "ws://unused", connectorToken: "t", agentLinkId: "al" } as any,
      undefined,
      undefined,
      (sid) => protectedNow && sid === "secure",
    );
    queued.send({
      t: "tui",
      sessionId: "secure",
      frame: {
        jsonrpc: "2.0",
        method: "event",
        params: { type: "message.delta", session_id: "secure", payload: { text: "queued secret" } },
      },
    });
    expect((queued as any).pending).toHaveLength(1);
    protectedNow = true;
    (queued as any).ws = queuedSocket;
    (queued as any).ready = true;
    (queued as any).flushPending();
    expect(queuedSocket.sent).toEqual([]);
    expect((queued as any).pending).toEqual([]);
  });

  it("blocked session 过滤 live/disable/history，unblock 后恢复", () => {
    const c = new LinkBClient(
      { serverUrl: "ws://unused", connectorToken: "t", agentLinkId: "al" } as any,
    );
    (c as any).blockedSessionIds = new Set(["secure"]);
    const filter = (message: Record<string, unknown>) => (c as any).filterBlockedOutbound(message);

    expect(filter({ t: "tui", sessionId: "secure" })).toBeNull();
    expect(filter({ t: "voice_transcript", sessionId: "secure" })).toBeNull();
    expect(filter({ t: "connector_push", chatId: "secure" })).toBeNull();
    expect(filter({ t: "e2e_backfill", mode: "disable", hermesSessionId: "secure" })).toBeNull();
    expect(filter({
      t: "e2e_backfill",
      mode: "enable",
      found: true,
      hermesSessionId: "secure",
      session: {
        hermesSessionId: "secure",
        e2e: true,
        messages: [{ role: "agent", enc: Buffer.alloc(28, 1).toString("base64") }],
      },
    })).not.toBeNull();
    expect(
      filter({
        t: "mirror_append",
        sessions: [{ hermesSessionId: "secure" }, { hermesSessionId: "plain" }],
      }),
    ).toMatchObject({ sessions: [{ hermesSessionId: "plain" }] });
    expect(filter({ t: "mirror_append", sessions: [{ hermesSessionId: "secure" }] })).toBeNull();
    expect(filter({ t: "import_batch", done: true, sessions: [{ hermesSessionId: "secure" }] })).toMatchObject({
      sessions: [],
      done: true,
    });

    c.unblockSession("secure");
    expect(filter({ t: "tui", sessionId: "secure" })).toMatchObject({ t: "tui", sessionId: "secure" });
  });

  it("旧 socket 的 open/ping/message/close/error 全部被 generation guard 拦截", () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    let next = 0;
    const c = new LinkBClient(
      { serverUrl: "ws://unused", connectorToken: "t", agentLinkId: "al" } as any,
      undefined,
      () => sockets[next++] as any,
    );
    let fatal = 0;
    c.onFatal = () => fatal++;
    let livenessBumps = 0;
    (c as any).bumpLiveness = () => livenessBumps++;

    (c as any).connect();
    (c as any).connect();
    first.emit("open");
    expect(first.sent).toEqual([]);
    expect(first.closes).toBe(1);
    second.emit("open");
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ t: "hello", agentLinkId: "al", e2eFailClosed: 1 });
    const bumpsAfterCurrentOpen = livenessBumps;

    first.emit("ping");
    first.emit("message", Buffer.from(JSON.stringify({ t: "auth_error", reason: "stale" })));
    first.emit("error", new Error("stale"));
    first.emit("close");
    expect(livenessBumps).toBe(bumpsAfterCurrentOpen);
    expect(fatal).toBe(0);
    expect(c.isReady).toBe(false);
    expect((c as any).ws).toBe(second);

    second.emit("message", Buffer.from(JSON.stringify({ t: "ready" })));
    expect(c.isReady).toBe(true);
    first.emit("message", Buffer.from(JSON.stringify({ t: "auth_error", reason: "late" })));
    first.emit("close");
    expect(c.isReady).toBe(true);
    expect(fatal).toBe(0);
    c.close();
  });
});

describe("#246 auth_error 終端退出(不殭屍)", () => {
  it("auth_error → onFatal(交 supervisor 退出),不再靜默空轉", async () => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        if (JSON.parse(String(raw)).t === "hello") ws.send(JSON.stringify({ t: "auth_error", reason: "revoked" }));
      });
    });
    const port = (wss.address() as { port: number }).port;
    const c = new LinkBClient({ serverUrl: `ws://127.0.0.1:${port}`, connectorToken: "t", agentLinkId: "al" } as any);
    let fatal = 0;
    c.onFatal = () => {
      fatal++;
    };
    void c.start().catch(() => {});
    await new Promise((r) => setTimeout(r, 120));
    expect(fatal).toBe(1); // 退出交 supervisor,不殭屍
    c.close();
    await new Promise((r) => wss.close(r));
  });
});


describe("#247 Link B 半開連接偵測", () => {
  it("LIVENESS_MS 內無入站(server 半開)→ terminate(觸發 onClose 重連)", async () => {
    const prev = process.env.MACCHIATO_LINKB_LIVENESS_MS;
    process.env.MACCHIATO_LINKB_LIVENESS_MS = "80"; // 80ms 無入站即判半開
    let closed = 0;
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => {
      ws.on("close", () => closed++);
      // 收 hello 後故意不回 ready、不 ping(模擬半開)——client 的 liveness 應 terminate 它
    });
    const port = (wss.address() as { port: number }).port;
    const c = new LinkBClient({ serverUrl: `ws://127.0.0.1:${port}`, connectorToken: "t", agentLinkId: "al" } as any);
    void c.start().catch(() => {});
    await new Promise((r) => setTimeout(r, 250)); // > 80ms liveness:半開連接被 terminate
    expect(closed).toBeGreaterThanOrEqual(1); // 半開連接被判死關閉(而非幀發黑洞永不重連)
    expect((c as any).ready).toBe(false);
    c.close();
    await new Promise((r) => wss.close(r));
    if (prev === undefined) delete process.env.MACCHIATO_LINKB_LIVENESS_MS;
    else process.env.MACCHIATO_LINKB_LIVENESS_MS = prev;
  });
});
