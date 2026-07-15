import { describe, it, expect } from "vitest";
import { toModelOptions, ModelsReporter } from "../src/codex/models";

/** #231 codex model 上報:model/list → ModelOption(supportedReasoningEfforts/hidden)。 */

describe("#231 codex toModelOptions", () => {
  it("id/displayName/effortLevels(supportedReasoningEfforts)/defaultEffort;hidden 過濾;無 id 丟", () => {
    const out = toModelOptions([
      { id: "gpt-5.5", displayName: "GPT-5.5", description: "強", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }], hidden: false },
      { id: "hidden-m", displayName: "H", hidden: true },
      { displayName: "無 id" },
    ]);
    expect(out).toEqual([
      { id: "gpt-5.5", label: "GPT-5.5", description: "強", effortLevels: ["low", "medium", "high"], defaultEffort: "medium" },
    ]);
  });
});

describe("#231 codex ModelsReporter", () => {
  function fakes(res?: any, throws = false) {
    const sent: any[] = [];
    const readyHandlers: Array<() => void> = [];
    const linkb: any = { agentLinkId: "AL1", send: (m: any) => sent.push(m), onReady: (h: () => void) => (readyHandlers.push(h), () => {}) };
    const client: any = { request: async (m: string) => { expect(m).toBe("model/list"); if (throws) throw new Error("x"); return res; } };
    return { linkb, sent, client, fireReady: () => readyHandlers.forEach((h) => h()) };
  }
  it("app-server:model/list → 上報;ready 重發", async () => {
    const f = fakes({ data: [{ id: "m1", displayName: "M1", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] });
    await new ModelsReporter(f.linkb, f.client).start();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ t: "models", models: [{ id: "m1", effortLevels: ["high"] }] });
    f.fireReady();
    expect(f.sent).toHaveLength(2);
  });
  it("exec(無 client)→ 上報空;model/list 拋 → 空但不炸", async () => {
    const f1 = fakes();
    await new ModelsReporter(f1.linkb, undefined).start();
    expect(f1.sent[0].models).toEqual([]);
    const f2 = fakes(undefined, true);
    await new ModelsReporter(f2.linkb, f2.client).start();
    expect(f2.sent[0].models).toEqual([]);
  });
});
