import { describe, it, expect } from "vitest";
import {
  unwrapCodexErrorText,
  parseModelNeedsNewerCli,
  formatCodexTurnError,
} from "../src/codex/turn-errors";

describe("unwrapCodexErrorText", () => {
  it("剝 JSON detail / message 殼", () => {
    expect(
      unwrapCodexErrorText(
        `{"detail":"The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}`,
      ),
    ).toContain("gpt-5.6-sol");
    expect(unwrapCodexErrorText({ detail: "boom detail" })).toBe("boom detail");
    expect(unwrapCodexErrorText({ message: "boom message" })).toBe("boom message");
  });

  it("app-server error: 前綴 + JSON", () => {
    expect(
      unwrapCodexErrorText(`app-server error: ${JSON.stringify({ message: "token expired" })}`),
    ).toBe("token expired");
  });

  it("普通字符串原樣", () => {
    expect(unwrapCodexErrorText("plain boom")).toBe("plain boom");
  });
});

describe("parseModelNeedsNewerCli", () => {
  it("識別模型需更新 CLI(含 JSON 殼)", () => {
    const raw =
      `{"detail":"The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}`;
    expect(parseModelNeedsNewerCli(raw)).toEqual({
      model: "gpt-5.6-sol",
      text: expect.stringContaining("gpt-5.6-sol"),
    });
  });

  it("非此類錯誤 → null", () => {
    expect(parseModelNeedsNewerCli("401 Unauthorized")).toBeNull();
    expect(parseModelNeedsNewerCli("boom")).toBeNull();
  });
});

describe("formatCodexTurnError", () => {
  it("模型需更新 CLI → 中文可行動(點明是本機 Codex 不是 Macchiato)", () => {
    const s = formatCodexTurnError(
      `{"detail":"The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade."}`,
    );
    expect(s).toContain("gpt-5.6-sol");
    expect(s).toMatch(/Codex CLI/);
    expect(s).toMatch(/不是 Macchiato/);
    expect(s).toMatch(/npm i -g @openai\/codex@latest/);
    expect(s).not.toMatch(/\{"detail"/);
  });

  it("auth 類 → codex login", () => {
    expect(formatCodexTurnError("401 Unauthorized: token has expired")).toMatch(/codex login/);
  });

  it("ENOENT → 安裝指引", () => {
    expect(formatCodexTurnError("spawn codex ENOENT")).toMatch(/找不到 Codex/);
    expect(formatCodexTurnError("spawn /usr/bin/codex ENOENT")).toMatch(/npm i -g @openai\/codex/);
  });

  it("一般錯誤剝殼截斷", () => {
    const s = formatCodexTurnError({ detail: "something else broke" });
    expect(s).toContain("something else broke");
    expect(s).toMatch(/^❌ 回合失敗/);
  });
});
