import { beforeEach, describe, expect, it } from "vitest";
import { cleanTitle, fallbackTitle, generateTitle, titleMode } from "../src/codex/titles";

beforeEach(() => {
  delete process.env.MACCHIATO_CODEX_TITLE_MODE;
});

describe("codex titles", () => {
  it("titleMode 默認 summary;firstmsg/off 透傳;非法忽略", () => {
    expect(titleMode()).toBe("summary");
    process.env.MACCHIATO_CODEX_TITLE_MODE = "firstmsg";
    expect(titleMode()).toBe("firstmsg");
    process.env.MACCHIATO_CODEX_TITLE_MODE = "x";
    expect(titleMode()).toBe("summary");
  });
  it("fallback 截斷/壓空白;clean 去引號前綴", () => {
    expect(fallbackTitle("  多  行 ")).toBe("多 行");
    expect(cleanTitle('"標題: 支付"')).toBe("支付");
    expect(cleanTitle("『重構』")).toBe("重構");
  });
  it("firstmsg 零調用 codex;off 空", async () => {
    process.env.MACCHIATO_CODEX_TITLE_MODE = "firstmsg";
    expect(await generateTitle("问个问题")).toBe("问个问题");
    process.env.MACCHIATO_CODEX_TITLE_MODE = "off";
    expect(await generateTitle("问个问题")).toBe("");
  });
});
