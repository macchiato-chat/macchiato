/**
 * #949 openclaw 會話血緣：gateway `sessions.list` 一行 → conversationId / kind / evidence。
 * 夾具形狀對齊 openclaw 2026.7.1-2 的 `buildGatewaySessionRow` 實際返回值（見 origin.ts 文件頭）。
 */
import { describe, expect, it } from "vitest";
import {
  isHiddenOrigin,
  isSubagentSessionKey,
  parseSessionOrigin,
  toThreadOrigin,
} from "../src/openclaw/origin";

describe("#949 parseSessionOrigin：頂層會話", () => {
  it("直聊 kind=direct → user/declared，歸屬自己", () => {
    const o = parseSessionOrigin({ key: "agent:main:discord:direct:42", kind: "direct" });
    expect(o).toMatchObject({
      threadId: "agent:main:discord:direct:42",
      conversationId: "agent:main:discord:direct:42",
      kind: "user",
      evidence: "declared",
    });
    expect(isHiddenOrigin(o)).toBe(false);
  });

  it("頻道 kind=group → user（Discord 頻道是真對話，不是執行單元）", () => {
    const o = parseSessionOrigin({ key: "agent:main:discord:channel:123", kind: "group" });
    expect(o.kind).toBe("user");
    expect(isHiddenOrigin(o)).toBe(false);
  });

  it("macchiato 自建會話（app 驅動）照樣是 user", () => {
    const o = parseSessionOrigin({ key: "agent:main:macchiato:01hxyz", kind: "direct" });
    expect(o.kind).toBe("user");
  });

  it("kind 缺席（老 gateway）→ user/absent，行為不倒退", () => {
    const o = parseSessionOrigin({ key: "agent:main:discord:direct:42" });
    expect(o).toMatchObject({ kind: "user", evidence: "absent" });
    expect(isHiddenOrigin(o)).toBe(false);
  });
});

describe("#949 parseSessionOrigin：子 agent 歸屬父會話", () => {
  it("有 parentSessionKey → declared，歸屬到聲明的父", () => {
    const o = parseSessionOrigin({
      key: "agent:main:subagent:9f1e-uuid",
      kind: "direct",
      parentSessionKey: "agent:main:discord:channel:123",
      subagentRole: "reviewer",
    });
    expect(o).toMatchObject({
      kind: "subagent",
      conversationId: "agent:main:discord:channel:123",
      parentThreadId: "agent:main:discord:channel:123",
      label: "reviewer",
      evidence: "declared",
    });
    expect(isHiddenOrigin(o)).toBe(true);
  });

  it("只有 spawnedBy 也算聲明", () => {
    const o = parseSessionOrigin({
      key: "agent:main:subagent:9f1e-uuid",
      spawnedBy: "agent:main:telegram:direct:7",
    });
    expect(o.conversationId).toBe("agent:main:telegram:direct:7");
    expect(o.evidence).toBe("declared");
  });

  it("沒有任何父聲明 → 回退到該 agent 的主會話，標 inferred（不是丟棄）", () => {
    const o = parseSessionOrigin({ key: "agent:worker7:subagent:abcd", kind: "direct" });
    expect(o).toMatchObject({
      kind: "subagent",
      conversationId: "agent:worker7:main",
      evidence: "inferred",
      reason: "key-shape:subagent",
    });
    expect(o.parentThreadId).toBeUndefined();
  });

  it("裸 subagent: 前綴（非 agent-scoped key）也認", () => {
    expect(isSubagentSessionKey("subagent:abcd")).toBe(true);
    expect(isSubagentSessionKey("agent:main:subagent:abcd")).toBe(true);
    expect(isSubagentSessionKey("agent:main:discord:channel:123")).toBe(false);
    expect(isSubagentSessionKey(undefined)).toBe(false);
    expect(parseSessionOrigin({ key: "subagent:abcd" }).kind).toBe("subagent");
  });

  it("key 形狀不透明、但 gateway 聲明了 spawnedBy → 一樣判成派生（對齊上游 spawn-child 優先序）", () => {
    const o = parseSessionOrigin({
      key: "agent:main:acp-opaque-7",
      kind: "direct",
      spawnedBy: "agent:main:discord:channel:123",
    });
    expect(o).toMatchObject({ kind: "subagent", conversationId: "agent:main:discord:channel:123" });
  });

  it("spawnedBy 指回自己（環）不改歸屬", () => {
    const key = "agent:main:discord:direct:42";
    const o = parseSessionOrigin({ key, kind: "direct", spawnedBy: key });
    expect(o).toMatchObject({ kind: "user", conversationId: key });
  });
});

describe("#949 parseSessionOrigin：cron / hook / node / 哨兵", () => {
  it.each([
    ["agent:main:cron:daily:run:1", "cron"],
    ["agent:main:hook:webhook:7", "hook"],
    ["agent:main:node:mac-mini:talk:9", "node"],
    ["agent:main:acp:bridge-1", "acp"],
    ["agent:main:acp-bridge:1", "acp"],
    ["agent:main:heartbeat", "heartbeat"],
  ])("%s → internal/%s，不進列表", (key, reason) => {
    const o = parseSessionOrigin({ key, kind: "direct" });
    expect(o).toMatchObject({ kind: "internal", reason });
    expect(isHiddenOrigin(o)).toBe(true);
  });

  it("哨兵 key global / unknown → internal", () => {
    for (const key of ["global", "unknown"]) {
      const o = parseSessionOrigin({ key, kind: "global" });
      expect(o).toMatchObject({ kind: "internal", reason: "sentinel" });
    }
  });

  it("cron 有父聲明時歸屬到父（仍不進列表）", () => {
    const o = parseSessionOrigin({
      key: "agent:main:cron:daily:run:1",
      parentSessionKey: "agent:main:discord:channel:123",
    });
    expect(o.conversationId).toBe("agent:main:discord:channel:123");
    expect(isHiddenOrigin(o)).toBe(true);
  });

  it("不誤傷：頻道名裡出現 cron/hook 字樣的普通會話", () => {
    // 老判據是 /:cron:/ 全串匹配，`discord:cron:…` 這種也會中；上游只認 rest 開頭。
    expect(parseSessionOrigin({ key: "agent:main:discord:channel:cron-news" }).kind).toBe("user");
    expect(parseSessionOrigin({ key: "agent:main:slack:group:hooks" }).kind).toBe("user");
  });
});

describe("#949 parseSessionOrigin：未知 kind fail-closed", () => {
  it("上游發明新 kind → 隔離 + 不建會話", () => {
    const o = parseSessionOrigin({ key: "agent:main:whatever:1", kind: "swarm" });
    expect(o).toMatchObject({
      kind: "internal",
      quarantined: true,
      reason: "unknown-kind:swarm",
      evidence: "declared",
    });
    expect(isHiddenOrigin(o)).toBe(true);
  });

  it("未知 ≠ 沒有：kind 為空串走 absent（維持現行行為）", () => {
    const o = parseSessionOrigin({ key: "agent:main:whatever:1", kind: "  " });
    expect(o).toMatchObject({ kind: "user", evidence: "absent" });
    expect(o.quarantined).toBeUndefined();
  });

  it("kind 不是字符串（協議漂移）→ 當缺席，不炸也不誤隔離", () => {
    expect(parseSessionOrigin({ key: "agent:main:x:1", kind: 7 }).evidence).toBe("absent");
    expect(parseSessionOrigin({ key: "agent:main:x:1", kind: { a: 1 } }).kind).toBe("user");
  });

  it("整行畸形（無 key）不拋", () => {
    expect(() => parseSessionOrigin({})).not.toThrow();
    expect(parseSessionOrigin({}).kind).toBe("user");
  });
});

describe("#968 toThreadOrigin：本地血緣 → 協議 ThreadOrigin", () => {
  const of = (row: Record<string, unknown>, wireId?: string) => {
    const parsed = parseSessionOrigin(row);
    return toThreadOrigin(parsed, wireId ?? parsed.threadId);
  };

  it("頂層會話 → root，歸屬自己", () => {
    const key = "agent:main:discord:channel:123";
    expect(of({ key, kind: "group" })).toEqual({
      threadId: key,
      conversationId: key,
      kind: "root",
      evidence: "declared",
    });
  });

  it("老 gateway（無 kind）→ root/absent：server 見 absent 一律走老行為", () => {
    expect(of({ key: "agent:main:discord:direct:42" })).toMatchObject({
      kind: "root",
      evidence: "absent",
    });
  });

  it("子 agent → derived，帶父與標籤", () => {
    expect(
      of({
        key: "agent:main:subagent:9f1e",
        kind: "direct",
        parentSessionKey: "agent:main:discord:channel:123",
        subagentRole: "reviewer",
      }),
    ).toEqual({
      threadId: "agent:main:subagent:9f1e",
      conversationId: "agent:main:discord:channel:123",
      parentThreadId: "agent:main:discord:channel:123",
      kind: "derived",
      label: "reviewer",
      evidence: "declared",
    });
  });

  it("cron / 哨兵 → derived（不另造字符串，免得把自家詞彙報成上游漂移）", () => {
    expect(of({ key: "agent:main:cron:daily:1", kind: "direct" })).toMatchObject({ kind: "derived" });
    expect(of({ key: "global", kind: "global" })).toMatchObject({ kind: "derived" });
  });

  it("未知 gateway kind → 原值加前綴上報：server 那條 fail-closed 正是要的", () => {
    expect(of({ key: "agent:main:whatever:1", kind: "swarm" })).toMatchObject({
      kind: "openclaw-kind:swarm",
      evidence: "declared",
    });
    // 前綴保證它永遠落不進 server 的已知值域，哪怕上游哪天真的發明了一個叫 root 的 kind。
    expect(of({ key: "agent:main:whatever:1", kind: "root" })).toMatchObject({
      kind: "openclaw-kind:root",
    });
  });

  it("driven 會話上報 server sid：threadId 必須跟上報身份走（不等則 server 整份退回老行為）", () => {
    expect(of({ key: "agent:main:macchiato:01hxyz", kind: "direct" }, "01HXYZ")).toEqual({
      threadId: "01HXYZ",
      conversationId: "01HXYZ",
      kind: "root",
      evidence: "declared",
    });
  });

  it("#985 本地仍隱藏派生，但 toThreadOrigin 已經據實（停過濾時 server 立刻收得到）", () => {
    const parsed = parseSessionOrigin({
      key: "agent:main:subagent:9f1e",
      parentSessionKey: "agent:main:discord:channel:123",
    });
    expect(isHiddenOrigin(parsed)).toBe(true);
    expect(toThreadOrigin(parsed, parsed.threadId).kind).toBe("derived");
  });
});
