import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatCommandInvokeLog,
  logContent,
  LOG_CONTENT_ENV,
  redactUpstreamLine,
  safeErr,
  shortId,
  textLen,
} from "../src/_core/safe-log";

const CANARY = "CANARY-SECRET-sk-live-CODEX-args-path-/Users/private/repo";

afterEach(() => {
  delete process.env[LOG_CONTENT_ENV];
  vi.restoreAllMocks();
});

describe("#381 safe-log", () => {
  it("shortId 截断长 id", () => {
    expect(shortId("01ABCDEFGHIJKLMNOP")).toBe("01ABCDEFGHIJ…");
    expect(shortId("short")).toBe("short");
    expect(shortId("")).toBe("-");
  });

  it("safeErr 默认不放行自由文本 canary", () => {
    expect(safeErr(new Error(CANARY))).toBe(`Error(len=${CANARY.length})`);
    expect(safeErr(CANARY)).toBe(`Error(len=${CANARY.length})`);
    expect(safeErr("control_rejected")).toBe("control_rejected");
  });

  it("redactUpstreamLine 剥掉 stderr 正文", () => {
    expect(redactUpstreamLine(`[gateway-exit] ${CANARY}`)).toBe(
      `[gateway-exit] redacted len=${CANARY.length + 1}`,
    );
    expect(redactUpstreamLine(CANARY)).toBe(`redacted len=${CANARY.length}`);
    expect(redactUpstreamLine("[gateway-ready]")).toBe("[gateway-ready]");
  });

  it("formatCommandInvokeLog 不含 args 正文", () => {
    const line = formatCommandInvokeLog({
      tag: "#0",
      name: "imagegen",
      argsLen: CANARY.length,
      sid: "01CODEXCMDLOGTEST000000000",
      extra: "fallback=$name",
    });
    expect(line).toContain("command.invoke");
    expect(line).toContain("name=imagegen");
    expect(line).toContain(`argsLen=${CANARY.length}`);
    expect(line).toContain("#0");
    expect(line).toContain("fallback=$name");
    expect(line).not.toContain(CANARY);
  });

  it("logContent 默认关；MACCHIATO_LOG_CONTENT=1 才输出", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logContent("probe", CANARY);
    expect(log).not.toHaveBeenCalled();
    process.env[LOG_CONTENT_ENV] = "1";
    logContent("probe", CANARY);
    expect(log.mock.calls.flat().join(" ")).toContain(CANARY);
    expect(log.mock.calls.flat().join(" ")).toContain(LOG_CONTENT_ENV);
  });

  it("textLen", () => {
    expect(textLen(CANARY)).toBe(CANARY.length);
    expect(textLen(null)).toBe(0);
  });
});
