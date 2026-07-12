import { describe, expect, it } from "vitest";
import { readNewMessages } from "../src/codex/transcripts";

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
});
