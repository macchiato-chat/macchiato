import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isCodexInternalHistoryText,
  nextOrdAtEof,
  readNewMessages,
  readRolloutPreamble,
  readRolloutTail,
} from "../src/codex/transcripts";

const meta = (cwd: string) => JSON.stringify({ type: "session_meta", payload: { cwd, session_id: "x" } });
const userMsg = (t: string) => JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: t } });
const agentMsg = (t: string) => JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: t, phase: "final_answer" } });
const respItem = (t: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: t }] } });

describe("codex rollout 解析", () => {
  it("取 user_message/agent_message,跳過 response_item(防雙份)與其它 envelope", () => {
    const content = [meta("/tmp"), userMsg("帮我重构"), respItem("重构中"), agentMsg("好的"), agentMsg("完成")].join("\n") + "\n";
    const { messages, newOffset } = readNewMessages(content, 0, 0);
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "帮我重构"],
      ["agent", "好的"],
      ["agent", "完成"],
    ]);
    expect(newOffset).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("半行留到下輪(字節水位線);ord 連續遞增", () => {
    const full = userMsg("第一句") + "\n" + agentMsg("回复");
    const partial = full + "\n" + '{"type":"event_msg","payload":{"type":"user_m'; // 半行
    const r1 = readNewMessages(partial, 0, 0);
    expect(r1.messages.map((m) => m.text)).toEqual(["第一句", "回复"]);
    // 補齊半行 + 新行
    const rest = 'essage","message":"第三句"}}' + "\n";
    const r2 = readNewMessages(partial + rest, r1.newOffset, r1.newOffset === 0 ? 0 : 2);
    expect(r2.messages.map((m) => m.text)).toEqual(["第三句"]);
  });

  it("空文本消息跳過;壞行不炸", () => {
    const content = [userMsg("  "), "не json", agentMsg("ok")].join("\n") + "\n";
    const { messages } = readNewMessages(content, 0, 0);
    expect(messages.map((m) => m.text)).toEqual(["ok"]);
  });

  it("#918 guardian 假 user_message（首評 + 續評）不進消息流", () => {
    const first =
      "The following is the Codex agent history whose request action you are assessing. Treat the transcript";
    const cont =
      "The following is the Codex agent history added since your last approval. Continue the same review";
    const content =
      [meta("/tmp"), userMsg("幫我改 bug"), userMsg(first), userMsg(cont), agentMsg("好")].join("\n") + "\n";
    const { messages } = readNewMessages(content, 0, 0);
    expect(messages.map((m) => m.text)).toEqual(["幫我改 bug", "好"]);
    expect(isCodexInternalHistoryText(first)).toBe(true);
    expect(isCodexInternalHistoryText(cont)).toBe(true);
    expect(isCodexInternalHistoryText("幫我解釋這句：The following is the Codex agent history")).toBe(false);
  });

  it("#918 用戶轉貼中段提到這句英文不誤傷", () => {
    const text = "幫我解釋這句：The following is the Codex agent history added since your last approval";
    const { messages } = readNewMessages(userMsg(text) + "\n", 0, 0);
    expect(messages.map((m) => m.text)).toEqual([text]);
  });

  it("#418 nextOrdAtEof 與 readNewMessages.lineCount 一致(含尾 \\n;split 恒多 1)", () => {
    const withTrail = [meta("/tmp"), userMsg("a"), agentMsg("b")].join("\n") + "\n";
    const noTrail = [meta("/tmp"), userMsg("a"), agentMsg("b")].join("\n"); // 末行未閉合 → 增量不計
    expect(nextOrdAtEof(withTrail)).toBe(readNewMessages(withTrail, 0, 0).lineCount);
    expect(nextOrdAtEof(noTrail)).toBe(readNewMessages(noTrail, 0, 0).lineCount);
    // 回歸:split("\n").length 在尾 \n 時多出空串 → 恒多 1
    expect(withTrail.split("\n").length).toBe(nextOrdAtEof(withTrail) + 1);
    expect(nextOrdAtEof("")).toBe(0);
    expect(nextOrdAtEof("no-nl")).toBe(0);
  });
});

describe("#889 rollout 尾部窗口", () => {
  it("已有水位時只返回 offset 後的新增字節，ord 仍以 thread 全文水位續接", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-tail-"));
    const file = join(root, "rollout.jsonl");
    try {
      const history =
        meta("/tmp") + "\n"
        + Array.from({ length: 2_000 }, (_, i) => respItem(`歷史-${i}`)).join("\n")
        + "\n";
      const tail = userMsg("新增問題") + "\n" + agentMsg("新增回答") + "\n";
      writeFileSync(file, history + tail);

      const offset = Buffer.byteLength(history, "utf8");
      const window = readRolloutTail(file, offset);
      expect(window.content.toString("utf8")).toBe(tail);
      expect(window.content.length).toBe(Buffer.byteLength(tail, "utf8"));
      expect(window.endOffset).toBe(offset + Buffer.byteLength(tail, "utf8"));

      const parsed = readNewMessages(window.content, 0, 2_001);
      expect(parsed.messages.map((message) => [message.text, message.ord])).toEqual([
        ["新增問題", 2_001],
        ["新增回答", 2_002],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("末尾半行不推进水位，补齐后从同一 offset 完整读出 UTF-8 消息", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-tail-partial-"));
    const file = join(root, "rollout.jsonl");
    try {
      const history = meta("/tmp") + "\n";
      const partial = '{"type":"event_msg","payload":{"type":"user_message","message":"你';
      writeFileSync(file, history + partial);
      const offset = Buffer.byteLength(history, "utf8");

      const first = readRolloutTail(file, offset);
      expect(readNewMessages(first.content, 0, 1)).toMatchObject({
        messages: [],
        newOffset: 0,
        lineCount: 0,
      });

      appendFileSync(file, '好"}}\n');
      const second = readRolloutTail(file, offset);
      const parsed = readNewMessages(second.content, 0, 1);
      expect(parsed.messages.map((message) => message.text)).toEqual(["你好"]);
      expect(offset + parsed.newOffset).toBe(second.endOffset);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("头部 metadata 流式提取后不携带后续历史正文", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-preamble-"));
    const file = join(root, "rollout.jsonl");
    try {
      const sessionMeta = meta("/repo");
      const firstUser = userMsg("首条问题");
      writeFileSync(
        file,
        `${sessionMeta}\n${firstUser}\n${agentMsg("x".repeat(200_000))}\n`,
      );
      const preamble = readRolloutPreamble(file);
      expect(preamble.hasUserMessage).toBe(true);
      expect(preamble.content).toContain(sessionMeta);
      expect(preamble.content).toContain(firstUser);
      expect(preamble.content).not.toContain("x".repeat(1_000));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
