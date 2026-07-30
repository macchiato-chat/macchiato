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
      // #553 支持 effort 的行帶產品默認 high(連接器 resolveEffort 真下發同值)
      { id: "opus", label: "Opus", description: "強", effortLevels: ["low", "high", "max"], defaultEffort: "high" },
      { id: "haiku", label: "Haiku" }, // 不支持 effort → 無 effortLevels、無 defaultEffort
    ]);
  });
});

describe("#231 enumerateModels + reporter", () => {
  it("枚舉並 close;上報 {t:models};ready 重發", async () => {
    sdkModels = [{ value: "sonnet", displayName: "Sonnet", supportsEffort: true, supportedEffortLevels: ["medium", "high"] }];
    closed = 0;
    expect(await enumerateModels("/tmp")).toEqual([{ id: "sonnet", label: "Sonnet", effortLevels: ["medium", "high"], defaultEffort: "high" }]);
    expect(closed).toBe(1);
    const { linkb, sent, fireReady } = fakeLinkb();
    await new ModelsReporter(linkb).start("/tmp");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: "models", agentLinkId: "AL1", models: [{ id: "sonnet", effortLevels: ["medium", "high"] }] });
    fireReady();
    expect(sent).toHaveLength(2);
  });
});

describe("#542/#553 resolvedId + isDefault + supportsEffort", () => {
  // 2026-07-30 沙盒真 SDK 實測形狀:default 行的 resolvedModel = 連接器實際默認跑的 wire id。
  const SDK_REAL = [
    { value: "default", resolvedModel: "claude-opus-4-8[1m]", displayName: "Default (recommended)", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
    { value: "opus[1m]", resolvedModel: "claude-opus-4-8[1m]", displayName: "Opus", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
    { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
    { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", supportsEffort: false },
  ];

  it("resolvedModel→resolvedId;default 行的 resolvedModel 對回具體別名行標 isDefault(default 行自身不標)", () => {
    const out = toModelOptions(SDK_REAL);
    expect(out.find((o) => o.id === "opus[1m]")).toMatchObject({ resolvedId: "claude-opus-4-8[1m]", isDefault: true });
    expect(out.find((o) => o.id === "default")?.isDefault).toBeUndefined();
    expect(out.find((o) => o.id === "sonnet")?.isDefault).toBeUndefined();
    expect(out.find((o) => o.id === "haiku")).toEqual({ id: "haiku", label: "Haiku", resolvedId: "claude-haiku-4-5-20251001" });
  });

  it("default 行的 resolvedModel 無別名行匹配 → 不標(client 誠實回退保留 Default 項)", () => {
    const out = toModelOptions([
      { value: "default", resolvedModel: "claude-x", displayName: "Default" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" },
    ]);
    expect(out.some((o) => o.isDefault)).toBe(false);
  });

  it("supportsEffort:id 精確/resolvedId/label 忽略大小寫/空=default 行;未知串與空緩存 → false", async () => {
    sdkModels = SDK_REAL;
    const { linkb } = fakeLinkb();
    const r = new ModelsReporter(linkb);
    expect(r.supportsEffort("sonnet")).toBe(false); // 緩存未就緒 → 不兜底
    await r.start("/tmp");
    expect(r.supportsEffort("sonnet")).toBe(true); // id 精確
    expect(r.supportsEffort("claude-sonnet-5")).toBe(true); // resolvedId(持久化過 wire id)
    expect(r.supportsEffort("opus")).toBe(true); // label 忽略大小寫("Opus" 行,id 是 opus[1m])
    expect(r.supportsEffort(undefined)).toBe(true); // 空 = 連接器默認 → default 行
    expect(r.supportsEffort("haiku")).toBe(false); // 明確不支持
    expect(r.supportsEffort("gpt-9")).toBe(false); // 不認識 → 不兜底
  });
});
