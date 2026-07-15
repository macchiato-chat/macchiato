import { describe, it, expect, vi } from "vitest";

/** #231 model 上報單測:mock SDK supportedModels。 */
let sdkModels: unknown[] = [];
let closed = 0;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => ({
    supportedModels: async () => sdkModels,
    close: () => void closed++,
    async *[Symbol.asyncIterator]() {
      await new Promise((r) => setTimeout(r, 5));
    },
  }),
}));

import { ModelsReporter, enumerateModels, toModelOptions } from "../src/cc/models";

function fakeLinkb() {
  const sent: any[] = [];
  const readyHandlers: Array<() => void> = [];
  return {
    sent,
    fireReady: () => readyHandlers.forEach((h) => h()),
    linkb: { agentLinkId: "AL1", isReady: true, send: (m: any) => sent.push(m), onReady: (h: () => void) => (readyHandlers.push(h), () => {}) } as any,
  };
}

describe("#231 toModelOptions", () => {
  it("value→id、displayName→label、effortLevels 僅 supportsEffort 時帶、無 value 丟棄", () => {
    const out = toModelOptions([
      { value: "opus", displayName: "Opus", description: "強", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] },
      { value: "haiku", displayName: "Haiku", supportsEffort: false, supportedEffortLevels: ["low"] },
      { displayName: "無 value" },
    ]);
    expect(out).toEqual([
      { id: "opus", label: "Opus", description: "強", effortLevels: ["low", "high", "max"] },
      { id: "haiku", label: "Haiku" }, // 不支持 effort → 無 effortLevels
    ]);
  });
});

describe("#231 enumerateModels + reporter", () => {
  it("枚舉並 close;上報 {t:models};ready 重發", async () => {
    sdkModels = [{ value: "sonnet", displayName: "Sonnet", supportsEffort: true, supportedEffortLevels: ["medium", "high"] }];
    closed = 0;
    expect(await enumerateModels("/tmp")).toEqual([{ id: "sonnet", label: "Sonnet", effortLevels: ["medium", "high"] }]);
    expect(closed).toBe(1);
    const { linkb, sent, fireReady } = fakeLinkb();
    await new ModelsReporter(linkb).start("/tmp");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: "models", agentLinkId: "AL1", models: [{ id: "sonnet", effortLevels: ["medium", "high"] }] });
    fireReady();
    expect(sent).toHaveLength(2);
  });
});
