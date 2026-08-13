import { describe, it, expect } from "vitest";
import {
  unwrapCodexErrorText,
  parseModelNeedsNewerCli,
  formatCodexTurnError,
  isCodexNativeBinMissing,
  humanizeCodexProbeError,
} from "../src/codex/turn-errors";

/** #692 真實 stderr 形狀（JS 包裝 spawn 原生 vendor 失敗）。 */
const NATIVE_ENOENT_STDERR = `Error: spawn
/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex ENOENT
at ChildProcess._handle.onexit (node:internal/child_process:286:19)
at onErrorNT (node:internal/child_process:484:16)
    at process.processTicksAndRejections (node:internal/process/task_queues:90:21)`;

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

  it("純 spawn ENOENT → 找不到命令 + 安裝指引", () => {
    const s = formatCodexTurnError("spawn codex ENOENT");
    expect(s).toMatch(/找不到 Codex/);
    expect(s).toMatch(/npm i -g @openai\/codex/);
    expect(s).not.toMatch(/原生二進制/);
    expect(formatCodexTurnError("spawn /usr/bin/codex ENOENT")).toMatch(/npm i -g @openai\/codex/);
  });

  it("#692 原生二進制缺失 → 安裝損壞 + 重裝命令，不甩堆棧", () => {
    const s = formatCodexTurnError(NATIVE_ENOENT_STDERR);
    expect(s).toMatch(/安裝損壞|原生二進制/);
    expect(s).toMatch(/npm install -g @openai\/codex/);
    // 絕不把 Node 堆棧 / 內部路徑甩給用戶
    expect(s).not.toMatch(/ChildProcess/);
    expect(s).not.toMatch(/_handle\.onexit/);
    expect(s).not.toMatch(/node:internal/);
    expect(s).not.toMatch(/ENOENT/);
    expect(s).not.toMatch(/opt\/homebrew/);
    expect(s).not.toMatch(/找不到 Codex 命令/); // 診斷不能是「命令不在」
  });

  it("#692 linux / win vendor 路徑同判", () => {
    expect(
      formatCodexTurnError(
        "Error: spawn /usr/lib/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex ENOENT",
      ),
    ).toMatch(/原生二進制/);
    expect(
      formatCodexTurnError(
        "Error: spawn C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe ENOENT",
      ),
    ).toMatch(/原生二進制/);
  });

  it("一般錯誤剝殼截斷", () => {
    const s = formatCodexTurnError({ detail: "something else broke" });
    expect(s).toContain("something else broke");
    expect(s).toMatch(/^❌ 回合失敗/);
  });
});

describe("isCodexNativeBinMissing / humanizeCodexProbeError", () => {
  it("識別 vendor 路徑", () => {
    expect(isCodexNativeBinMissing(NATIVE_ENOENT_STDERR)).toBe(true);
    expect(isCodexNativeBinMissing("spawn codex ENOENT")).toBe(false);
  });

  it("health 探測文案：無 ❌、含重裝命令", () => {
    const s = humanizeCodexProbeError(NATIVE_ENOENT_STDERR);
    expect(s).toMatch(/原生二進制|安裝損壞/);
    expect(s).toMatch(/npm install -g @openai\/codex/);
    expect(s).not.toMatch(/❌/);
    expect(s).not.toMatch(/ChildProcess/);
  });
});
