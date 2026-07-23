import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { E2EKeyStore } from "../src/e2e/keys";
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
function fakeServer(readyFrame: Record<string, unknown> = { t: "ready" }) {
  const wss = new WebSocketServer({ port: 0 });
  const got: Record<string, unknown>[] = [];
  let delayReady = 0;
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === "hello") setTimeout(() => ws.send(JSON.stringify(readyFrame)), delayReady);
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

  it("緩衝有界:超過上限丟最舊", () => {
    srv = fakeServer();
    const c = new LinkBClient({ serverUrl: `ws://127.0.0.1:${srv.port}`, connectorToken: "t", agentLinkId: "al" } as any);
    for (let i = 0; i < 520; i++) c.send({ t: "tui", n: i });
    const p = (c as any).pending;
    expect(p.length).toBe(500);
    expect(JSON.parse(p[0]).n).toBe(20); // 最舊的 20 條被擠掉
    c.close();
  });
});

describe("#347 ready E2E 狀態先於出站 flush", () => {
  let srv: ReturnType<typeof fakeServer>;
  afterEach(() => srv?.wss.close());

  it("先 apply server state，再丟棄 pending-enable 的首連前明文 TUI，最後才 ready/flush", async () => {
    const e2eState = {
      version: 1,
      disabledReceipts: [],
      sessions: [{ hermesSessionId: "secret", pendingOp: "enable" }],
    };
    srv = fakeServer({ t: "ready", e2eState });
    const observed: Array<{ state: unknown; ready: boolean }> = [];
    let c!: LinkBClient;
    c = new LinkBClient(
      { serverUrl: `ws://127.0.0.1:${srv.port}`, connectorToken: "t", agentLinkId: "al" } as any,
      (state) => {
        observed.push({ state, ready: c.isReady });
        return ["secret"];
      },
    );
    c.send({
      t: "tui",
      sessionId: "secret",
      frame: { params: { session_id: "secret", payload: { text: "首連前明文" } } },
    });
    c.send({ t: "voice_transcript", sessionId: "secret", text: "首連前語音明文" });
    c.send({ t: "connector_push", chatId: "secret", text: "首連前 push 明文" });
    c.send({ t: "tui", sessionId: "plain", n: 2 });

    await c.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(observed).toEqual([{ state: e2eState, ready: false }]);
    expect(c.isReady).toBe(true);
    expect(srv.got.map((m: any) => m.n)).toEqual([2]);
    expect((c as any).pending).toHaveLength(0);
    c.close();
  });

  it("pending-enable 逐 session 過濾歷史批，保留空的 import done 終止幀", async () => {
    srv = fakeServer({
      t: "ready",
      e2eState: {
        version: 1,
        disabledReceipts: [],
        sessions: [{ hermesSessionId: "secret", pendingOp: "enable" }],
      },
    });
    const c = new LinkBClient(
      { serverUrl: `ws://127.0.0.1:${srv.port}`, connectorToken: "t", agentLinkId: "al" } as any,
      () => ["secret"],
    );
    c.send({
      t: "import_batch",
      done: true,
      sessions: [
        { hermesSessionId: "secret", messages: [{ role: "user", text: "明文歷史" }] },
        { hermesSessionId: "plain", messages: [{ role: "user", text: "可保留" }] },
      ],
    });
    c.send({
      t: "import_batch",
      done: true,
      sessions: [{ hermesSessionId: "secret", messages: [{ role: "user", text: "整批丟" }] }],
    });
    c.send({
      t: "mirror_append",
      batchId: 7,
      sessions: [
        { hermesSessionId: "secret", messages: [{ role: "user", text: "明文鏡像" }] },
        { hermesSessionId: "already-e2e", e2e: true, messages: [{ role: "user", enc: "cipher" }] },
      ],
    });
    c.send({
      t: "mirror_append",
      batchId: 8,
      sessions: [{ hermesSessionId: "secret", e2e: true, messages: [{ role: "user", enc: "stale" }] }],
    });
    expect((c as any).pending).toHaveLength(4);

    await c.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(srv.got).toHaveLength(3);
    const imports = srv.got.filter((msg) => msg.t === "import_batch") as any[];
    const imported = imports.find((msg) => msg.sessions.length > 0);
    expect(imported.done).toBe(true);
    expect(imported.sessions.map((s: any) => s.hermesSessionId)).toEqual(["plain"]);
    expect(imports.find((msg) => msg.sessions.length === 0)).toMatchObject({ done: true, sessions: [] });
    const mirrored = srv.got.find((msg) => msg.t === "mirror_append") as any;
    expect(mirrored.batchId).toBe(7);
    expect(mirrored.sessions.map((s: any) => s.hermesSessionId)).toEqual(["already-e2e"]);
    expect((c as any).pending).toHaveLength(0);
    c.close();
  });

  it("runtime 傳入 state applier 時 bare ready 是 terminal fatal，且不 flush", async () => {
    srv = fakeServer();
    let applied = 0;
    let fatal = 0;
    const c = new LinkBClient(
      { serverUrl: `ws://127.0.0.1:${srv.port}`, connectorToken: "t", agentLinkId: "al" } as any,
      () => {
        applied++;
        return [];
      },
    );
    c.onFatal = () => {
      fatal++;
    };
    c.send({ t: "tui", sessionId: "s", n: 1 });
    void c.start();
    await new Promise((r) => setTimeout(r, 120));
    expect(applied).toBe(0); // client 自己先拒 bare ready。
    expect(fatal).toBe(1);
    expect(c.isReady).toBe(false);
    expect(srv.got).toHaveLength(0);
    expect((c as any).pending).toHaveLength(1);
    c.close();
  });

  it("完整 ready 快照漏掉本地已有 K_S 时只隔离该 session，其它连接继续 ready", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-ready-e2e-"));
    try {
      const store = new E2EKeyStore(join(dir, "keys.json"));
      store.createForEnable("local-only");
      srv = fakeServer({ t: "ready", e2eState: { version: 1, sessions: [], disabledReceipts: [] } });
      let fatal = 0;
      const c = new LinkBClient(
        { serverUrl: `ws://127.0.0.1:${srv.port}`, connectorToken: "t", agentLinkId: "al" } as any,
        (state) => store.applyServerState(state),
      );
      c.onFatal = () => {
        fatal++;
      };
      c.send({ t: "tui", sessionId: "local-only", plaintext: "must drop" });
      await c.start();
      c.send({ t: "voice_transcript", sessionId: "local-only", text: "runtime must drop" });
      await new Promise((r) => setTimeout(r, 80));
      expect(fatal).toBe(0);
      expect(c.isReady).toBe(true);
      expect(srv.got).toEqual([]);
      expect(() => store.requireKey("local-only")).toThrow(/quarantine/);
      c.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      (sid) => protectedNow && sid === "secret",
    );
    const deferredTitle = {
      t: "tui",
      sessionId: "secret",
      frame: {
        jsonrpc: "2.0",
        method: "event",
        params: { type: "session.title", session_id: "secret", payload: { title: "secret" } },
      },
    };
    protectedNow = true;
    (live as any).ws = liveSocket;
    (live as any).ready = true;
    live.send(deferredTitle);
    live.send({
      t: "tui",
      sessionId: "secret",
      frame: {
        jsonrpc: "2.0",
        method: "event",
        params: { type: "message.complete", session_id: "secret", payload: { text: "secret" } },
      },
    });
    expect(liveSocket.sent).toEqual([]);

    const ciphertext = Buffer.alloc(28, 0xa5).toString("base64");
    live.send({
      t: "tui",
      sessionId: "secret",
      frame: {
        jsonrpc: "2.0",
        method: "event",
        params: { type: "turn.usage", session_id: "secret", payload: { output_tokens: 3 } },
      },
    });
    live.send({
      t: "mirror_append",
      sessions: [{
        hermesSessionId: "secret",
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
      (sid) => protectedNow && sid === "secret",
    );
    queued.send({
      t: "tui",
      sessionId: "secret",
      frame: {
        jsonrpc: "2.0",
        method: "event",
        params: { type: "message.delta", session_id: "secret", payload: { text: "queued secret" } },
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

  it("blocked session 过滤 live/disable/history；成功 enable ACK 可动态解除", () => {
    const c = new LinkBClient(
      { serverUrl: "ws://unused", connectorToken: "t", agentLinkId: "al" } as any,
    );
    (c as any).blockedSessionIds = new Set(["secret"]);
    const filter = (message: Record<string, unknown>) => (c as any).filterBlockedOutbound(message);

    expect(filter({ t: "tui", sessionId: "secret" })).toBeNull();
    expect(filter({ t: "voice_transcript", sessionId: "secret" })).toBeNull();
    expect(filter({ t: "connector_push", chatId: "secret" })).toBeNull();
    expect(filter({ t: "e2e_backfill", mode: "disable", hermesSessionId: "secret" })).toBeNull();
    expect(filter({
      t: "e2e_backfill",
      mode: "enable",
      found: true,
      hermesSessionId: "secret",
      session: {
        hermesSessionId: "secret",
        e2e: true,
        messages: [{ role: "agent", enc: Buffer.alloc(28, 1).toString("base64") }],
      },
    })).not.toBeNull();
    expect(
      filter({
        t: "mirror_append",
        sessions: [{ hermesSessionId: "secret" }, { hermesSessionId: "plain" }],
      }),
    ).toMatchObject({ sessions: [{ hermesSessionId: "plain" }] });
    expect(filter({ t: "mirror_append", sessions: [{ hermesSessionId: "secret" }] })).toBeNull();
    expect(filter({ t: "import_batch", done: true, sessions: [{ hermesSessionId: "secret" }] })).toMatchObject({
      sessions: [],
      done: true,
    });

    c.unblockSession("secret");
    expect(filter({ t: "tui", sessionId: "secret" })).toMatchObject({ t: "tui", sessionId: "secret" });
  });

  it("旧 socket 的 open/ping/message/close/error 都不能影响新 generation", () => {
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
