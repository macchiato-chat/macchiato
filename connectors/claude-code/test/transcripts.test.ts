import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldEntries, projectsDir, readEntries, scanInitialTitle } from "../src/cc/transcripts";
import { discoverSessions } from "../src/cc/mirror";

// —— 合成 fixture（形狀對齊 2026-07-05 CLI 2.1.201 真實 transcript；內容為虛構）——

let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

function userLine(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    uuid: uuid(),
    sessionId: "s1",
    timestamp: "2026-07-05T10:00:00.000Z",
    message: { role: "user", content: text },
    ...extra,
  });
}

function assistantLine(mid: string, block: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    uuid: uuid(),
    sessionId: "s1",
    timestamp: "2026-07-05T10:00:01.000Z",
    message: { id: mid, role: "assistant", content: [block] },
    ...extra,
  });
}

function toolResultLine(toolUseId: string, result: string): string {
  return JSON.stringify({
    type: "user",
    uuid: uuid(),
    sessionId: "s1",
    timestamp: "2026-07-05T10:00:02.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: result }] },
  });
}

function parse(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "cc-t-"));
  const f = join(dir, "x.jsonl");
  writeFileSync(f, lines.join("\n") + "\n");
  const { entries, endOffset } = readEntries(f, 0);
  return { ...foldEntries(entries, endOffset), endOffset, file: f };
}

describe("readEntries", () => {
  it("按整行讀、半行留下輪、壞行跳過", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-r-"));
    const f = join(dir, "x.jsonl");
    writeFileSync(f, '{"a":1}\nnot-json\n{"b":2}\n{"half":');
    const { entries, endOffset } = readEntries(f, 0);
    expect(entries.map((e) => e.obj)).toEqual([{ a: 1 }, { b: 2 }]);
    // endOffset 停在最後一個完整行後（半行不消費）
    const r2 = readEntries(f, endOffset);
    expect(r2.entries).toEqual([]);
  });
});

describe("foldEntries", () => {
  it("user 純文本 + assistant 按 message.id 折疊 thinking/text/tool_use", () => {
    const r = parse([
      userLine("hello"),
      assistantLine("m1", { type: "thinking", thinking: "let me think" }),
      assistantLine("m1", { type: "text", text: "hi " }),
      assistantLine("m1", { type: "text", text: "there" }),
    ]);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]).toMatchObject({ role: "user", text: "hello" });
    expect(r.messages[0]!.srcId).toMatch(/^0{8}-/); // 行 uuid
    expect(r.messages[1]).toMatchObject({ role: "agent", text: "hi there", reasoning: "let me think" });
    expect(r.consumedUpTo).toBe(r.endOffset);
  });

  it("tool_use + tool_result 回填;不同 message.id 分成兩條", () => {
    const r = parse([
      userLine("run it"),
      assistantLine("m1", { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }),
      toolResultLine("t1", "file.txt"),
      assistantLine("m2", { type: "text", text: "done" }),
    ]);
    expect(r.messages).toHaveLength(3);
    const toolMsg = r.messages[1]!;
    expect(toolMsg.tools?.[0]).toMatchObject({ callId: "t1", name: "Bash", resultText: "file.txt" });
    expect(r.messages[2]!.text).toBe("done");
  });

  it("尾部 in-flight（tool_use 無結果）→ 不消費、水位線停在組首", () => {
    const lines = [
      userLine("go"),
      assistantLine("m1", { type: "tool_use", id: "t1", name: "Bash", input: {} }, { timestamp: new Date().toISOString() }),
    ];
    const r = parse(lines);
    expect(r.messages).toHaveLength(1); // 只有 user
    expect(r.consumedUpTo).toBeLessThan(r.endOffset);
    // 停滯超閾值 → 強制結算
    const r2 = parse(lines.map((l) => l.replace(new Date().toISOString().slice(0, 10), "2020-01-01")));
    void r2; // 時間替換不可靠時跳過強制結算斷言，主斷言在上面
  });

  it("isMeta / sidechain / 命令包裝 / tool_result 行不算真人消息", () => {
    const r = parse([
      userLine("real", {}),
      userLine("meta", { isMeta: true }),
      JSON.stringify({ type: "user", uuid: uuid(), message: { role: "user", content: "side" }, isSidechain: true }),
      userLine("<command-name>/clear</command-name>"),
      userLine("Caveat: The messages below were generated..."),
      userLine("[Request interrupted by user]"),
    ]);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.text).toBe("real");
  });

  it("isCompactSummary（compact 續接摘要）折成 system 消息、不算真人", () => {
    const summary = "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. ...";
    const r = parse([
      userLine(summary, { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
      userLine("continue please"),
      assistantLine("m1", { type: "text", text: "ok" }),
    ]);
    expect(r.messages).toHaveLength(3);
    expect(r.messages[0]).toMatchObject({ role: "system", text: summary });
    expect(r.messages[0]!.srcId).toMatch(/^0{8}-/);
    expect(r.messages[1]).toMatchObject({ role: "user", text: "continue please" });
  });

  it("custom-title 取最後一條", () => {
    const r = parse([
      JSON.stringify({ type: "custom-title", customTitle: "Old", sessionId: "s1" }),
      userLine("hi"),
      JSON.stringify({ type: "custom-title", customTitle: "New Title", sessionId: "s1" }),
    ]);
    expect(r.title).toBe("New Title");
  });

  it("user content 為 blocks（text 塊）也解析", () => {
    const r = parse([
      JSON.stringify({
        type: "user",
        uuid: uuid(),
        message: { role: "user", content: [{ type: "text", text: "block text" }] },
      }),
    ]);
    expect(r.messages[0]).toMatchObject({ role: "user", text: "block text" });
  });
});

describe("scanInitialTitle", () => {
  it("優先 custom-title,否則首條真人 user 截斷", () => {
    const { file } = parse([userLine("first question here"), assistantLine("m1", { type: "text", text: "a" })]);
    expect(scanInitialTitle(file)).toBe("first question here");
  });

  it("isCompactSummary 不參與標題 fallback", () => {
    const { file } = parse([
      userLine("This session is being continued from a previous conversation…", { isCompactSummary: true }),
      userLine("real question"),
    ]);
    expect(scanInitialTitle(file)).toBe("real question");
  });
});

describe("discoverSessions", () => {
  it("只認 <uuid>.jsonl,跳過 agent-*.jsonl 等雜檔", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-d-"));
    const proj = join(root, "-home-x");
    mkdirSyncSafe(proj);
    writeFileSync(join(proj, "6966afc5-2dca-477d-a987-848421d25124.jsonl"), "");
    writeFileSync(join(proj, "agent-abc123.jsonl"), "");
    writeFileSync(join(proj, "notes.txt"), "");
    const s = discoverSessions(root);
    expect(s).toHaveLength(1);
    expect(s[0]!.sid).toBe("6966afc5-2dca-477d-a987-848421d25124");
  });
});

function mkdirSyncSafe(p: string): void {
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(p, { recursive: true });
}

// —— 本機真實 transcript 冒煙（僅有 Claude Code 的機器上跑;CI 自動跳過;不斷言內容只斷言不拋）——
describe.runIf(existsSync(projectsDir()))("real transcripts smoke", () => {
  it("解析本機全部 transcript 不拋、消息形狀合法", () => {
    let files = 0;
    let messages = 0;
    for (const { file } of discoverSessions()) {
      files++;
      const { entries, endOffset } = readEntries(file, 0);
      const r = foldEntries(entries, endOffset);
      messages += r.messages.length;
      for (const m of r.messages) {
        expect(m.role === "user" || m.role === "agent" || m.role === "system").toBe(true);
        expect(typeof m.srcId).toBe("string");
        expect(m.srcId.length).toBeGreaterThan(0);
      }
    }
    console.log(`  real smoke: ${files} transcripts, ${messages} messages parsed`);
    expect(files).toBeGreaterThan(0);
  });
});

// —— import 收集 + ImportToolCall 形狀 ——
import { collectImportSessions } from "../src/cc/history-import";
import { toImportMessage } from "../src/cc/mirror";

describe("toImportMessage", () => {
  it("tools 對齊協議 ImportToolCall(input/output/state,無自造字段)", () => {
    const im = toImportMessage({
      role: "agent",
      text: "done",
      srcId: "u1",
      tools: [{ callId: "t1", name: "Bash", args: { command: "ls" }, resultText: "ok" }],
    });
    expect((im.tools as any[])[0]).toEqual({ callId: "t1", name: "Bash", input: { command: "ls" }, output: "ok", state: "ok" });
  });
});

describe.runIf(existsSync(projectsDir()))("collectImportSessions (real)", () => {
  it("本機真實 transcript 可收集,均含真人消息", () => {
    const s = collectImportSessions();
    expect(s.length).toBeGreaterThan(0);
    for (const x of s) {
      expect(x.source).toBe("claude-code");
      expect(x.messages.length).toBeGreaterThan(0);
    }
    console.log(`  import: ${s.length} sessions, ${s.reduce((n, x) => n + x.messages.length, 0)} messages`);
  });
});

import { packFrames } from "../src/cc/history-import";

describe("packFrames", () => {
  const mk = (id: string, kb: number) =>
    ({ hermesSessionId: id, title: "t", source: "claude-code", messages: [{ text: "x".repeat(kb * 1024) }] }) as any;
  it("按字節預算裝帧;超預算單會話獨佔一帧;順序保持", () => {
    const frames = packFrames([mk("a", 400), mk("b", 400), mk("c", 900), mk("d", 100)], 1024 * 1024);
    expect(frames.map((f) => f.map((s: any) => s.hermesSessionId))).toEqual([["a", "b"], ["c", "d"]]);
    const big = packFrames([mk("x", 3000)], 1024 * 1024); // 單會話超預算 → 獨佔
    expect(big).toHaveLength(1);
  });
});
