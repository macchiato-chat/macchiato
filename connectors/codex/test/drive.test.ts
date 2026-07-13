import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** #145 中斷語義單測:mock spawn,可控 close(code)。 */
const procs: FakeProc[] = [];
class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  kill(sig?: string) {
    this.killed.push(sig ?? "SIGTERM");
    return true;
  }
}
const spawnArgs: string[][] = [];
vi.mock("node:child_process", () => ({
  spawn: (_bin: string, args: string[]) => {
    spawnArgs.push(args);
    const p = new FakeProc();
    procs.push(p);
    return p;
  },
}));

// #146:攔 materializeAttachment(免起網絡),其餘原樣。
let mockMaterialize: (ref: unknown) => Promise<string> = async () => {
  throw new Error("not stubbed");
};
vi.mock("../src/codex/attachments", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/codex/attachments")>();
  return { ...orig, materializeAttachment: (ref: unknown) => mockMaterialize(ref) };
});

import { Drive } from "../src/codex/drive";

function makeDrive() {
  process.env.MACCHIATO_CODEX_SESSIONS = join(mkdtempSync(join(tmpdir(), "cx-dr-")), "sessions.json");
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
  const d = new Drive(linkb);
  d.wire();
  return { d, linkb, sent };
}

const tui = (method: string, sessionId: string, params: any = {}) => ({
  t: "tui",
  sessionId,
  frame: { method, params: { session_id: sessionId, ...params } },
});
const completes = (sent: any[]) =>
  sent.filter((f) => f.frame?.params?.type === "message.complete").map((f) => f.frame.params.payload);

const SID = "01CXTESTSID000000000000000";

beforeEach(() => {
  procs.length = 0;
  spawnArgs.length = 0;
  mockMaterialize = async () => {
    throw new Error("not stubbed");
  };
});

describe("#145 中斷語義", () => {
  it("session.interrupt → kill + 清空排隊;close(null) 定性 interrupted(不冒充 complete)", async () => {
    const { linkb, sent } = makeDrive();
    await linkb.deliver(tui("prompt.submit", SID, { text: "q1" }));
    expect(procs).toHaveLength(1);
    await linkb.deliver(tui("prompt.submit", SID, { text: "q2(排隊)" })); // 回合中 → 進隊
    await linkb.deliver(tui("session.interrupt", SID));
    expect(procs[0]!.killed).toEqual(["SIGTERM"]);
    procs[0]!.emit("close", null); // SIGTERM → code null
    await new Promise((r) => setTimeout(r, 10));
    const cs = completes(sent);
    expect(cs).toHaveLength(1);
    expect(cs[0].status).toBe("interrupted"); // 修復前是 "complete"
    expect(procs).toHaveLength(1); // 隊列已清:不再自動起 q2 的新回合(修復前會)
  });

  it("外部信號殺(無顯式中斷,close null)→ 同樣 interrupted;正常 close(0) → complete", async () => {
    const { linkb, sent } = makeDrive();
    await linkb.deliver(tui("prompt.submit", SID, { text: "q" }));
    procs[0]!.emit("close", null); // 例如 earlyoom kill
    await new Promise((r) => setTimeout(r, 10));
    expect(completes(sent)[0].status).toBe("interrupted");
    // 新回合正常結束
    await linkb.deliver(tui("prompt.submit", SID, { text: "q2" }));
    procs[1]!.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "答" } }) + "\n"));
    procs[1]!.emit("close", 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(completes(sent)[1].status).toBe("complete");
  });
});

describe("#146 入站附件(落盤 + 路徑注入)", () => {
  it("圖片/檔案附件 → materialize 落盤,路徑注進 prompt;audio → stt_unavailable 回執", async () => {
    mockMaterialize = async (ref: any) => `/tmp/att/${ref.name}`;
    const { linkb, sent } = makeDrive();
    await linkb.deliver(
      tui("prompt.submit", SID, {
        text: "看看這張圖",
        attachments: [
          { id: "a1", kind: "image", name: "shot.png", mime: "image/png", url: "https://x/a1" },
          { id: "a2", kind: "audio", name: "v.m4a", mime: "audio/mp4", url: "https://x/a2" },
        ],
      }),
    );
    expect(spawnArgs).toHaveLength(1);
    const prompt = spawnArgs[0]![spawnArgs[0]!.length - 1]!;
    expect(prompt).toContain("看看這張圖");
    expect(prompt).toContain("/tmp/att/shot.png"); // 路徑注入,codex 用讀檔工具訪問
    const vt = sent.find((f: any) => f.t === "voice_transcript");
    expect(vt?.error).toBe("stt_unavailable"); // audio 走雲端 STT 回退鏈
  });

  it("下載失敗 → review.summary 警示(不再靜默丟);純附件無文字也能起回合", async () => {
    let n = 0;
    mockMaterialize = async (ref: any) => {
      n++;
      if (n === 1) throw new Error("HTTP 403");
      return `/tmp/att/${ref.name}`;
    };
    const { linkb, sent } = makeDrive();
    await linkb.deliver(
      tui("prompt.submit", SID, {
        text: "",
        attachments: [
          { id: "b1", kind: "document", name: "bad.pdf", mime: "application/pdf", url: "https://x/b1" },
          { id: "b2", kind: "document", name: "ok.pdf", mime: "application/pdf", url: "https://x/b2" },
        ],
      }),
    );
    const warn = sent.find((f: any) => JSON.stringify(f).includes("下載失敗"));
    expect(warn).toBeTruthy();
    expect(spawnArgs).toHaveLength(1); // 成功的那個仍起回合
    expect(spawnArgs[0]![spawnArgs[0]!.length - 1]).toContain("/tmp/att/ok.pdf");
  });
});

describe("#153 工具保真 + reasoning 透出", () => {
  const feed = (p: FakeProc, ev: any) => p.stdout.emit("data", Buffer.from(JSON.stringify(ev) + "\n"));
  const events = (sent: any[]) => sent.filter((f) => f.frame?.params?.type).map((f) => f.frame.params);

  it("command_execution → args.command + aggregated_output;exit≠0 標 error;reasoning 完成項 → reasoning.delta", async () => {
    const { linkb, sent } = makeDrive();
    await linkb.deliver(tui("prompt.submit", SID, { text: "跑個命令" }));
    const p = procs[0]!;
    feed(p, { type: "item.completed", item: { id: "r1", type: "reasoning", text: "先想想" } });
    feed(p, { type: "item.started", item: { id: "c1", type: "command_execution", command: "/bin/bash -lc 'ls'", status: "in_progress" } });
    feed(p, { type: "item.completed", item: { id: "c1", type: "command_execution", command: "/bin/bash -lc 'ls'", aggregated_output: "file1\n", exit_code: 1, status: "completed" } });
    feed(p, { type: "item.completed", item: { id: "m1", type: "agent_message", text: "跑完了" } });
    p.emit("close", 0);
    await new Promise((r) => setTimeout(r, 10));
    const evs = events(sent);
    const reasoning = evs.find((e) => e.type === "reasoning.delta");
    expect(reasoning?.payload.text).toBe("先想想");
    const tc = evs.find((e) => e.type === "tool.complete");
    expect(tc?.payload.name).toBe("command");
    expect(tc?.payload.args).toEqual({ command: "/bin/bash -lc 'ls'" }); // 修復前恆 {}
    expect(tc?.payload.result_text).toBe("file1\n");
    expect(tc?.payload.error).toBe("exit 1");
  });

  it("file_change / 未知類型:args 帶實料不再為空", async () => {
    const { toolCardFor } = await import("../src/codex/drive");
    const fc = toolCardFor({ id: "f1", type: "file_change", changes: [{ path: "a.ts", kind: "edit" }], status: "completed" });
    expect(fc.args).toEqual({ changes: [{ path: "a.ts", kind: "edit" }] });
    const unk = toolCardFor({ id: "x", type: "future_thing", detail: "y".repeat(600) });
    expect(unk.name).toBe("future_thing");
    expect(String(unk.args.detail)).toHaveLength(501); // 截斷 500+省略號
  });
});

describe("#156 覆蓋缺口:排隊續投 + E2E send", () => {
  it("回合中追加 prompt → 排隊;回合結束自動續投(新 proc,帶排隊文本)", async () => {
    const { linkb } = makeDrive();
    await linkb.deliver(tui("prompt.submit", SID, { text: "第一條" }));
    expect(procs).toHaveLength(1);
    await linkb.deliver(tui("prompt.submit", SID, { text: "第二條(排隊)" }));
    expect(procs).toHaveLength(1); // 回合中:不起新 proc
    procs[0]!.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "答一" } }) + "\n"));
    procs[0]!.emit("close", 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(procs).toHaveLength(2); // 續投起新 proc
    expect(spawnArgs[1]![spawnArgs[1]!.length - 1]).toBe("第二條(排隊)");
  });

  it("E2E 會話:回合結束把 user+reply 加密成 mirror_append(不走明文 tui)", async () => {
    const { linkb, sent } = makeDrive();
    // 最小可逆「加密」樁:isE2E=true、encrypt/decrypt 直傳
    const d2sent: any[] = [];
    const e2e: any = {
      isE2E: () => true,
      decryptText: (_s: string, t: string) => t,
      encryptContent: (_s: string, o: any) => "enc:" + JSON.stringify(o),
    };
    const { Drive } = await import("../src/codex/drive");
    process.env.MACCHIATO_CODEX_SESSIONS = join(mkdtempSync(join(tmpdir(), "cx-e2e-")), "s.json");
    const lb: any = { agentLinkId: "al", isReady: true, handlers: [], onFrame(h: any) { this.handlers.push(h); }, send: (m: any) => d2sent.push(m), async deliver(m: any) { for (const h of this.handlers) await h(m); } };
    const d = new Drive(lb, undefined, e2e);
    d.wire();
    await lb.deliver(tui("prompt.submit", SID, { text: "秘密問題" }));
    const p = procs[procs.length - 1]!;
    p.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "秘密回答" } }) + "\n"));
    p.emit("close", 0);
    await new Promise((r) => setTimeout(r, 10));
    // 明文 tui 事件不許有
    expect(d2sent.filter((f) => f.t === "tui" && JSON.stringify(f).includes("秘密"))).toHaveLength(0);
    const mf = d2sent.find((f) => f.t === "mirror_append");
    expect(mf.sessions[0].e2e).toBe(true);
    const roles = mf.sessions[0].messages.map((m: any) => m.role);
    expect(roles).toEqual(["user", "agent"]);
    expect(mf.sessions[0].messages[1].enc).toContain("秘密回答");
  });
});
