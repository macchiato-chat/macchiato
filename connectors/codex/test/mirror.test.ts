import { describe, expect, it } from "vitest";
import { deriveMeta, threadIdFromFile } from "../src/codex/mirror";

describe("codex mirror 派生", () => {
  it("threadIdFromFile:從 rollout 文件名提 uuid", () => {
    expect(threadIdFromFile("rollout-2026-07-12T10-24-56-019f53b6-7e07-7832-a070-39bb197a7062.jsonl")).toBe("019f53b6-7e07-7832-a070-39bb197a7062");
    expect(threadIdFromFile("notarollout.jsonl")).toBeUndefined();
  });

  it("deriveMeta:cwd 從 session_meta、標題從首條 user 消息截斷", () => {
    const content = [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/srv/demo/repo" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "帮我把温度曲线改成24小时滚动窗口顺便修时区" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "好" } }),
    ].join("\n");
    const m = deriveMeta(content);
    expect(m.cwd).toBe("/srv/demo/repo");
    expect(m.title).toBe("帮我把温度曲线改成24小时滚动窗口顺便修时区");
    expect(m.title.length).toBeLessThanOrEqual(56);
  });

  it("無 user 消息 → 標題回退 Codex", () => {
    expect(deriveMeta(JSON.stringify({ type: "session_meta", payload: {} })).title).toBe("Codex");
  });
});

describe("#6/#9 狀態文件兜底與裁剪", () => {
  it("#6 主文件損壞 → 從 .bak 恢復;#9 prune 消失超期才裁", async () => {
    const { Mirror } = await import("../src/codex/mirror");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const d = mkdtempSync(join(tmpdir(), "codex-state-"));
    process.env.MACCHIATO_CODEX_MIRROR = join(d, "mirror.json");
    const linkb: any = { agentLinkId: "AL", isReady: true, send: () => {}, onFrame: () => () => {} };
    const m1: any = new Mirror(linkb);
    m1.state = { offsets: { a: 9 }, ords: { a: 3 }, missingAt: {} };
    m1.save();
    m1.state = { offsets: { a: 12 }, ords: { a: 5 }, missingAt: {} };
    m1.save(); // 上一版落 .bak
    writeFileSync(join(d, "mirror.json"), "{corrupted");
    const m2: any = new Mirror(linkb);
    expect(m2.state.offsets.a).toBe(9); // #6:.bak 恢復
    expect(m2.state.ords.a).toBe(3);

    m2.state = {
      offsets: { live: 1, gone_old: 2, gone_new: 3 },
      ords: { live: 1, gone_old: 2 },
      missingAt: { gone_old: Date.now() - 8 * 24 * 3600 * 1000 },
    };
    m2.pruneState(new Set(["live"]));
    expect(Object.keys(m2.state.offsets).sort()).toEqual(["gone_new", "live"]);
    expect(m2.state.ords.gone_old).toBeUndefined(); // ords 同步清
    m2.pruneState(new Set(["live", "gone_new"]));
    expect(m2.state.missingAt.gone_new).toBeUndefined(); // 回歸即清
  });
});

describe("#161 墓碑", () => {
  it("tombstone 後 rollout 永不再撈;持久(load 白名單帶 tombstones)", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Mirror } = await import("../src/codex/mirror");
    const root = mkdtempSync(join(tmpdir(), "cx-tomb-"));
    process.env.MACCHIATO_CODEX_SESSIONS_DIR = join(root, "sessions");
    process.env.MACCHIATO_CODEX_MIRROR = join(root, "mirror.json");
    const tid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee61";
    const dir = join(root, "sessions", "2026", "07", "14");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `rollout-2026-07-14T00-00-00-${tid}.jsonl`);
    const line = (text: string) =>
      JSON.stringify({ timestamp: "2026-07-14T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: text } }) + "\n";
    writeFileSync(f, "");
    const sent: any[] = [];
    const linkb: any = { agentLinkId: "al", isReady: true, send: (m: any) => sent.push(m), onFrame: () => () => {} };
    const m = new Mirror(linkb);
    (m as any).pollOnce ? await (m as any).pollOnce() : (m as any).doPoll(); // baseline
    m.tombstone(tid);
    appendFileSync(f, line("刪後內容"));
    (m as any).pollOnce ? await (m as any).pollOnce() : (m as any).doPoll();
    expect(sent.filter((x) => x.t === "mirror_append")).toHaveLength(0);
    // 持久:新實例照樣跳
    const sent2: any[] = [];
    const m2 = new Mirror({ ...linkb, send: (x: any) => sent2.push(x) });
    (m2 as any).pollOnce ? await (m2 as any).pollOnce() : (m2 as any).doPoll();
    expect(sent2.filter((x) => x.t === "mirror_append")).toHaveLength(0);
  });
});
