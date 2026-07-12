import { describe, expect, it } from "vitest";
import { deriveMeta, threadIdFromFile } from "../src/codex/mirror";

describe("codex mirror 派生", () => {
  it("threadIdFromFile:從 rollout 文件名提 uuid", () => {
    expect(threadIdFromFile("rollout-2026-07-12T10-24-56-019f53b6-7e07-7832-a070-39bb197a7062.jsonl")).toBe("019f53b6-7e07-7832-a070-39bb197a7062");
    expect(threadIdFromFile("notarollout.jsonl")).toBeUndefined();
  });

  it("deriveMeta:cwd 從 session_meta、標題從首條 user 消息截斷", () => {
    const content = [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/srv/demo/repo" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "帮我把温度曲线改成24小时滚动窗口顺便修时区" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "好" } }),
    ].join("\n");
    const m = deriveMeta(content);
    expect(m.cwd).toBe("/srv/demo/repo");
    expect(m.title).toBe("帮我把温度曲线改成24小时滚动窗口顺便修时区");
    expect(m.title.length).toBeLessThanOrEqual(56);
  });

  it("無 user 消息 → 標題回退 Codex", () => {
    expect(deriveMeta(JSON.stringify({ type: "session_meta", payload: {} })).title).toBe("Codex");
  });
});
