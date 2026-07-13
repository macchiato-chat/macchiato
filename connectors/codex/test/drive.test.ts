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
