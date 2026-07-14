import { describe, it, expect, vi } from "vitest";

/** #199 命令枚舉/上報單測:mock SDK query(supportedCommands 可控)。 */
let sdkCommands: unknown[] = [];
let closed = 0;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => ({
    supportedCommands: async () => sdkCommands,
    close: () => void closed++,
    async *[Symbol.asyncIterator]() {
      await new Promise((r) => setTimeout(r, 5)); // close 前掛著
    },
  }),
}));

import { CommandsReporter, enumerateCommands, toCommandInfos } from "../src/cc/commands";

function fakeLinkb() {
  const sent: any[] = [];
  const readyHandlers: Array<() => void> = [];
  return {
    sent,
    fireReady: () => readyHandlers.forEach((h) => h()),
    linkb: {
      agentLinkId: "AL1",
      isReady: true,
      send: (m: any) => sent.push(m),
      onReady: (h: () => void) => {
        readyHandlers.push(h);
        return () => {};
      },
    } as any,
  };
}

describe("#199 toCommandInfos", () => {
  it("去前導斜杠、截描述 200、丟無名項、argumentHint 透傳", () => {
    const out = toCommandInfos([
      { name: "/foo", description: "x".repeat(300), argumentHint: "<file>" },
      { name: "bar", description: "", argumentHint: "" },
      { name: "", description: "nameless" },
      null,
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: "foo", description: "x".repeat(200), argumentHint: "<file>" });
    expect(out[1]).toEqual({ name: "bar" }); // 空描述/hint 不帶鍵
  });
});

describe("#199 enumerateCommands", () => {
  it("走 supportedCommands 並 close 回收短命進程", async () => {
    sdkCommands = [{ name: "verify", description: "檢一遍", argumentHint: "" }];
    closed = 0;
    const out = await enumerateCommands("/tmp");
    expect(out).toEqual([{ name: "verify", description: "檢一遍" }]);
    expect(closed).toBe(1); // 枚舉完即回收
  });
});

describe("#199 CommandsReporter", () => {
  it("start 枚舉即上報;每次 ready 重發(server 重啟丟緩存);commands_changed 整份替換", async () => {
    sdkCommands = [{ name: "a", description: "1", argumentHint: "" }];
    const { linkb, sent, fireReady } = fakeLinkb();
    const r = new CommandsReporter(linkb);
    await r.start("/tmp");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: "commands", agentLinkId: "AL1", commands: [{ name: "a", description: "1" }] });
    fireReady(); // 重連 → 重發緩存
    expect(sent).toHaveLength(2);
    r.update([{ name: "b", description: "2", argumentHint: "" }]); // 整份替換
    expect(sent).toHaveLength(3);
    expect(sent[2].commands).toEqual([{ name: "b", description: "2" }]);
    fireReady(); // 之後重發的是新清單
    expect(sent[3].commands[0].name).toBe("b");
  });

  it("枚舉返回空/異常形狀 → 空清單如實上報(agent 真沒命令),不拋不阻啟動", async () => {
    const { linkb, sent, fireReady } = fakeLinkb();
    const r = new CommandsReporter(linkb);
    sdkCommands = undefined as any; // supportedCommands 返回 undefined → toCommandInfos 容錯成 []
    await r.start("/tmp");
    expect(sent).toHaveLength(1);
    expect(sent[0].commands).toEqual([]);
    fireReady();
    expect(sent).toHaveLength(2);
  });
});
