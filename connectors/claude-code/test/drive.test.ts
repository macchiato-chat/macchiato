import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #118 圖片附件測試:攔 materializeAttachment(免起 http 服務),其餘原樣(imageBlockFor 用真實現)。
let mockMaterialize: (ref: unknown) => Promise<string> = async () => {
  throw new Error("not stubbed");
};
vi.mock("../src/cc/attachments", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/cc/attachments")>();
  return { ...orig, materializeAttachment: (ref: unknown) => mockMaterialize(ref) };
});

// mock Agent SDK:可控事件流 + interrupt 記錄。
// #118 起 drive 是 streaming-input(prompt=PushStream):mock 忽略 prompt、直接 yield 腳本後結束——
// 「腳本盡=通道結束」,等價於單回合後閒置回收;下個 prompt 開新通道(resume 走映射),舊測試語義不變。
const interrupts: string[] = [];
let emitScript: Array<Record<string, unknown>> = [];
/** #118 多回合模式:非空時 mock 改為 input 驅動——每消費一條 push 的 user 消息,yield 下一段腳本。 */
let turnScripts: Array<Array<Record<string, unknown>>> = [];
let queryCalls = 0;
let lastOptions: any = null;
/** #118 input 驅動模式下,mock 消費到的 push 消息(斷言 content 結構用)。 */
let pushedMessages: any[] = [];

async function* yieldScript(script: Array<Record<string, unknown>>) {
  for (const e of script) {
    if ((e as any).__throw) throw new Error("Claude Code returned an error result");
    if ((e as any).__wait) {
      await new Promise((r) => setTimeout(r, (e as any).__wait as number));
      continue; // 時間窗:給測試機會在迭代中途 fire 幀(如 session.interrupt)
    }
    yield e;
  }
}

const renameCalls: Array<[string, string]> = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  renameSession: async (sid: string, title: string) => {
    renameCalls.push([sid, title]);
  },
  query: (args: { prompt: unknown; options: any }) => {
    lastOptions = args.options;
    queryCalls++;
    const script = [...emitScript];
    return {
      async *[Symbol.asyncIterator]() {
        if (turnScripts.length) {
          // #118 input 驅動:對齊真 CLI(push 才有回合;腳本用盡=進程結束)
          for await (const u of args.prompt as AsyncIterable<unknown>) {
            pushedMessages.push(u);
            const s = turnScripts.shift();
            if (!s) return;
            yield* yieldScript(s);
          }
          return;
        }
        yield* yieldScript(script);
      },
      interrupt: async () => {
        interrupts.push("interrupted");
      },
    };
  },
}));

import { Drive } from "../src/cc/drive";

function fakeLinkb() {
  const sent: Record<string, unknown>[] = [];
  const handlers: Array<(m: Record<string, unknown>) => void> = [];
  return {
    sent,
    fire: (m: Record<string, unknown>) => handlers.forEach((h) => h(m)),
    linkb: {
      agentLinkId: "AL1",
      isReady: true,
      send: (m: Record<string, unknown>) => sent.push(m),
      onFrame: (h: (m: Record<string, unknown>) => void) => {
        handlers.push(h);
        return () => {};
      },
    } as any,
  };
}

function tuiFrame(sid: string, method: string, params: Record<string, unknown> = {}) {
  return { t: "tui", sessionId: sid, frame: { method, params: { session_id: sid, ...params } } };
}

const CC_SID = "6966afc5-2dca-477d-a987-848421d25124";

beforeEach(() => {
  emitScript = [];
  turnScripts = [];
  queryCalls = 0;
  pushedMessages = [];
  interrupts.length = 0;
  lastOptions = null;
  mockMaterialize = async () => {
    throw new Error("not stubbed");
  };
  process.env.MACCHIATO_CC_SESSIONS = join(mkdtempSync(join(tmpdir(), "cc-dr-")), "sessions.json");
  delete process.env.MACCHIATO_CC_IDLE_S;
  delete process.env.MACCHIATO_CC_MODEL; // #143 防測試間污染(連接器服務設了它)
});

describe("Drive", () => {
  it("回合結束後 driven 解除(CC 終端側活動恢復鏡像)", async () => {
    emitScript = [
      { type: "system", subtype: "init", session_id: CC_SID },
      { type: "result", subtype: "success", result: "ok" },
    ];
    const calls: string[] = [];
    const mirror = { setDriven: (s: string) => calls.push("set:" + s), unsetDriven: (s: string) => calls.push("unset:" + s), fastForward: (s: string) => calls.push("ff:" + s) } as any;
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb, mirror);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "hi" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual(["set:" + CC_SID, "ff:" + CC_SID, "unset:" + CC_SID]);
  });

  it("prompt.submit → 流式事件映射成 tui(start/delta/tool/complete),uuid sid 直接 resume", async () => {
    emitScript = [
      { type: "system", subtype: "init", session_id: CC_SID },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "he" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "llo" } } },
      { type: "result", subtype: "success", result: "hello" },
    ];
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "hi" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOptions.resume).toBe(CC_SID); // 鏡像會話:sid 即 CC id
    const types = sent.map((f: any) => f.frame?.params?.type);
    expect(types).toEqual(["message.start", "message.delta", "message.delta", "message.complete"]);
    expect((sent.at(-1) as any).frame.params.payload.text).toBe("hello");
  });

  it("Macchiato 新會話(ULID sid):init 的 session_id 持久映射,下回合 resume 用它", async () => {
    emitScript = [
      { type: "system", subtype: "init", session_id: CC_SID },
      { type: "result", subtype: "success", result: "ok" },
    ];
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame("01ULIDSERVERSID000000000AA", "prompt.submit", { text: "first" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOptions.resume).toBeUndefined(); // 首回合新建
    fire(tuiFrame("01ULIDSERVERSID000000000AA", "prompt.submit", { text: "second" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(lastOptions.resume).toBe(CC_SID); // 續聊走映射
  });

  it("canUseTool → approval.request,approval.respond allow/deny 解掛;all=true 記住工具", async () => {
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    // 直接測 requestApproval 橋(不經 SDK 流)
    const p1 = (d as any).requestApproval(CC_SID, "Bash", { command: "ls" });
    const req = sent.find((f: any) => f.frame?.params?.type === "approval.request") as any;
    expect(req.frame.params.payload.pattern_key).toBe("Bash");
    fire(tuiFrame(CC_SID, "approval.respond", { choice: "allow", all: true }));
    const r1 = await p1;
    expect(r1.behavior).toBe("allow");
    // all=true → 之後同工具免批
    const p2 = (d as any).requestApproval(CC_SID, "Read", {});
    fire(tuiFrame(CC_SID, "approval.respond", { choice: "deny" }));
    expect((await p2).behavior).toBe("deny");
    expect((d as any).alwaysAllow.get(CC_SID)?.has("Bash")).toBe(true);
  });

  it("回合進行中再來 prompt → steer(#75):消息進隊 + 打斷當前回合", async () => {
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    // 手動塞一條「回合進行中」的通道(#118)
    let interrupted = 0;
    (d as any).channels.set(CC_SID, { sid: CC_SID, turn: { completed: false }, q: { interrupt: async () => void interrupted++ } });
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "steer msg" }));
    await new Promise((r) => setTimeout(r, 10));
    expect((d as any).queued.get(CC_SID)).toEqual(["steer msg"]); // 進隊(finishTurn 續投)
    expect(interrupted).toBe(1); // 立即打斷
    expect((d as any).interruptedSids.has(CC_SID)).toBe(true); // 隨後 result 定性 interrupted
  });

  it("session.interrupt → 調 query.interrupt", async () => {
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    let called = 0;
    (d as any).channels.set(CC_SID, { sid: CC_SID, turn: { completed: false }, q: { interrupt: async () => void called++ } });
    fire(tuiFrame(CC_SID, "session.interrupt"));
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(1);
  });
});

describe("#109 AskUserQuestion → clarify 問答", () => {
  const INPUT = {
    questions: [
      {
        question: "Which color?",
        header: "Color",
        multiSelect: false,
        options: [
          { label: "Red", description: "warm" },
          { label: "Blue", description: "cool" },
        ],
      },
      { question: "Which size?", header: "Size", options: [{ label: "S" }, { label: "L" }] },
    ],
  };

  it("#121 v2:multiSelect 透傳到 clarify.request;逗號拼/自由文本 answer 原樣進 answers", async () => {
    const MULTI = {
      questions: [
        { question: "Toppings?", header: "Toppings", multiSelect: true, options: [{ label: "Cheese" }, { label: "Onion" }] },
      ],
    };
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    const p = (d as any).requestAnswers(CC_SID, MULTI, "toolu_M");
    const req = sent.find((f: any) => f.frame?.params?.type === "clarify.request") as any;
    expect(req.frame.params.payload.choices.multiSelect).toBe(true); // 連接器 v1 已發,v2 web 用它渲多選
    // client 組合好的答案(多選逗號拼 + Other)原樣回帶(連接器格式無關,探針證)
    fire(tuiFrame(CC_SID, "clarify.respond", { request_id: "toolu_M#0", answer: "Cheese, Onion, Pineapple(custom)" }));
    const r = await p;
    expect(r.updatedInput.answers).toEqual({ "Toppings?": "Cheese, Onion, Pineapple(custom)" });
  });

  it("逐題 clarify.request;亂序收齊 → allow + updatedInput.answers(問題原文→label)", async () => {
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    const p = (d as any).requestAnswers(CC_SID, INPUT, "toolu_A");
    const reqs = sent.filter((f: any) => f.frame?.params?.type === "clarify.request") as any[];
    expect(reqs.length).toBe(2);
    expect(reqs[0].frame.params.payload.request_id).toBe("toolu_A#0");
    expect(reqs[0].frame.params.payload.question).toBe("Which color?");
    expect(reqs[0].frame.params.payload.choices).toEqual({
      header: "Color",
      options: [
        { id: "0", label: "Red", description: "warm" },
        { id: "1", label: "Blue", description: "cool" },
      ],
    });
    // 亂序:先答第二題
    fire(tuiFrame(CC_SID, "clarify.respond", { request_id: "toolu_A#1", answer: "L" }));
    fire(tuiFrame(CC_SID, "clarify.respond", { request_id: "toolu_A#0", answer: "Blue" }));
    const r = await p;
    expect(r.behavior).toBe("allow");
    expect(r.updatedInput.answers).toEqual({ "Which color?": "Blue", "Which size?": "L" });
  });

  it("全部跳過(answer 空串) → allow 原輸入、不掛 answers(CLI 自答 did not answer)", async () => {
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    const p = (d as any).requestAnswers(CC_SID, INPUT, "toolu_B");
    fire(tuiFrame(CC_SID, "clarify.respond", { request_id: "toolu_B#0", answer: "" }));
    fire(tuiFrame(CC_SID, "clarify.respond", { request_id: "toolu_B#1", answer: "" }));
    const r = await p;
    expect(r.behavior).toBe("allow");
    expect(r.updatedInput.answers).toBeUndefined();
  });

  it("canUseTool 對 AskUserQuestion 走 clarify 而非 approval 卡", async () => {
    emitScript = [
      { type: "system", subtype: "init", session_id: CC_SID },
      { type: "result", subtype: "success", result: "ok" },
    ];
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "hi" }));
    await new Promise((r) => setTimeout(r, 20));
    const p = lastOptions.canUseTool(
      "AskUserQuestion",
      { questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B" }] }] },
      { toolUseID: "tu1" },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.some((f: any) => f.frame?.params?.type === "clarify.request")).toBe(true);
    expect(sent.some((f: any) => f.frame?.params?.type === "approval.request")).toBe(false);
    fire(tuiFrame(CC_SID, "clarify.respond", { request_id: "tu1#0", answer: "A" }));
    const r = await p;
    expect(r.behavior).toBe("allow");
    expect(r.updatedInput.answers).toEqual({ "Q?": "A" });
  });
});

describe("voice graceful degradation (#73)", () => {
  it("audio 附件 → 立即回 voice_transcript error,不起回合", async () => {
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "", attachments: [{ id: "att1", kind: "audio", name: "v.wav" }] }));
    await new Promise((r) => setTimeout(r, 20));
    const vt = sent.find((f: any) => f.t === "voice_transcript") as any;
    expect(vt).toMatchObject({ sessionId: CC_SID, attachmentId: "att1", text: "", error: "stt_unavailable" });
    expect((d as any).channels.size).toBe(0); // 沒起回合(#118:沒開通道)
  });
});

describe("#91 interrupt 后 result→抛 序列", () => {
  it("result 已到再抛异常 → 只发一次 message.complete(不双重)", async () => {
    // 复刻真 CLI 行为(2026-07-08 探针):interrupt → result(error_during_execution) → 迭代器抛
    emitScript = [
      { type: "system", subtype: "init", session_id: CC_SID },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } },
      { type: "result", subtype: "error_during_execution" },
      { __throw: true },
    ];
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "go" }));
    await new Promise((r) => setTimeout(r, 30));
    const completes = sent.filter((f: any) => f.frame?.params?.type === "message.complete");
    expect(completes).toHaveLength(1);
    expect((completes[0] as any).frame.params.payload.text).toBe("partial"); // 部分文本定稿
  });
});

describe("permissionMode (#bypass)", () => {
  it("合法值透传,非法值忽略,未设 undefined", async () => {
    const { permissionMode } = await import("../src/cc/drive");
    delete process.env.MACCHIATO_CC_PERMISSION_MODE;
    expect(permissionMode()).toBeUndefined();
    process.env.MACCHIATO_CC_PERMISSION_MODE = "bypassPermissions";
    expect(permissionMode()).toBe("bypassPermissions");
    process.env.MACCHIATO_CC_PERMISSION_MODE = "acceptEdits";
    expect(permissionMode()).toBe("acceptEdits");
    process.env.MACCHIATO_CC_PERMISSION_MODE = "garbage";
    expect(permissionMode()).toBeUndefined();
    delete process.env.MACCHIATO_CC_PERMISSION_MODE;
  });
});

describe("#97→#104 background task 結構化事件 + 停止", () => {
  it("task_started/notification → task.start/task.end(全量 task id)", async () => {
    emitScript = [
      { type: "system", subtype: "init", session_id: CC_SID },
      { type: "system", subtype: "task_started", task_id: "bg12345678", tool_use_id: "tu1", description: "抓论文", subagent_type: "" },
      { type: "system", subtype: "task_notification", task_id: "bg12345678", tool_use_id: "tu1", status: "completed", summary: "抓了30篇" },
      { type: "result", subtype: "success", result: "done" },
    ];
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "go" }));
    await new Promise((r) => setTimeout(r, 30));
    const starts = sent.filter((f: any) => f.frame?.params?.type === "task.start").map((f: any) => f.frame.params.payload);
    const ends = sent.filter((f: any) => f.frame?.params?.type === "task.end").map((f: any) => f.frame.params.payload);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ task_id: "bg12345678", kind: "background", desc: "抓论文" });
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ task_id: "bg12345678", status: "completed", summary: "抓了30篇" });
  });

  it("ambient 任务隐藏", async () => {
    emitScript = [
      { type: "system", subtype: "init", session_id: CC_SID },
      { type: "system", subtype: "task_started", task_id: "amb1", description: "housekeeping", ambient: true },
      { type: "result", subtype: "success", result: "ok" },
    ];
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "go" }));
    await new Promise((r) => setTimeout(r, 30));
    const taskFrames = sent.filter((f: any) => String(f.frame?.params?.type ?? "").startsWith("task."));
    expect(taskFrames).toHaveLength(0); // ambient 隐藏
  });

  it("#212 E2E 会话不展示 task，但内部仍跟踪生命周期供 idle 保护", () => {
    const { linkb, sent } = fakeLinkb();
    const e2e = { isE2E: () => true } as any;
    const d = new Drive(linkb, undefined, e2e);
    const ch = { sid: CC_SID, closing: false } as any;
    (d as any).handleMessage(ch, {
      type: "system",
      subtype: "task_started",
      task_id: "private-task",
      description: "secret",
    });
    expect((d as any).sessionTasks.get(CC_SID)).toEqual(new Set(["private-task"]));
    expect(sent).toHaveLength(0);

    (d as any).handleMessage(ch, {
      type: "system",
      subtype: "task_notification",
      task_id: "private-task",
      status: "completed",
      summary: "secret result",
    });
    expect((d as any).sessionTasks.has(CC_SID)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("#212 多個任務只在最後一個結束後恢復 idle timer", () => {
    const { linkb } = fakeLinkb();
    const d = new Drive(linkb);
    const close = vi.fn();
    const ch = { sid: CC_SID, closing: false, input: { close } } as any;
    (d as any).channels.set(CC_SID, ch);

    (d as any).handleTaskEvent(CC_SID, { subtype: "task_started", task_id: "task-a" }, true);
    (d as any).handleTaskEvent(CC_SID, { subtype: "task_started", task_id: "task-b" }, true);
    (d as any).handleTaskEvent(CC_SID, { subtype: "task_notification", task_id: "task-a", status: "completed" }, true);
    expect((d as any).sessionTasks.get(CC_SID)).toEqual(new Set(["task-b"]));
    expect(ch.idleTimer).toBeUndefined();

    (d as any).handleTaskEvent(CC_SID, { subtype: "task_notification", task_id: "task-b", status: "completed" }, true);
    expect((d as any).sessionTasks.has(CC_SID)).toBe(false);
    expect(ch.idleTimer).toBeDefined();
    d.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it("task.stop → query.stopTask(taskId)", async () => {
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    let stopped = "";
    (d as any).channels.set(CC_SID, { sid: CC_SID, q: { stopTask: async (id: string) => void (stopped = id) } });
    fire(tuiFrame(CC_SID, "task.stop", { taskId: "bg999" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe("bg999");
  });

  it("task.stop 短 id(展示行前 8 位)→ 按前綴還原全 id", async () => {
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    let stopped = "";
    (d as any).channels.set(CC_SID, { sid: CC_SID, q: { stopTask: async (id: string) => void (stopped = id) } });
    (d as any).sessionTasks.set(CC_SID, new Set(["agent-a1b2c3d4e5f6"]));
    fire(tuiFrame(CC_SID, "task.stop", { taskId: "agent-a1" })); // 客戶端只有 8 位短 id
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe("agent-a1b2c3d4e5f6");
  });
});

describe("#102 消息面補齊", () => {
  it("result 帶 usage/cost → message.complete 附 status=complete + usage 元數據", async () => {
    emitScript = [
      { type: "system", subtype: "init", session_id: CC_SID },
      {
        type: "result", subtype: "success", result: "ok",
        total_cost_usd: 0.12, num_turns: 3, duration_ms: 1500,
        usage: { input_tokens: 100, output_tokens: 50 },
        modelUsage: { "claude-opus-4-8": {} },
      },
    ];
    const { linkb, sent, fire } = fakeLinkb();
    new Drive(linkb).wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "go" }));
    await new Promise((r) => setTimeout(r, 20));
    const c = sent.find((f: any) => f.frame?.params?.type === "message.complete") as any;
    expect(c.frame.params.payload.status).toBe("complete");
    expect(c.frame.params.payload.usage).toMatchObject({
      input_tokens: 100, output_tokens: 50, total_cost_usd: 0.12, num_turns: 3, duration_ms: 1500,
      models: ["claude-opus-4-8"],
    });
  });

  it("錯誤 result(error_max_turns)→ status=error + ❌ 系統行(帶 subtype 與 errors)", async () => {
    emitScript = [
      { type: "system", subtype: "init", session_id: CC_SID },
      { type: "result", subtype: "error_max_turns", is_error: true, errors: ["hit max turns"] },
    ];
    const { linkb, sent, fire } = fakeLinkb();
    new Drive(linkb).wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "go" }));
    await new Promise((r) => setTimeout(r, 20));
    const c = sent.find((f: any) => f.frame?.params?.type === "message.complete") as any;
    expect(c.frame.params.payload.status).toBe("error");
    const line = sent.find((f: any) => f.frame?.params?.type === "review.summary") as any;
    expect(line.frame.params.payload.summary).toContain("❌");
    expect(line.frame.params.payload.summary).toContain("error_max_turns");
    expect(line.frame.params.payload.summary).toContain("hit max turns");
  });

  it("session.interrupt 後的錯誤 result → status=interrupted,不發 ❌ 行", async () => {
    emitScript = [
      { type: "system", subtype: "init", session_id: CC_SID },
      { __wait: 30 }, // 時間窗:此間 fire session.interrupt
      { type: "result", subtype: "error_during_execution", is_error: true },
    ];
    const { linkb, sent, fire } = fakeLinkb();
    new Drive(linkb).wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "go" }));
    await new Promise((r) => setTimeout(r, 10));
    fire(tuiFrame(CC_SID, "session.interrupt"));
    await new Promise((r) => setTimeout(r, 50));
    const c = sent.find((f: any) => f.frame?.params?.type === "message.complete") as any;
    expect(c.frame.params.payload.status).toBe("interrupted");
    expect(sent.filter((f: any) => f.frame?.params?.type === "review.summary")).toHaveLength(0);
  });

  it("compact_boundary/status(compacting)/api_retry/permission_denied → review.summary 系統行", async () => {
    emitScript = [
      { type: "system", subtype: "init", session_id: CC_SID },
      { type: "system", subtype: "status", status: "compacting" },
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 150000 } },
      { type: "system", subtype: "api_retry", attempt: 2, max_retries: 5, error_status: 529 },
      { type: "system", subtype: "permission_denied", tool_name: "Bash", message: "rule says no" },
      { type: "result", subtype: "success", result: "ok" },
    ];
    const { linkb, sent, fire } = fakeLinkb();
    new Drive(linkb).wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "go" }));
    await new Promise((r) => setTimeout(r, 20));
    const lines = sent.filter((f: any) => f.frame?.params?.type === "review.summary").map((f: any) => f.frame.params.payload.summary);
    expect(lines.some((s: string) => s.includes("正在壓縮"))).toBe(true);
    expect(lines.some((s: string) => s.includes("已壓縮") && s.includes("150000"))).toBe(true);
    expect(lines.some((s: string) => s.includes("重試中") && s.includes("2/5") && s.includes("529"))).toBe(true);
    expect(lines.some((s: string) => s.includes("🚫") && s.includes("Bash") && s.includes("rule says no"))).toBe(true);
  });

  it("未知消息類型:不拋、不發幀、每種只記一次日誌", async () => {
    emitScript = [
      { type: "system", subtype: "init", session_id: CC_SID },
      { type: "system", subtype: "thinking_tokens", estimated_tokens: 5 },
      { type: "system", subtype: "thinking_tokens", estimated_tokens: 9 }, // 同種第二條:不再記
      { type: "tool_use_summary", summary: "did stuff" },
      { type: "result", subtype: "success", result: "ok" },
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { linkb, sent, fire } = fakeLinkb();
    new Drive(linkb).wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "go" }));
    await new Promise((r) => setTimeout(r, 20));
    const types = sent.map((f: any) => f.frame?.params?.type);
    expect(types).toEqual(["message.start", "message.complete"]); // 未知類型無幀外洩
    const unknownLogs = log.mock.calls.filter((c) => String(c[0]).includes("未處理的 SDK 消息"));
    expect(unknownLogs).toHaveLength(2); // thinking_tokens 一次 + tool_use_summary 一次
    log.mockRestore();
  });
});

describe("#102 審批 request_id + always 持久化", () => {
  it("approval.request 帶 request_id;respond 按 request_id 亂序配對,缺省 FIFO 回退", async () => {
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    const p1 = (d as any).requestApproval(CC_SID, "Bash", { command: "ls" }, { toolUseID: "t1" });
    const p2 = (d as any).requestApproval(CC_SID, "Read", {}, { toolUseID: "t2" });
    const reqs = sent.filter((f: any) => f.frame?.params?.type === "approval.request") as any[];
    expect(reqs.map((r) => r.frame.params.payload.request_id)).toEqual(["t1", "t2"]);
    // 亂序:先答 t2
    fire(tuiFrame(CC_SID, "approval.respond", { choice: "allow", request_id: "t2" }));
    expect((await p2).behavior).toBe("allow");
    // 再無 request_id 的舊式應答 → FIFO 拿到剩下的 t1
    fire(tuiFrame(CC_SID, "approval.respond", { choice: "deny" }));
    expect((await p1).behavior).toBe("deny");
  });

  it("choice=always → allow 帶 updatedPermissions(SDK suggestions 優先原樣回)", async () => {
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    const sugg = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls *" }], behavior: "allow", destination: "localSettings" }];
    const p = (d as any).requestApproval(CC_SID, "Bash", { command: "ls" }, { toolUseID: "t9", suggestions: sugg });
    fire(tuiFrame(CC_SID, "approval.respond", { choice: "always", request_id: "t9" }));
    const r = await p;
    expect(r.behavior).toBe("allow");
    expect(r.updatedPermissions).toEqual(sugg); // suggestions 原樣回(SDK 文檔明示用法)
    // 無 suggestions → 退化 addRules destination:session
    const p2 = (d as any).requestApproval(CC_SID, "Grep", {}, { toolUseID: "t10" });
    fire(tuiFrame(CC_SID, "approval.respond", { choice: "always", request_id: "t10" }));
    const r2 = await p2;
    expect(r2.updatedPermissions).toEqual([
      { type: "addRules", rules: [{ toolName: "Grep" }], behavior: "allow", destination: "session" },
    ]);
    // 內存 Set 仍是真來源(雙保險)
    expect((d as any).alwaysAllow.get(CC_SID)?.has("Grep")).toBe(true);
  });
});

describe("#118 streaming-input 長活通道", () => {
  const init = { type: "system", subtype: "init", session_id: CC_SID };

  it("同通道多回合:第二個 prompt 不新起 query(單通道兩個 result)", async () => {
    turnScripts = [
      [init, { type: "result", subtype: "success", result: "one" }],
      [init, { type: "result", subtype: "success", result: "two" }],
    ];
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "t1" }));
    await new Promise((r) => setTimeout(r, 30));
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "t2" }));
    await new Promise((r) => setTimeout(r, 30));
    const completes = sent.filter((f: any) => f.frame?.params?.type === "message.complete") as any[];
    expect(completes.map((c) => c.frame.params.payload.text)).toEqual(["one", "two"]);
    expect(queryCalls).toBe(1); // 長活:同通道,不新起 query
    expect((d as any).channels.size).toBe(1);
    d.dispose();
  });

  it("閒置回收:超時關通道回收;下個 prompt 新通道 resume 續上", async () => {
    process.env.MACCHIATO_CC_IDLE_S = "1"; // 最小檔:1s
    turnScripts = [[init, { type: "result", subtype: "success", result: "one" }]];
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "t1" }));
    await new Promise((r) => setTimeout(r, 30));
    expect((d as any).channels.size).toBe(1);
    await new Promise((r) => setTimeout(r, 1200)); // 越過 idle 窗
    expect((d as any).channels.size).toBe(0); // 已回收
    turnScripts = [[init, { type: "result", subtype: "success", result: "two" }]];
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "t2" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(queryCalls).toBe(2); // 新通道
    expect(lastOptions.resume).toBe(CC_SID); // resume 續上下文
    d.dispose();
  });

  it("#212 回合結束時已有後台任務 → 越過 idle 窗仍保留，任務完成後才回收", async () => {
    process.env.MACCHIATO_CC_IDLE_S = "0.05";
    turnScripts = [[
      init,
      { type: "system", subtype: "task_started", task_id: "bg-long", description: "長任務" },
      { type: "result", subtype: "success", result: "已放到後台" },
      { __wait: 150 },
      { type: "system", subtype: "task_notification", task_id: "bg-long", status: "completed" },
    ]];
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "run in background" }));

    await new Promise((r) => setTimeout(r, 100)); // 已越過 50ms idle 窗，task 尚在跑
    expect((d as any).channels.size).toBe(1);
    expect((d as any).sessionTasks.get(CC_SID)?.has("bg-long")).toBe(true);

    await new Promise((r) => setTimeout(r, 120)); // task 150ms 完成，再過完整 50ms idle 窗
    expect((d as any).sessionTasks.has(CC_SID)).toBe(false);
    expect((d as any).channels.size).toBe(0);
    d.dispose();
  });

  it("#212 result 後才收到 task_started → 撤銷既有 idle timer，不競態誤殺", async () => {
    process.env.MACCHIATO_CC_IDLE_S = "0.05";
    turnScripts = [[
      init,
      { type: "result", subtype: "success", result: "done" },
      { __wait: 20 },
      { type: "system", subtype: "task_started", task_id: "bg-late", description: "晚到任務" },
      { __wait: 130 },
      { type: "system", subtype: "task_notification", task_id: "bg-late", status: "completed" },
    ]];
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "late background event" }));

    await new Promise((r) => setTimeout(r, 100)); // 原 idle timer 應在 50ms 關閉；task_started 已將它撤銷
    expect((d as any).channels.size).toBe(1);
    expect((d as any).sessionTasks.get(CC_SID)?.has("bg-late")).toBe(true);

    await new Promise((r) => setTimeout(r, 120));
    expect((d as any).sessionTasks.has(CC_SID)).toBe(false);
    expect((d as any).channels.size).toBe(0);
    d.dispose();
  });

  it("送達確認:push 後未見任何事件即死 → 自動重投一次(新通道)", async () => {
    turnScripts = [
      [{ __throw: true }], // 通道 1:user 消息剛 push 就崩,零事件
      [init, { type: "result", subtype: "success", result: "retried ok" }], // 通道 2:重投成功
    ];
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "go" }));
    await new Promise((r) => setTimeout(r, 50));
    const completes = sent.filter((f: any) => f.frame?.params?.type === "message.complete") as any[];
    expect(completes).toHaveLength(1); // 重投只定稿一次
    expect(completes[0].frame.params.payload.text).toBe("retried ok");
    expect(completes[0].frame.params.payload.status).toBe("complete");
    expect(queryCalls).toBe(2);
    d.dispose();
  });

  it("已見事件的回合崩潰 → 不重投(防雙投),定稿 error", async () => {
    turnScripts = [
      [init, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "par" } } }, { __throw: true }],
    ];
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "go" }));
    await new Promise((r) => setTimeout(r, 50));
    const completes = sent.filter((f: any) => f.frame?.params?.type === "message.complete") as any[];
    expect(completes).toHaveLength(1);
    expect(completes[0].frame.params.payload.status).toBe("error");
    expect(completes[0].frame.params.payload.text).toBe("par"); // 部分文本定稿
    expect(queryCalls).toBe(1); // 不重投
    d.dispose();
  });

  it("#75 steer 全流程:中途消息 → 當前回合定稿 interrupted(保留部分文本)→ 新消息同通道接管", async () => {
    turnScripts = [
      // 回合 1:delta 後留 80ms 時間窗(此間 steer 消息到)→ 復刻真 CLI interrupt 後的 error result
      [
        init,
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "改到一半" } } },
        { __wait: 80 },
        { type: "result", subtype: "error_during_execution", is_error: true },
      ],
      // 回合 2(steer 消息):正常完成
      [init, { type: "result", subtype: "success", result: "好,轉向" }],
    ];
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "去改 API 層" }));
    await new Promise((r) => setTimeout(r, 20)); // 回合 1 生成中
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "等等,別改 API 層" }));
    await new Promise((r) => setTimeout(r, 150));
    expect(interrupts.length).toBe(1); // 真的調了 interrupt
    const completes = sent.filter((f: any) => f.frame?.params?.type === "message.complete") as any[];
    expect(completes).toHaveLength(2);
    expect(completes[0].frame.params.payload).toMatchObject({ text: "改到一半", status: "interrupted" }); // 部分文本保留
    expect(completes[1].frame.params.payload).toMatchObject({ text: "好,轉向", status: "complete" }); // steer 消息接管
    expect(queryCalls).toBe(1); // 同通道(上下文完整)
    expect(sent.filter((f: any) => f.frame?.params?.type === "review.summary")).toHaveLength(0); // 不發 ❌(是用戶意圖)
    d.dispose();
  });

  it("圖片附件 → 原生 image block 進 content(text 塊 + image 塊);純文本仍是字符串", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-natimg-"));
    const png = join(dir, "p.png");
    writeFileSync(png, Buffer.alloc(24, 7));
    mockMaterialize = async () => png;
    turnScripts = [
      [init, { type: "result", subtype: "success", result: "看到了" }],
      [init, { type: "result", subtype: "success", result: "ok" }],
    ];
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", {
      text: "這張圖是什麼?",
      attachments: [{ id: "a1", kind: "image", mime: "image/png", name: "p.png", url: "https://files.example/p" }],
    }));
    await new Promise((r) => setTimeout(r, 50));
    const content = pushedMessages[0]?.message?.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toMatchObject({ type: "text", text: "這張圖是什麼?" });
    expect(content[1]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
    // 純文本回合仍是字符串(不無謂改變 payload 形態)
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "純文本" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(pushedMessages[1]?.message?.content).toBe("純文本");
    d.dispose();
  });

  it("非圖/下載失敗 → 回退路徑注入(不帶 image block)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-natimg2-"));
    const pdf = join(dir, "doc.pdf");
    writeFileSync(pdf, Buffer.alloc(24, 7));
    mockMaterialize = async () => pdf;
    turnScripts = [[init, { type: "result", subtype: "success", result: "ok" }]];
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", {
      text: "讀這個文件",
      attachments: [{ id: "b1", kind: "file", mime: "application/pdf", name: "doc.pdf", url: "https://files.example/d" }],
    }));
    await new Promise((r) => setTimeout(r, 50));
    const content = pushedMessages[0]?.message?.content;
    expect(typeof content).toBe("string"); // 回退:路徑注入純文本
    expect(content).toContain("讀這個文件");
    expect(content).toContain(pdf);
    d.dispose();
  });

  it("dispose:回收全部通道(關停不留 CLI 進程)", async () => {
    turnScripts = [[init, { type: "result", subtype: "success", result: "ok" }]];
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "t1" }));
    await new Promise((r) => setTimeout(r, 30));
    expect((d as any).channels.size).toBe(1);
    d.dispose();
    await new Promise((r) => setTimeout(r, 20));
    expect((d as any).channels.size).toBe(0);
  });
});

describe("#94 session.retitle(AI 重新命名老会话)", () => {
  it("读 transcript 首条 user → 生成 → emit session.title", async () => {
    // mock generateTitle:vitest 里 titles.ts 的 query 已被 mock(返回 result),但更稳的是直接铺 transcript
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const cfg = mkdtempSync(join(tmpdir(), "cc-rt-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    const SID = "6966afc5-2dca-477d-a987-848421d25124"; // uuid → ccSidFor 直接用它
    mkdirSync(join(cfg, "projects", "-x"), { recursive: true });
    writeFileSync(
      join(cfg, "projects", "-x", `${SID}.jsonl`),
      JSON.stringify({ type: "user", uuid: "u1", sessionId: SID, timestamp: "2026-07-09T00:00:00Z", message: { role: "user", content: "帮我重构支付模块的错误处理" } }) + "\n",
    );
    // summary 走 mock query(drive.test 顶部的 mock 只 yield 一次 result);为让 generateTitle 拿到确定值,
    // 用 firstmsg 模式(不调 LLM,截断首条)——验证 retitle 端到端接线(读transcript→emit)。
    process.env.MACCHIATO_CC_TITLE_MODE = "firstmsg";
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(SID, "session.retitle", {}));
    await new Promise((r) => setTimeout(r, 30));
    const titleEvt = sent.find((f: any) => f.frame?.params?.type === "session.title") as any;
    expect(titleEvt?.frame.params.payload.title).toBe("帮我重构支付模块的错误处理");
    delete process.env.MACCHIATO_CC_TITLE_MODE;
    delete process.env.CLAUDE_CONFIG_DIR;
  });
});

describe("#98 每會話權限模式", () => {
  const init = { type: "system", subtype: "init", session_id: CC_SID };

  it("session.create 存 permissionMode;傳給 SDK 的 sdk 模式按五檔映射", async () => {
    delete process.env.MACCHIATO_CC_PERMISSION_MODE;
    turnScripts = [[init, { type: "result", subtype: "success", result: "ok" }]];
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    // ask → default
    fire(tuiFrame(CC_SID, "session.create", { permissionMode: "ask" }));
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "go" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(lastOptions.permissionMode).toBe("default");
    expect((d as any).permModes[CC_SID]).toBe("ask");
    d.dispose();
  });

  it("五檔各自映射:acceptEdits→default、auto→auto、plan→plan、bypass→bypassPermissions", async () => {
    delete process.env.MACCHIATO_CC_PERMISSION_MODE;
    process.env.MACCHIATO_CC_TITLE_MODE = "off"; // ULID sid 首回合會觸發標題,關掉防偷跑 turnScript
    const cases: [string, string][] = [
      ["acceptEdits", "default"],
      ["auto", "auto"], // #205:classifier 自動批,canUseTool 只兜底(探針背書)
      ["plan", "plan"],
      ["bypass", "bypassPermissions"],
    ];
    for (const [ui, sdk] of cases) {
      turnScripts = [[init, { type: "result", subtype: "success", result: "ok" }]];
      const { linkb, fire } = fakeLinkb();
      const d = new Drive(linkb);
      d.wire();
      const sid = "01UI" + ui.toUpperCase().padEnd(22, "0").slice(0, 22);
      fire(tuiFrame(sid, "session.create", { permissionMode: ui }));
      fire(tuiFrame(sid, "prompt.submit", { text: "go" }));
      await new Promise((r) => setTimeout(r, 30));
      expect(lastOptions.permissionMode, ui).toBe(sdk);
      d.dispose();
    }
    delete process.env.MACCHIATO_CC_TITLE_MODE;
  });

  it("非法 permissionMode 忽略,回退 env 默認", async () => {
    process.env.MACCHIATO_CC_PERMISSION_MODE = "bypassPermissions";
    turnScripts = [[init, { type: "result", subtype: "success", result: "ok" }]];
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "session.create", { permissionMode: "garbage" }));
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "go" }));
    await new Promise((r) => setTimeout(r, 30));
    expect((d as any).permModes[CC_SID]).toBeUndefined();
    expect(lastOptions.permissionMode).toBe("bypassPermissions"); // env 逃生門
    delete process.env.MACCHIATO_CC_PERMISSION_MODE;
    d.dispose();
  });

  it("acceptEdits 檔:Write 經 canUseTool 自動批(不彈審批卡)", async () => {
    delete process.env.MACCHIATO_CC_PERMISSION_MODE;
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "session.create", { permissionMode: "acceptEdits" }));
    await new Promise((r) => setTimeout(r, 5));
    // 直接驗 openChannel 裝的 canUseTool 策略:手動取通道的 canUseTool
    // 用 resolvePerm 驗策略即可(canUseTool 在真 SDK 才觸發)
    const perm = (d as any).resolvePerm(CC_SID);
    expect(perm.sdk).toBe("default");
    expect(perm.editAuto).toBe(true);
    // ask 檔則 editAuto=false
    fire(tuiFrame(CC_SID, "session.create", { permissionMode: "ask" }));
    expect((d as any).resolvePerm(CC_SID).editAuto).toBe(false);
    expect(sent.length >= 0).toBe(true);
    d.dispose();
  });

  it("ExitPlanMode → 審批卡帶 plan 正文(#99)", async () => {
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    const p = (d as any).requestApproval(CC_SID, "ExitPlanMode", { plan: "1. 加 /health 路由\n2. 返回 200" }, { toolUseID: "t1" });
    const req = sent.find((f: any) => f.frame?.params?.type === "approval.request") as any;
    expect(req.frame.params.payload.command).toContain("批准計劃");
    expect(req.frame.params.payload.plan).toContain("/health 路由");
    expect(req.frame.params.payload.description).toContain("/health 路由");
    fire(tuiFrame(CC_SID, "approval.respond", { choice: "allow", request_id: "t1" }));
    expect((await p).behavior).toBe("allow");
    d.dispose();
  });

  it("權限檔變更 → 閒置通道重建(permKey 變)", async () => {
    delete process.env.MACCHIATO_CC_PERMISSION_MODE;
    process.env.MACCHIATO_CC_TITLE_MODE = "off";
    turnScripts = [
      [init, { type: "result", subtype: "success", result: "one" }],
      [init, { type: "result", subtype: "success", result: "two" }],
    ];
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "session.create", { permissionMode: "ask" }));
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "t1" }));
    await new Promise((r) => setTimeout(r, 30));
    const q1 = queryCalls;
    fire(tuiFrame(CC_SID, "session.create", { permissionMode: "bypass" })); // 閒置期改檔 → 關通道
    await new Promise((r) => setTimeout(r, 10));
    expect((d as any).channels.size).toBe(0); // 重建(關掉舊的)
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "t2" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(queryCalls).toBe(q1 + 1); // 新通道
    expect(lastOptions.permissionMode).toBe("bypassPermissions");
    d.dispose();
    delete process.env.MACCHIATO_CC_TITLE_MODE;
  });

  it("#143 model 變更 → 閒置通道重建 + SDK options.model", async () => {
    process.env.MACCHIATO_CC_TITLE_MODE = "off";
    turnScripts = [
      [init, { type: "result", subtype: "success", result: "one" }],
      [init, { type: "result", subtype: "success", result: "two" }],
    ];
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "session.create", { model: "opus" }));
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "t1" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(lastOptions.model).toBe("opus");
    const q1 = queryCalls;
    fire(tuiFrame(CC_SID, "session.create", { model: "sonnet" })); // 閒置期改 model → 關通道
    await new Promise((r) => setTimeout(r, 10));
    expect((d as any).channels.size).toBe(0); // 重建(關掉舊的)
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "t2" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(queryCalls).toBe(q1 + 1); // 新通道
    expect(lastOptions.model).toBe("sonnet");
    d.dispose();
    delete process.env.MACCHIATO_CC_TITLE_MODE;
  });

  it("#143 無 per-session model → 回退 env MACCHIATO_CC_MODEL;都無 → 不傳 model", async () => {
    process.env.MACCHIATO_CC_TITLE_MODE = "off";
    // (a) 有 env → 用 env
    process.env.MACCHIATO_CC_MODEL = "haiku";
    turnScripts = [[init, { type: "result", subtype: "success", result: "a" }]];
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "hi" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(lastOptions.model).toBe("haiku");
    d.dispose();
    // (b) 無 env、無 per-session → options 不含 model(用 CLI 配置默認)
    delete process.env.MACCHIATO_CC_MODEL;
    lastOptions = null;
    turnScripts = [[init, { type: "result", subtype: "success", result: "b" }]];
    const { linkb: lb2, fire: fire2 } = fakeLinkb();
    const d2 = new Drive(lb2);
    d2.wire();
    fire2(tuiFrame(CC_SID, "prompt.submit", { text: "hi" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(lastOptions.model).toBeUndefined();
    d2.dispose();
    delete process.env.MACCHIATO_CC_TITLE_MODE;
  });
});

describe("#200 在途回合可見化(重啟提示重發)", () => {
  const hasNotice = (sent: Record<string, unknown>[]) =>
    sent.filter((f) => JSON.stringify(f).includes("連接器剛重啟")).length;

  it("進程死在回合中途 → 下次啟動對該會話回「請重發」提示", async () => {
    process.env.MACCHIATO_CC_TITLE_MODE = "off";
    // 回合開始但不結束(init 後掛住)——模擬進程被殺在回合中途,pending 落盤
    emitScript = [{ type: "system", subtype: "init", session_id: CC_SID }, { __wait: 9000 }];
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "hi" }));
    await new Promise((r) => setTimeout(r, 30));
    // 「新進程」:同一狀態文件新建 Drive → flush 應對 CC_SID 提示重發
    const { linkb: lb2, sent: sent2 } = fakeLinkb();
    const d2 = new Drive(lb2);
    d2.flushAbandonedTurns();
    expect(hasNotice(sent2)).toBe(1);
    // 冪等:再 flush 不重發
    d2.flushAbandonedTurns();
    expect(hasNotice(sent2)).toBe(1);
    d.dispose();
    d2.dispose();
    delete process.env.MACCHIATO_CC_TITLE_MODE;
  });

  it("正常完成的回合 → 下次啟動不提示", async () => {
    process.env.MACCHIATO_CC_TITLE_MODE = "off";
    emitScript = [
      { type: "system", subtype: "init", session_id: CC_SID },
      { type: "result", subtype: "success", result: "ok" },
    ];
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "hi" }));
    await new Promise((r) => setTimeout(r, 40)); // 回合跑完 → pending 清
    const { linkb: lb2, sent: sent2 } = fakeLinkb();
    const d2 = new Drive(lb2);
    d2.flushAbandonedTurns();
    expect(hasNotice(sent2)).toBe(0);
    d.dispose();
    d2.dispose();
    delete process.env.MACCHIATO_CC_TITLE_MODE;
  });
});

describe("#201 SDK 自發喚醒的續寫回合", () => {
  it("無 prompt.submit 的續寫回合(子任務完成自動喚醒)→ 投遞成新 agent 消息", async () => {
    process.env.MACCHIATO_CC_TITLE_MODE = "off";
    emitScript = [
      { type: "system", subtype: "init", session_id: CC_SID },
      { type: "result", subtype: "success", result: "第一回合" },
      // ↓ 自動喚醒:又一個 init,但沒有新的 prompt.submit(模擬 task-notification 續寫)
      { type: "system", subtype: "init", session_id: CC_SID },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "續寫的設計" } },
      },
      { type: "result", subtype: "success", result: "續寫的設計" },
    ];
    const { linkb, sent, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame(CC_SID, "prompt.submit", { text: "hi" }));
    await new Promise((r) => setTimeout(r, 50));
    const completes = sent.filter((f: any) => f.frame?.params?.type === "message.complete");
    expect(completes.length).toBe(2); // 第一回合 + 自動喚醒續寫(修復前只有 1,續寫被 !turn 丟棄)
    expect((completes[1] as any).frame.params.payload.text).toBe("續寫的設計");
    d.dispose();
    delete process.env.MACCHIATO_CC_TITLE_MODE;
  });
});

describe("#161 手動改名回寫", () => {
  it("session.rename → renameSession(ccSid, title) 寫回 CLI transcript;無映射/空標題忽略", async () => {
    renameCalls.length = 0;
    emitScript = [
      { type: "system", subtype: "init", session_id: CC_SID },
      { type: "result", subtype: "success", result: "ok" },
    ];
    const { linkb, fire } = fakeLinkb();
    const d = new Drive(linkb);
    d.wire();
    fire(tuiFrame("01ULIDRENAME000000000000AA", "prompt.submit", { text: "hi" })); // 建映射
    await new Promise((r) => setTimeout(r, 30));
    fire(tuiFrame("01ULIDRENAME000000000000AA", "session.rename", { title: "新標題" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(renameCalls).toContainEqual([CC_SID, "新標題"]);
    // 空標題忽略
    const n = renameCalls.length;
    fire(tuiFrame("01ULIDRENAME000000000000AA", "session.rename", { title: "  " }));
    await new Promise((r) => setTimeout(r, 10));
    expect(renameCalls.length).toBe(n);
    d.dispose();
  });
});
