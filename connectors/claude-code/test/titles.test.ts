import { afterEach, describe, expect, it, vi } from "vitest";

// mock SDK query:summary 档返回可控标题
let titleReply = "Scrape 30 Papers";
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "result", subtype: "success", result: titleReply };
    },
  }),
}));

async function fresh() {
  vi.resetModules();
  return await import("../src/cc/titles");
}

afterEach(() => { delete process.env.MACCHIATO_CC_TITLE_MODE; });

describe("titleMode (env 开关)", () => {
  it("默认 summary;firstmsg/off 生效;非法回退 summary", async () => {
    const { titleMode } = await fresh();
    expect(titleMode()).toBe("summary");
    process.env.MACCHIATO_CC_TITLE_MODE = "firstmsg";
    expect(titleMode()).toBe("firstmsg");
    process.env.MACCHIATO_CC_TITLE_MODE = "off";
    expect(titleMode()).toBe("off");
    process.env.MACCHIATO_CC_TITLE_MODE = "garbage";
    expect(titleMode()).toBe("summary");
  });
});

describe("generateTitle", () => {
  it("summary 档:走生成 + 清洗(去引号/前缀)", async () => {
    titleReply = '"标题：Scrape 30 Papers"';
    const { generateTitle } = await fresh();
    expect(await generateTitle("帮我抓取30papers的论文")).toBe("Scrape 30 Papers");
  });
  it("firstmsg 档:截断首条,不调 LLM", async () => {
    process.env.MACCHIATO_CC_TITLE_MODE = "firstmsg";
    const { generateTitle } = await fresh();
    const long = "帮我抓取30papers这个网站的30篇论文有些在本站有些要去原网站".repeat(3);
    const t = await generateTitle(long);
    expect(t.length).toBeLessThanOrEqual(56);
    expect(long.startsWith(t)).toBe(true);
  });
  it("off 档:返回空(不生成)", async () => {
    process.env.MACCHIATO_CC_TITLE_MODE = "off";
    const { generateTitle } = await fresh();
    expect(await generateTitle("whatever")).toBe("");
  });
  it("summary 生成空 → 回退截断", async () => {
    titleReply = "   ";
    const { generateTitle } = await fresh();
    expect(await generateTitle("首条消息内容")).toBe("首条消息内容");
  });
});
