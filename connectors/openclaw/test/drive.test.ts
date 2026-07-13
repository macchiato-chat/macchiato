import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Drive, keyForSid, sidForKey } from "../src/openclaw/drive";
import { MACCHIATO_PREFIX } from "../src/openclaw/mirror";
import { titlegenKey } from "../src/openclaw/titles";

function makeDrive(opts: { titleMode?: string } = {}) {
  // #113:標題持久集隔離到臨時文件;默認 off(專項測試才開),免干擾既有 calls/sent 斷言
  process.env.MACCHIATO_OPENCLAW_TITLED = join(mkdtempSync(join(tmpdir(), "oc-titled-")), "titled.json");
  process.env.MACCHIATO_OPENCLAW_DRIVE = join(mkdtempSync(join(tmpdir(), "oc-drive-")), "drive.json"); // #202 隔離對賬狀態
  process.env.MACCHIATO_OPENCLAW_TITLE_MODE = opts.titleMode ?? "off";
  const calls: { method: string; params: any }[] = [];
  const gw: any = {
    handlers: [] as any[],
    onEvent(h: any) {
      this.handlers.push(h);
      return () => {
        const i = this.handlers.indexOf(h);
        if (i >= 0) this.handlers.splice(i, 1);
      };
    },
    async request(method: string, params: any) {
      calls.push({ method, params });
      // #113:titlegen 的 agent RPC → 異步回 chat final 事件(復刻真 gateway 行為)
      if (method === "agent" && typeof params?.sessionKey === "string") {
        setTimeout(() => {
          gw.fire({ event: "chat", payload: { sessionKey: params.sessionKey, state: "final",
            message: { role: "assistant", content: [{ type: "text", text: "「重構支付錯誤處理」" }] } } });
        }, 5);
      }
      return { status: "started", runId: "r1" };
    },
    fire(evt: any) {
      for (const h of [...this.handlers]) h(evt);
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

describe("#60 附件入站", () => {
  it("下載失敗 → review.summary 降級回執(不再靜默);正文照常送達", async () => {
    const { linkb, calls, sent } = makeDrive();
    await linkb.deliver(tui("prompt.submit", "01SID", {
      text: "看看這張圖",
      attachments: [{ id: "a1", kind: "image", url: "not-a-url" }, { id: "a2", kind: "file", url: "ftp://x" }],
    }));
    await new Promise((r) => setImmediate(r)); // onServerFrame 是 fire-and-forget,等附件 await 鏈跑完
    const line = sent.find((m) => m.frame?.params?.type === "review.summary");
    expect(line?.frame.params.payload.summary).toContain("2 個附件下載失敗");
    const send = calls.find((c) => c.method === "chat.send");
    expect(send?.params.message).toBe("看看這張圖"); // 正文照發
    expect(send?.params.attachments).toBeUndefined(); // 全失敗 → 不帶空數組
  });

  it("下載成功 → chat.send 帶 attachments(base64),無降級回執(真 localhost 下載鏈路)", async () => {
    const { createServer } = await import("node:http");
    const srv = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from("hi"));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as any).port;
    try {
      const { linkb, calls, sent } = makeDrive();
      await linkb.deliver(tui("prompt.submit", "01SID", {
        text: "看圖",
        attachments: [{ id: "a1", kind: "image", name: "x.png", mime: "image/png",
                        url: `http://127.0.0.1:${port}/x.png` }],
      }));
      await new Promise((r) => setTimeout(r, 200)); // 等真下載完成
      const send = calls.find((c) => c.method === "chat.send");
      expect(send?.params.attachments).toEqual([
        { mimeType: "image/png", fileName: "x.png", content: Buffer.from("hi").toString("base64") },
      ]);
      expect(sent.filter((m) => m.frame?.params?.type === "review.summary")).toEqual([]);
    } finally {
      srv.close();
    }
  });

  it("純 audio 附件不觸發回執(語音走 #89 雲端 STT/降級回執,不重複提示)", async () => {
    const { linkb, sent } = makeDrive();
    await linkb.deliver(tui("prompt.submit", "01SID", { text: "語音", attachments: [{ id: "v1", kind: "audio" }] }));
    expect(sent.filter((m) => m.frame?.params?.type === "review.summary")).toEqual([]);
    expect(sent.find((m) => m.t === "voice_transcript")).toBeTruthy(); // 語音降級回執照舊
  });
});

describe("#113 自動標題(經用戶自己的 agent,隱藏 titlegen 會話)", () => {
  it("首個 prompt → agent RPC(titlegen key,deliver:false)→ chat final → session.title(清洗過)", async () => {
    const { linkb, calls, sent } = makeDrive({ titleMode: "summary" });
    await linkb.deliver(tui("prompt.submit", "01TITLESID", { text: "帮我重构支付模块的错误处理" }));
    await new Promise((r) => setTimeout(r, 40)); // 等 fake final 事件回來
    const agentCalls = calls.filter((c) => c.method === "agent");
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0].params.sessionKey).toBe(titlegenKey("01TITLESID")); // macchiato: 前綴 → 鏡像/導入跳過
    expect(agentCalls[0].params.deliver).toBe(false);
    const titleEvt = sent.find((m) => m.frame?.params?.type === "session.title");
    expect(titleEvt?.frame.params.payload.title).toBe("重構支付錯誤處理"); // 引號已清洗
    expect(titleEvt?.sessionId).toBe("01TITLESID");
    // 同會話再來 prompt → 不重生(titled 持久集)
    await linkb.deliver(tui("prompt.submit", "01TITLESID", { text: "繼續" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.method === "agent")).toHaveLength(1);
  });

  it("鏡像來的會話(agent: key)不生成——它有自己的頻道標題", async () => {
    const { linkb, calls } = makeDrive({ titleMode: "summary" });
    await linkb.deliver(tui("prompt.submit", "agent:main:discord:channel:7", { text: "頻道續聊" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.method === "agent")).toHaveLength(0);
  });

  it("titlegen 會話的 final 事件不會被 drive 誤翻譯成消息(非 driven → 忽略)", async () => {
    const { linkb, sent } = makeDrive({ titleMode: "summary" });
    await linkb.deliver(tui("prompt.submit", "01TITLESID2", { text: "你好" }));
    await new Promise((r) => setTimeout(r, 40));
    // titlegen 會話的 chat final 只產生 session.title,不產生 message.* 幀
    const msgFrames = sent.filter((m) => String(m.frame?.params?.type ?? "").startsWith("message."));
    expect(msgFrames).toEqual([]);
  });
});

describe("drive E2E（§19 方案 A）", () => {
  async function makeE2E() {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    process.env.MACCHIATO_OPENCLAW_TITLED = join(mkdtempSync(join(tmpdir(), "oc-titled-")), "titled.json");
    process.env.MACCHIATO_OPENCLAW_TITLE_MODE = "off"; // #113 E2E 測試不摻標題
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

describe("#4 prompt 級重試(gateway 死於在途)", () => {
  function makeRetryDrive(behavior: (call: { method: string; params: any }, n: number) => any) {
    process.env.MACCHIATO_OPENCLAW_TITLED = join(mkdtempSync(join(tmpdir(), "oc-titled-")), "titled.json");
    process.env.MACCHIATO_OPENCLAW_TITLE_MODE = "off";
    const calls: { method: string; params: any }[] = [];
    const gw: any = {
      isConnected: true, // 重投循環立即通過(不等 1s 輪詢)
      handlers: [] as any[],
      onEvent(h: any) { this.handlers.push(h); return () => {}; },
      async request(method: string, params: any) {
        const call = { method, params };
        calls.push(call);
        return behavior(call, calls.length);
      },
    };
    const linkb: any = {
      agentLinkId: "al1",
      handlers: [] as any[],
      onFrame(h: any) { this.handlers.push(h); },
      send() {},
      async deliver(m: any) { for (const h of this.handlers) await h(m); },
    };
    const drive = new Drive(gw, linkb);
    drive.wire();
    return { drive, linkb, calls };
  }

  it("連接死於 chat.send 在途 → 重連後重投一次,且復用原 idempotencyKey", async () => {
    const { drive, linkb, calls } = makeRetryDrive((_c, n) => {
      if (n === 1) throw new Error("gateway connection lost");
      return { status: "started" };
    });
    await linkb.deliver(tui("prompt.submit", "01SID", { text: "別石沉" }));
    expect(drive.retryTask).toBeTruthy(); // 已排重投
    await drive.retryTask;
    expect(calls.map((c) => c.method)).toEqual(["chat.send", "chat.send"]);
    expect(calls[1].params.message).toBe("別石沉");
    expect(calls[1].params.idempotencyKey).toBe(calls[0].params.idempotencyKey); // OpenClaw 側冪等去重
  });

  it("去重:重投路徑再死 → 同 (sid,文本) 不再二投,寧丟勿雙發", async () => {
    const { drive, linkb, calls } = makeRetryDrive(() => {
      throw new Error("gateway connection lost"); // 永遠死
    });
    await linkb.deliver(tui("prompt.submit", "01SID", { text: "hi" }));
    await drive.retryTask; // 第一次重投:失敗、記賬
    await linkb.deliver(tui("prompt.submit", "01SID", { text: "hi" }));
    await drive.retryTask; // 第二次:賬上有 → 直接放棄
    expect(calls.filter((c) => c.method === "chat.send").length).toBe(3); // 首發×2 + 重投×1
  });

  it("業務錯誤不重投(只重投連接死亡類)", async () => {
    const { drive, linkb, calls } = makeRetryDrive(() => {
      throw new Error('gateway error: {"code":"BAD_REQUEST"}');
    });
    await linkb.deliver(tui("prompt.submit", "01SID", { text: "hi" }));
    expect(drive.retryTask).toBeNull();
    expect(calls.length).toBe(1); // 僅首發,無重投
  });

  it("#5 重投等待期用戶中斷 → 重投被取消,不復活", async () => {
    let connected = false;
    const { drive, linkb, calls } = (() => {
      const r = makeRetryDrive(() => {
        throw new Error("gateway connection lost");
      });
      Object.defineProperty((r.drive as any).gw, "isConnected", { get: () => connected });
      return r;
    })();
    await linkb.deliver(tui("prompt.submit", "01SID", { text: "hi" })); // 首發死 → 排重投(等重連)
    await linkb.deliver(tui("session.interrupt", "01SID")); // 用戶中斷(abort 也會失敗,無妨)
    connected = true; // 隨後 gateway 重連
    await drive.retryTask;
    // 首發 chat.send ×1 + interrupt 的 sessions.abort ×1;重投**沒有**發生
    expect(calls.filter((c) => c.method === "chat.send").length).toBe(1);
  });
});
