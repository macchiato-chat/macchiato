import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Drive } from "../src/openclaw/drive";

/**
 * #202 對賬測試:driven key 的投遞是 live 獨佔(鏡像跳過),live 漏收 gateway 廣播(WS 重連窗/
 * 進程死於回合中途)= 該段自主/在途輸出靜默丟。對賬 = 回合末回填 srcId + 重連/啟動時按
 * chat.history 的穩定 id+seq 水位線補投。
 */

const SID = "01TESTSID00000000000000000";
const KEY = `agent:main:macchiato:${SID}`.toLowerCase();

/** history 行構造器。 */
const row = (seq: number, role: string, text: string) => ({
  role,
  content: text,
  timestamp: 1700000000000 + seq,
  __openclaw: { id: `id-${seq}`, seq, mirrorIdentity: "x", recordTimestampMs: 1700000000000 + seq },
});

function makeDrive(history: () => any[]) {
  process.env.MACCHIATO_OPENCLAW_TITLED = join(mkdtempSync(join(tmpdir(), "oc-t-")), "titled.json");
  process.env.MACCHIATO_OPENCLAW_TITLE_MODE = "off";
  process.env.MACCHIATO_OPENCLAW_DRIVE = join(mkdtempSync(join(tmpdir(), "oc-d-")), "drive.json");
  const calls: { method: string; params: any }[] = [];
  const connectedHandlers: Array<() => void> = [];
  const gw: any = {
    handlers: [] as any[],
    onEvent(h: any) {
      this.handlers.push(h);
      return () => {};
    },
    onConnected(h: () => void) {
      connectedHandlers.push(h);
      return () => {};
    },
    fireConnected() {
      for (const h of connectedHandlers) h();
    },
    async request(method: string, params: any) {
      calls.push({ method, params });
      if (method === "chat.history") return { sessionKey: params.sessionKey, messages: history() };
      return { status: "started", runId: "r1" };
    },
    fire(evt: any) {
      for (const h of [...this.handlers]) h(evt);
    },
  };
  const sent: any[] = [];
  const linkb: any = {
    agentLinkId: "al1",
    isReady: true,
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
  const mirror: any = { setDriven() {}, fastForward() {} };
  const drive = new Drive(gw, linkb, mirror);
  drive.wire();
  return { drive, gw, linkb, sent, calls };
}

const tui = (method: string, sessionId: string, params: any = {}) => ({
  t: "tui",
  sessionId,
  frame: { method, params: { session_id: sessionId, ...params } },
});

const srcidFrames = (sent: any[]) => sent.filter((f) => f.t === "message_srcid");
const mirrorFrames = (sent: any[]) => sent.filter((f) => f.t === "mirror_append");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("#202 對賬", () => {
  it("回合末:chat.history 的最新 user/assistant id 回填 message_srcid + 推水位線(冪等)", async () => {
    const hist = [row(1, "user", "問題"), row(2, "assistant", "回答")];
    const { drive, gw, linkb, sent } = makeDrive(() => hist);
    await linkb.deliver(tui("prompt.submit", SID, { text: "問題" }));
    // 回合:lifecycle start → chat final → lifecycle end(觸發 reconcileTurnEnd)
    gw.fire({ event: "agent", payload: { sessionKey: KEY, stream: "lifecycle", runId: "r1", data: { phase: "start" } } });
    gw.fire({ event: "chat", payload: { sessionKey: KEY, state: "final", message: { role: "assistant", content: "回答" }, runId: "r1" } });
    gw.fire({ event: "agent", payload: { sessionKey: KEY, stream: "lifecycle", runId: "r1", data: { phase: "end" } } });
    await sleep(20);
    const sf = srcidFrames(sent);
    expect(sf).toHaveLength(1);
    expect(sf[0].sessionId).toBe(SID);
    expect(sf[0].items).toEqual([
      { role: "user", srcId: "id-1" },
      { role: "agent", srcId: "id-2" },
    ]);
    // 水位線已推到 2:再跑一輪回合末(歷史沒新行)→ 不再回填
    gw.fire({ event: "agent", payload: { sessionKey: KEY, stream: "lifecycle", runId: "r2", data: { phase: "start" } } });
    gw.fire({ event: "agent", payload: { sessionKey: KEY, stream: "lifecycle", runId: "r2", data: { phase: "end" } } });
    await sleep(20);
    expect(srcidFrames(sent)).toHaveLength(1);
  });

  it("重連對賬:live 漏投的行(seq>水位線)→ mirror_append 補投(帶 srcId);再對賬不重發", async () => {
    let hist: any[] = [row(1, "user", "問題"), row(2, "assistant", "回答")];
    const { gw, linkb, sent } = makeDrive(() => hist);
    await linkb.deliver(tui("prompt.submit", SID, { text: "問題" }));
    // 完整回合把水位線推到 2
    gw.fire({ event: "agent", payload: { sessionKey: KEY, stream: "lifecycle", runId: "r1", data: { phase: "start" } } });
    gw.fire({ event: "agent", payload: { sessionKey: KEY, stream: "lifecycle", runId: "r1", data: { phase: "end" } } });
    await sleep(20);
    // 斷連窗:agent 自主續寫兩行落庫,但 live 廣播漏收(什麼都沒 fire)
    hist = [...hist, row(3, "assistant", "自主續寫一"), row(4, "assistant", "自主續寫二")];
    gw.fireConnected(); // 重連 → 對賬
    await sleep(20);
    const mf = mirrorFrames(sent);
    expect(mf).toHaveLength(1);
    expect(mf[0].sessions[0].hermesSessionId).toBe(SID);
    expect(mf[0].sessions[0].messages).toEqual([
      { role: "agent", text: "自主續寫一", srcId: "id-3" },
      { role: "agent", text: "自主續寫二", srcId: "id-4" },
    ]);
    // 冪等:水位線已到 4,再重連不重發
    gw.fireConnected();
    await sleep(20);
    expect(mirrorFrames(sent)).toHaveLength(1);
  });

  it("啟動對賬(#200 同源):上個進程死於回合中途 → 新進程 reconcileAll 補投漏的 final", async () => {
    let hist: any[] = [row(1, "user", "問題")];
    const { gw, linkb, sent } = makeDrive(() => hist);
    await linkb.deliver(tui("prompt.submit", SID, { text: "問題" }));
    gw.fire({ event: "agent", payload: { sessionKey: KEY, stream: "lifecycle", runId: "r1", data: { phase: "start" } } });
    gw.fire({ event: "agent", payload: { sessionKey: KEY, stream: "lifecycle", runId: "r1", data: { phase: "end" } } });
    await sleep(20); // 水位線 = 1(只有 user 行)
    // 「進程死了」:同一狀態文件起新 Drive;死機期間 assistant 行落了庫
    hist = [...hist, row(2, "assistant", "遲到的回答")];
    const sent2: any[] = [];
    const linkb2: any = { agentLinkId: "al1", isReady: true, onFrame() {}, send: (m: any) => sent2.push(m) };
    const gw2: any = {
      onEvent: () => () => {},
      onConnected: () => () => {},
      request: async (method: string, params: any) =>
        method === "chat.history" ? { messages: hist } : { status: "ok" },
    };
    const drive2 = new Drive(gw2, linkb2, { setDriven() {}, fastForward() {} } as any);
    drive2.wire();
    await drive2.reconcileAll("startup");
    const mf = mirrorFrames(sent2);
    expect(mf).toHaveLength(1);
    expect(mf[0].sessions[0].messages).toEqual([{ role: "agent", text: "遲到的回答", srcId: "id-2" }]);
  });

  it("#244 渠道側 user 行:回合末補投進 Macchiato;srcId 只回填我們發的行", async () => {
    // 回合內:我們發「問題」,渠道(discord)用戶亂入「渠道插話」,agent 回覆
    const hist = [row(1, "user", "問題"), row(2, "user", "渠道插話"), row(3, "assistant", "回答")];
    const { gw, linkb, sent } = makeDrive(() => hist);
    await linkb.deliver(tui("prompt.submit", SID, { text: "問題" }));
    gw.fire({ event: "agent", payload: { sessionKey: KEY, stream: "lifecycle", runId: "r1", data: { phase: "start" } } });
    gw.fire({ event: "agent", payload: { sessionKey: KEY, stream: "lifecycle", runId: "r1", data: { phase: "end" } } });
    await sleep(20);
    const sf = srcidFrames(sent);
    expect(sf).toHaveLength(1);
    // 舊實現:lastUser=渠道行 → id-2 誤掛到 Macchiato 消息;新實現:文本匹配 → id-1
    expect(sf[0].items).toEqual([
      { role: "user", srcId: "id-1" },
      { role: "agent", srcId: "id-3" },
    ]);
    // 渠道 user 行補投(舊實現:水位線推過即永久丟)
    const mf = mirrorFrames(sent);
    expect(mf).toHaveLength(1);
    expect(mf[0].sessions[0].messages).toEqual([{ role: "user", text: "渠道插話", srcId: "id-2" }]);
  });

  it("#244 全部未匹配(OpenClaw 改寫文本)→ 回退舊語義:最後 user 行回填、不補投", async () => {
    const hist = [row(1, "user", "被改寫過的問題"), row(2, "assistant", "回答")];
    const { gw, linkb, sent } = makeDrive(() => hist);
    await linkb.deliver(tui("prompt.submit", SID, { text: "問題" }));
    gw.fire({ event: "agent", payload: { sessionKey: KEY, stream: "lifecycle", runId: "r1", data: { phase: "start" } } });
    gw.fire({ event: "agent", payload: { sessionKey: KEY, stream: "lifecycle", runId: "r1", data: { phase: "end" } } });
    await sleep(20);
    expect(srcidFrames(sent)[0].items).toEqual([
      { role: "user", srcId: "id-1" }, // 寧按舊語義回填
      { role: "agent", srcId: "id-2" },
    ]);
    expect(mirrorFrames(sent)).toHaveLength(0); // 寧漏勿雙投
  });

  it("#244 渠道接管(agent: key):水位線初值=檔末,重啟對賬不把接管前歷史再投一遍", async () => {
    const CH_SID = "agent:main:discord:channel:99";
    const CH_KEY = CH_SID.toLowerCase();
    // 接管前頻道已有歷史(已由鏡像以內容指紋 srcId 入庫)
    const hist = [row(1, "user", "老消息"), row(2, "assistant", "老回覆")];
    const { drive, linkb, sent, calls } = makeDrive(() => hist);
    await linkb.deliver(tui("prompt.submit", CH_SID, { text: "接管第一問" }));
    await sleep(20);
    // markDriven 已拉 chat.history 把 wm 推到 2 → 立刻對賬不會補投老歷史
    const n = await (drive as any).reconcileKey(CH_KEY, CH_SID);
    expect(n).toBe(0);
    expect(mirrorFrames(sent)).toHaveLength(0);
    expect(calls.some((c) => c.method === "chat.history")).toBe(true);
  });

  it("Link B 未 ready → 對賬整體跳過、水位線不動(mirror_append 不入斷線緩衝,發了即丟)", async () => {
    let hist: any[] = [row(1, "user", "q"), row(2, "assistant", "a")];
    const { drive, gw, linkb, sent } = makeDrive(() => hist);
    await linkb.deliver(tui("prompt.submit", SID, { text: "q" }));
    linkb.isReady = false;
    gw.fireConnected();
    await sleep(20);
    expect(mirrorFrames(sent)).toHaveLength(0); // 沒 ready:不發
    linkb.isReady = true;
    gw.fireConnected(); // ready 後補上(水位線沒被推過 → 行還在)
    await sleep(20);
    const mf = mirrorFrames(sent);
    expect(mf).toHaveLength(1);
    expect(mf[0].sessions[0].messages.map((m: any) => m.srcId)).toEqual(["id-1", "id-2"]);
  });
});
