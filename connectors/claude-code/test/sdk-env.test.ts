import { describe, expect, it } from "vitest";
import { CONNECTOR_VERSION } from "../src/linkb/proto";
import {
  MACCHIATO_ENTRYPOINT,
  SDK_PROGRAMMATIC_ENTRYPOINTS,
  sdkEnv,
} from "../src/cc/sdk-env";

describe("sdkEnv (#389 讓驅動的會話出現在終端 /resume)", () => {
  it("⚠️ 展開基礎環境——SDK 是整份替換子進程環境,漏了 PATH/HOME/認證就全丟", () => {
    const base = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/u",
      ANTHROPIC_API_KEY: "sk-test",
      SOME_UNRELATED: "keep-me",
    } as NodeJS.ProcessEnv;
    const env = sdkEnv(base);
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(env.SOME_UNRELATED).toBe("keep-me");
  });

  it("默認聲明 entrypoint=macchiato,且**不在** SDK 的 programmatic 黑名單裡", () => {
    const env = sdkEnv({} as NodeJS.ProcessEnv);
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe(MACCHIATO_ENTRYPOINT);
    // 回歸守衛:哪天有人把值改成 sdk-* 就等於重新隱身,這條會紅。
    expect(SDK_PROGRAMMATIC_ENTRYPOINTS as readonly string[]).not.toContain(
      env.CLAUDE_CODE_ENTRYPOINT,
    );
  });

  it("不冒充 cli——聲明的是獨立身份(同 claude-vscode 的做法)", () => {
    expect(sdkEnv({} as NodeJS.ProcessEnv).CLAUDE_CODE_ENTRYPOINT).not.toBe("cli");
  });

  it("設 CLAUDE_AGENT_SDK_CLIENT_APP 供上游識別(文檔化選項,進 User-Agent)", () => {
    expect(sdkEnv({} as NodeJS.ProcessEnv).CLAUDE_AGENT_SDK_CLIENT_APP).toBe(
      `macchiato/${CONNECTOR_VERSION}`,
    );
  });

  it("逃生門:MACCHIATO_CC_ENTRYPOINT 可退回舊行為,不用發版", () => {
    const env = sdkEnv({ MACCHIATO_CC_ENTRYPOINT: "sdk-ts" } as NodeJS.ProcessEnv);
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts");
  });

  it("**覆蓋** ambient CLAUDE_CODE_ENTRYPOINT——從 VSCode 終端/CC 會話裡啟動時它是 claude-vscode,沿用會誤標", () => {
    const env = sdkEnv({ CLAUDE_CODE_ENTRYPOINT: "claude-vscode" } as NodeJS.ProcessEnv);
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe(MACCHIATO_ENTRYPOINT);
  });

  it("ambient CLAUDE_AGENT_SDK_CLIENT_APP 同樣不沿用(身份由我們權威聲明)", () => {
    const env = sdkEnv({ CLAUDE_AGENT_SDK_CLIENT_APP: "someone-else/1.0" } as NodeJS.ProcessEnv);
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe(`macchiato/${CONNECTOR_VERSION}`);
  });

  it("不改動基礎環境對象本身(純函數)", () => {
    const base = { PATH: "/bin" } as NodeJS.ProcessEnv;
    sdkEnv(base);
    expect(base.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });
});
