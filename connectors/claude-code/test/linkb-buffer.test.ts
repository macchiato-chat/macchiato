import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { WebSocketServer } from "ws";
import { LinkBClient } from "../src/linkb/client";

const EMPTY_E2E_STATE = { version: 1, sessions: [], disabledReceipts: [] };

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

/** 真 WS 服務:收 hello → 回带 E2E 快照的 ready;記錄收到的幀。 */
function fakeServer() {
  const wss = new WebSocketServer({ port: 0 });
  const got: Record<string, unknown>[] = [];
  let delayReady = 0;
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === "hello") {
        setTimeout(() => ws.send(JSON.stringify({ t: "ready", e2eState: EMPTY_E2E_STATE })), delayReady);
      }
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
    const c = new LinkBClient(
      { serverUrl: `ws://127.0.0.1:${srv.port}`, connectorToken: "t", agentLinkId: "al" } as any,
      () => [],
    );
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
    const c = new LinkBClient(
      { serverUrl: `ws://127.0.0.1:${srv.port}`, connectorToken: "t", agentLinkId: "al" } as any,
      () => [],
    );
    // 未連接:E2E 批(sendE2ETurn)緩衝——transcript 對賬只補非 E2E,這批是內容唯一一份;明文批照舊丟
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
    const c = new LinkBClient(
      { serverUrl: `ws://127.0.0.1:${srv.port}`, connectorToken: "t", agentLinkId: "al" } as any,
      () => [],
    );
    for (let i = 0; i < 520; i++) c.send({ t: "tui", n: i });
    const p = (c as any).pending;
    expect(p.length).toBe(500);
    expect(JSON.parse(p[0]).n).toBe(20); // 最舊的 20 條被擠掉
    c.close();
  });

  it("#347 未配置 state applier 的纯 client 保持 legacy bare-ready 行为", () => {
    const c = new LinkBClient({
      serverUrl: "ws://127.0.0.1:1",
      connectorToken: "t",
      agentLinkId: "al",
    } as any);
    (c as any).handleFrame(Buffer.from(JSON.stringify({ t: "ready" })));
    expect(c.isReady).toBe(true);
    c.close();
    (c as any).onClose(); // 无真实 socket，手动清掉测试里的 liveness timer
  });

  it("#347 ready 先应用 E2E 快照、过滤 pending-enable 明文 TUI/历史 session，再 flush 其余帧", async () => {
    const wss = new WebSocketServer({ port: 0 });
    const got: Record<string, unknown>[] = [];
    const order: string[] = [];
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
        } else {
          order.push("flush");
          got.push(msg);
        }
      });
    });
    const port = (wss.address() as { port: number }).port;
    const applied: unknown[] = [];
    const c = new LinkBClient(
      { serverUrl: `ws://127.0.0.1:${port}`, connectorToken: "t", agentLinkId: "al" } as any,
      (state) => {
        order.push("apply");
        applied.push(state);
        return ["secure"];
      },
    );
    // 覆盖 top-level 与真实 CC frame.params.session_id 两种 sid 位置。
    c.send({ t: "tui", sessionId: "secure", n: 1, plaintext: "drop" });
    c.send({
      t: "tui",
      n: 2,
      frame: { method: "event", params: { session_id: "secure", payload: { text: "drop" } } },
    });
    c.send({ t: "voice_transcript", sessionId: "secure", n: 21, text: "drop voice" });
    c.send({ t: "connector_push", chatId: "secure", n: 22, text: "drop push" });
    c.send({
      t: "tui",
      n: 3,
      frame: { method: "event", params: { session_id: "plain", payload: { text: "keep" } } },
    });
    c.send({ t: "project_registry", n: 4 }); // 非 TUI 控制帧不误删
    c.send({
      t: "import_batch",
      n: 5,
      sessions: [
        { hermesSessionId: "secure", title: "plaintext secret", messages: [] },
        { hermesSessionId: "plain", title: "keep", messages: [] },
      ],
      done: false,
    });
    c.send({
      t: "import_batch",
      n: 6,
      sessions: [{ hermesSessionId: "secure", title: "plaintext secret", messages: [] }],
      done: true,
    });
    c.send({
      t: "mirror_append",
      n: 7,
      sessions: [
        { hermesSessionId: "secure", title: "plaintext secret", messages: [] },
        { hermesSessionId: "already-e2e", e2e: true, title: "ciphertext", messages: [] },
      ],
    });
    c.send({
      t: "mirror_append",
      n: 8,
      sessions: [{ hermesSessionId: "secure", e2e: true, title: "stale ciphertext", messages: [] }],
    });

    await c.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(applied).toEqual([
      {
        version: 1,
        disabledReceipts: [],
        sessions: [{ hermesSessionId: "secure", pendingOp: "enable" }],
      },
    ]);
    expect(order[0]).toBe("apply");
    expect(got.map((msg: any) => msg.n)).toEqual([3, 4, 5, 6, 7]);
    expect((got.find((msg: any) => msg.n === 5) as any).sessions.map((s: any) => s.hermesSessionId)).toEqual([
      "plain",
    ]);
    expect((got.find((msg: any) => msg.n === 7) as any).sessions.map((s: any) => s.hermesSessionId)).toEqual([
      "already-e2e",
    ]);
    expect((got.find((msg: any) => msg.n === 6) as any).sessions).toEqual([]);
    expect((got.find((msg: any) => msg.n === 6) as any).done).toBe(true);
    expect((c as any).pending).toEqual([]);
    c.close();
    await new Promise((resolve) => wss.close(resolve));
  });

  it("#347 bare ready fail closed：不进入 ready、不 flush 缓冲", async () => {
    const wss = new WebSocketServer({ port: 0 });
    const got: Record<string, unknown>[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.t === "hello") ws.send(JSON.stringify({ t: "ready" }));
        else got.push(msg);
      });
    });
    const port = (wss.address() as { port: number }).port;
    const c = new LinkBClient(
      { serverUrl: `ws://127.0.0.1:${port}`, connectorToken: "t", agentLinkId: "al" } as any,
      () => [],
    );
    c.send({ t: "tui", sessionId: "maybe-secure", plaintext: "must-not-flush" });
    let fatal = 0;
    c.onFatal = () => {
      fatal++;
    };
    void c.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fatal).toBe(1);
    expect(c.isReady).toBe(false);
    expect(got).toEqual([]);
    expect((c as any).pending).toHaveLength(1);
    c.close();
    await new Promise((resolve) => wss.close(resolve));
  });

  it("#347 state applier 拒绝快照时 fail closed，ready handlers 与 flush 都不触发", async () => {
    srv = fakeServer();
    const c = new LinkBClient(
      { serverUrl: `ws://127.0.0.1:${srv.port}`, connectorToken: "t", agentLinkId: "al" } as any,
      () => {
        throw new Error("keystore mismatch");
      },
    );
    c.send({ t: "tui", sessionId: "secure", plaintext: "must-not-flush" });
    let fatal = 0;
    let readyCallbacks = 0;
    c.onFatal = () => {
      fatal++;
    };
    c.onReady(() => {
      readyCallbacks++;
    });
    void c.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fatal).toBe(1);
    expect(readyCallbacks).toBe(0);
    expect(c.isReady).toBe(false);
    expect(srv.got).toEqual([]);
    expect((c as any).pending).toHaveLength(1);
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
    protectedNow = true; // title producer 在 enable 前启动、到 send 时 floor 已提升。
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
    protectedNow = true; // active turn 在断线时入队，enable 后才 flush。
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

    expect(filter({ t: "tui", frame: { params: { session_id: "secure" } } })).toBeNull();
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
