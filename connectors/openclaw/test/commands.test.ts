import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandsReporter, toCommandInfos } from "../src/openclaw/commands";
import { Drive } from "../src/openclaw/drive";
import { MACCHIATO_PREFIX } from "../src/openclaw/mirror";

/** #199:skills.status 枚舉(篩 commandVisible)+ command.invoke → /skill 文本。 */

describe("#199 toCommandInfos", () => {
  it("只留 commandVisible===true;emoji 拼進描述;source 透傳;無名/隱藏丟棄", () => {
    const out = toCommandInfos([
      { name: "canvas", description: "畫布", emoji: "🖼️", source: "openclaw-extra", commandVisible: true },
      { name: "mac-only", description: "x", commandVisible: false }, // ineligible(如 macOS-only)
      { name: "no-flag", description: "x" }, // 缺標誌 = 不可手動調
      { name: "", commandVisible: true },
      { name: "bare", commandVisible: true },
    ]);
    expect(out).toEqual([
      { name: "canvas", description: "🖼️ 畫布", source: "openclaw-extra" },
      { name: "bare" },
    ]);
  });
});

describe("#199 CommandsReporter", () => {
  function fakes() {
    const sent: any[] = [];
    const connectedHandlers: Array<() => void> = [];
    const readyHandlers: Array<() => void> = [];
    let skillsResult: any = { skills: [{ name: "a", description: "1", commandVisible: true }] };
    const gw: any = {
      onConnected: (h: () => void) => connectedHandlers.push(h),
      request: async (method: string, params: any) => {
        expect(method).toBe("skills.status");
        expect(params.agentId).toBe("main");
        return skillsResult;
      },
    };
    const linkb: any = {
      agentLinkId: "al1",
      send: (m: any) => sent.push(m),
      onReady: (h: () => void) => readyHandlers.push(h),
    };
    return { gw, linkb, sent, fireConnected: () => connectedHandlers.forEach((h) => h()), fireReady: () => readyHandlers.forEach((h) => h()), setSkills: (s: any) => (skillsResult = s) };
  }

  it("start 即枚舉上報;ready 重發緩存;gateway 重連刷新(升級後 skill 集變)", async () => {
    const f = fakes();
    new CommandsReporter(f.gw, f.linkb).start();
    await new Promise((r) => setTimeout(r, 10));
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ t: "commands", agentLinkId: "al1", commands: [{ name: "a", description: "1" }] });
    f.fireReady(); // server 重啟 → 重發緩存,不再打 RPC
    expect(f.sent).toHaveLength(2);
    f.setSkills({ skills: [{ name: "b", commandVisible: true }] });
    f.fireConnected(); // gateway 重連 → 重新枚舉
    await new Promise((r) => setTimeout(r, 10));
    expect(f.sent[2].commands).toEqual([{ name: "b" }]);
  });

  it("skills.status 失敗 → 靜默(不發幀不拋);之後 ready 也不發空幀", async () => {
    const f = fakes();
    f.gw.request = async () => {
      throw new Error("scope denied");
    };
    new CommandsReporter(f.gw, f.linkb).start();
    await new Promise((r) => setTimeout(r, 10));
    f.fireReady();
    expect(f.sent).toHaveLength(0);
  });
});

describe("#199 command.invoke → /skill 文本", () => {
  function makeDrive() {
    process.env.MACCHIATO_OPENCLAW_TITLED = join(mkdtempSync(join(tmpdir(), "oc-cmd-")), "titled.json");
    process.env.MACCHIATO_OPENCLAW_DRIVE = join(mkdtempSync(join(tmpdir(), "oc-cmd-")), "drive.json");
    process.env.MACCHIATO_OPENCLAW_TITLE_MODE = "off";
    const calls: { method: string; params: any }[] = [];
    const gw: any = {
      onEvent: () => () => {},
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        return { status: "started" };
      },
    };
    const linkb: any = { agentLinkId: "al1", handlers: [] as any[], onFrame(h: any) { this.handlers.push(h); }, send: () => {}, async deliver(m: any) { for (const h of this.handlers) await h(m); } };
    const mirror: any = { setDriven: () => {}, fastForward: () => {} };
    const drive = new Drive(gw, linkb, mirror);
    drive.wire();
    return { drive, linkb, calls };
  }

  it("翻成 chat.send `/skill <name> [args]`;帶斜杠歸一;markDriven 照走", async () => {
    const { linkb, calls } = makeDrive();
    const sid = "01OCCMDSID0000000000000000";
    await linkb.deliver({ t: "tui", sessionId: sid, frame: { method: "command.invoke", params: { session_id: sid, command: "/canvas", args: "present http://x" } } });
    const send = calls.find((c) => c.method === "chat.send");
    expect(send?.params.message).toBe("/skill canvas present http://x");
    expect(send?.params.sessionKey).toBe((MACCHIATO_PREFIX + sid).toLowerCase());
  });

  it("空命令忽略;無 args 只發 /skill <name>", async () => {
    const { linkb, calls } = makeDrive();
    const sid = "01OCCMDSID0000000000000001";
    await linkb.deliver({ t: "tui", sessionId: sid, frame: { method: "command.invoke", params: { session_id: sid, command: "  " } } });
    expect(calls.filter((c) => c.method === "chat.send")).toHaveLength(0);
    await linkb.deliver({ t: "tui", sessionId: sid, frame: { method: "command.invoke", params: { session_id: sid, command: "weather" } } });
    expect(calls.find((c) => c.method === "chat.send")?.params.message).toBe("/skill weather");
  });
});
