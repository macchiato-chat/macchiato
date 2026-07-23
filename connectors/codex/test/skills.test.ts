import { describe, it, expect } from "vitest";
import { parseSkills, SkillsReporter } from "../src/codex/skills";

/** #317 codex skills 上報:skills/list → commands 幀(`/` 菜單數據源)+ name→path 調用索引。 */

describe("#317 parseSkills", () => {
  it("name/description(interface.shortDescription 優先)/scope→source;enabled=false 過濾;截 200;paths 索引", () => {
    const long = "很".repeat(300);
    const { commands, paths } = parseSkills([
      {
        cwd: "/w",
        skills: [
          {
            name: "imagegen",
            description: long,
            interface: { shortDescription: "生成或編輯圖片" },
            path: "/h/.codex/skills/.system/imagegen/SKILL.md",
            scope: "system",
            enabled: true,
          },
          { name: "my-skill", description: long, path: "/h/.codex/skills/my-skill/SKILL.md", scope: "user", enabled: true },
          { name: "disabled-one", description: "x", path: "/p", scope: "user", enabled: false },
          { description: "無名丟棄", path: "/p2" },
        ],
      },
    ]);
    expect(commands).toEqual([
      { name: "imagegen", description: "生成或編輯圖片", source: "system" },
      { name: "my-skill", description: long.slice(0, 200), source: "user" },
    ]);
    expect(paths.get("imagegen")).toBe("/h/.codex/skills/.system/imagegen/SKILL.md");
    expect(paths.has("disabled-one")).toBe(false);
  });
  it("多 cwd 同名取首見(去重)", () => {
    const { commands } = parseSkills([
      { cwd: "/a", skills: [{ name: "dup", path: "/a/SKILL.md", scope: "project" }] },
      { cwd: "/b", skills: [{ name: "dup", path: "/b/SKILL.md", scope: "project" }] },
    ]);
    expect(commands).toHaveLength(1);
  });
});

describe("#317 SkillsReporter", () => {
  function fakes(res?: any, throws = false) {
    const sent: any[] = [];
    const readyHandlers: Array<() => void> = [];
    let notif: ((m: string, p: any) => void) | undefined;
    let calls = 0;
    const linkb: any = { agentLinkId: "AL1", send: (m: any) => sent.push(m), onReady: (h: () => void) => (readyHandlers.push(h), () => {}) };
    const client: any = {
      request: async (m: string, p: any) => {
        expect(m).toBe("skills/list");
        expect(Array.isArray(p.cwds)).toBe(true);
        calls += 1;
        if (throws) throw new Error("x");
        return res;
      },
      onNotification: (h: (m: string, p: any) => void) => ((notif = h), () => {}),
    };
    return { linkb, sent, client, fireReady: () => readyHandlers.forEach((h) => h()), fireNotif: (m: string) => notif?.(m, {}), callCount: () => calls };
  }
  const DATA = { data: [{ cwd: "/w", skills: [{ name: "s1", path: "/p1", scope: "user", enabled: true }] }] };

  it("app-server:skills/list → commands 幀;ready 重發;pathFor 索引可查", async () => {
    const f = fakes(DATA);
    const r = new SkillsReporter(f.linkb, f.client);
    await r.start();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ t: "commands", agentLinkId: "AL1", commands: [{ name: "s1", source: "user" }] });
    expect(r.pathFor("s1")).toBe("/p1");
    f.fireReady();
    expect(f.sent).toHaveLength(2);
  });
  it("skills/changed → 去抖後重列重發(整份替換)", async () => {
    const f = fakes(DATA);
    await new SkillsReporter(f.linkb, f.client).start();
    f.fireNotif("skills/changed");
    f.fireNotif("skills/changed"); // 連發合併一次
    await new Promise((r) => setTimeout(r, 400));
    expect(f.callCount()).toBe(2); // 啟動 1 + 去抖後 1
    expect(f.sent).toHaveLength(2);
    f.fireNotif("其他通知"); // 不觸發
    await new Promise((r) => setTimeout(r, 350));
    expect(f.callCount()).toBe(2);
  });
  it("exec(無 client)→ 上報空清緩存;skills/list 拋 → 空上報不炸", async () => {
    const f1 = fakes();
    await new SkillsReporter(f1.linkb, undefined).start();
    expect(f1.sent[0].commands).toEqual([]);
    const f2 = fakes(undefined, true);
    await new SkillsReporter(f2.linkb, f2.client).start();
    expect(f2.sent[0].commands).toEqual([]);
  });
});
