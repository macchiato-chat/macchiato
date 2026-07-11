import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanTitle,
  fallbackTitle,
  generateTitle,
  loadTitled,
  saveTitled,
  titlegenKey,
  titleMode,
} from "../src/openclaw/titles";

beforeEach(() => {
  delete process.env.MACCHIATO_OPENCLAW_TITLE_MODE;
  delete process.env.MACCHIATO_OPENCLAW_TITLE_TIMEOUT_MS;
  process.env.MACCHIATO_OPENCLAW_TITLED = join(mkdtempSync(join(tmpdir(), "oc-ti-")), "titled.json");
});

/** fake gateway:onEvent 可注銷;agent RPC 觸發(可配置的)chat final。 */
function fakeGw(opts: { finalText?: string; noFinal?: boolean } = {}) {
  const handlers: any[] = [];
  const calls: { method: string; params: any }[] = [];
  const gw: any = {
    onEvent(h: any) {
      handlers.push(h);
      return () => {
        const i = handlers.indexOf(h);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    async request(method: string, params: any) {
      calls.push({ method, params });
      if (method === "agent" && !opts.noFinal) {
        setTimeout(() => {
          for (const h of [...handlers])
            h({ event: "chat", payload: { sessionKey: params.sessionKey, state: "final",
              message: { role: "assistant", content: [{ type: "text", text: opts.finalText ?? "標題" }] } } });
        }, 5);
      }
      return { status: "started" };
    },
  };
  return { gw, calls, handlers };
}

describe("titles 基礎", () => {
  it("titleMode:默認 summary;firstmsg/off 透傳;非法忽略", () => {
    expect(titleMode()).toBe("summary");
    process.env.MACCHIATO_OPENCLAW_TITLE_MODE = "firstmsg";
    expect(titleMode()).toBe("firstmsg");
    process.env.MACCHIATO_OPENCLAW_TITLE_MODE = "off";
    expect(titleMode()).toBe("off");
    process.env.MACCHIATO_OPENCLAW_TITLE_MODE = "garbage";
    expect(titleMode()).toBe("summary");
  });

  it("fallbackTitle 截斷/壓空白;cleanTitle 去引號前綴多行", () => {
    expect(fallbackTitle("  多行\n第二行  文本  ")).toBe("多行 第二行 文本");
    expect(fallbackTitle("")).toBe("新會話");
    expect(cleanTitle('"標題: 支付重構"\n多餘行')).toBe("支付重構");
    expect(cleanTitle("「重構支付」")).toBe("重構支付");
  });

  it("titlegenKey 落在 MACCHIATO 前綴下(鏡像/導入天然跳過)且小寫", () => {
    expect(titlegenKey("01ABC")).toBe("agent:main:macchiato:titlegen-01abc");
  });
});

describe("generateTitle(經用戶自己的 agent)", () => {
  it("summary:agent RPC(deliver:false)→ final 事件 → 清洗後返回;事件監聽已注銷", async () => {
    const { gw, calls, handlers } = fakeGw({ finalText: "『支付模塊錯誤處理重構』" });
    const t = await generateTitle(gw, "01SID", "帮我重构支付模块");
    expect(t).toBe("支付模塊錯誤處理重構");
    expect(calls[0].method).toBe("agent");
    expect(calls[0].params.deliver).toBe(false);
    expect(calls[0].params.sessionKey).toBe(titlegenKey("01SID"));
    expect(handlers).toHaveLength(0); // 用完注銷,不洩漏
  });

  it("final 超時 → 回退首句截斷(不拋)", async () => {
    process.env.MACCHIATO_OPENCLAW_TITLE_TIMEOUT_MS = "60";
    const { gw, handlers } = fakeGw({ noFinal: true });
    const t = await generateTitle(gw, "01SID", "帮我重构支付模块");
    expect(t).toBe("帮我重构支付模块");
    expect(handlers).toHaveLength(0); // 超時路徑也注銷
  });

  it("firstmsg 模式零 RPC;off 返回空", async () => {
    process.env.MACCHIATO_OPENCLAW_TITLE_MODE = "firstmsg";
    const { gw, calls } = fakeGw();
    expect(await generateTitle(gw, "01SID", "問個問題")).toBe("問個問題");
    expect(calls).toHaveLength(0);
    process.env.MACCHIATO_OPENCLAW_TITLE_MODE = "off";
    expect(await generateTitle(gw, "01SID", "問個問題")).toBe("");
  });

  it("final 空文本 → 回退截斷", async () => {
    const { gw } = fakeGw({ finalText: "  " });
    expect(await generateTitle(gw, "01SID", "問個問題")).toBe("問個問題");
  });
});

describe("titled 持久集", () => {
  it("roundtrip:save → load;壞文件回空集", () => {
    const s = new Set(["01A", "01B"]);
    saveTitled(s);
    expect(loadTitled()).toEqual(s);
    process.env.MACCHIATO_OPENCLAW_TITLED = "/nonexistent/titled.json";
    expect(loadTitled()).toEqual(new Set());
  });
});
