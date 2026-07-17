import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { LinkBClient } from "../src/linkb/client";

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
