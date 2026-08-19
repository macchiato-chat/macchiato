/**
 * #947 會話血緣夾具：把「上游改了 transcript 形態」變成 CI 事件，而不是生產事件。
 *
 * 夾具形狀取自本機 545 個真實 transcript 的實測（2026-08-14，內容全部合成、不含真實對話）：
 *  - 子 agent 檔：行內 `isSidechain: true` / `agentId` / `sessionId = 父會話 id`
 *  - 續接檔（終端 `--resume` / rewind）：新開一個 `<uuid>.jsonl`，把父會話的行整段複製進去，
 *    **每行 sessionId 改寫成新檔自己的 id、uuid 原樣保留**
 *
 * 驗收（issue #947）：子 agent 檔 100% 歸位、續接 100% 接回父會話、主會話 0 誤傷。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Mirror, discoverSessions } from "../src/cc/mirror";
import { readTranscriptOrigin, resetLineageMemo } from "../src/cc/lineage";

let seq = 0;
const uuid = (): string => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
};

interface Line {
  uuid?: string;
  json: Record<string, unknown>;
}

function userLine(sid: string, text: string, parentUuid: string | null = null): Line {
  const u = uuid();
  return {
    uuid: u,
    json: {
      type: "user",
      uuid: u,
      parentUuid,
      sessionId: sid,
      cwd: "/w/proj",
      timestamp: "2026-08-14T10:00:00.000Z",
      message: { role: "user", content: text },
    },
  };
}

function assistantLine(sid: string, text: string): Line {
  const u = uuid();
  return {
    uuid: u,
    json: {
      type: "assistant",
      uuid: u,
      sessionId: sid,
      timestamp: "2026-08-14T10:00:01.000Z",
      message: { id: `msg-${u}`, role: "assistant", content: [{ type: "text", text }] },
    },
  };
}

/** CC 每輪 prompt 後寫的葉子指針行（帶 leafUuid，是續接指紋的第二個來源）。 */
function lastPromptLine(sid: string, leafUuid: string): Line {
  return { json: { type: "last-prompt", lastPrompt: "…", leafUuid, sessionId: sid } };
}

/** 頭部沒有 uuid 的雜項行（mode / permission-mode / file-history-snapshot），真檔裡總在最前面。 */
function preludeLines(sid: string): Line[] {
  return [
    { json: { type: "mode", mode: "default", sessionId: sid } },
    { json: { type: "permission-mode", permissionMode: "default", sessionId: sid } },
  ];
}

function subagentLines(parentSid: string, agentId: string): Line[] {
  const u1 = uuid();
  const u2 = uuid();
  return [
    {
      uuid: u1,
      json: {
        parentUuid: null,
        isSidechain: true,
        agentId,
        type: "user",
        uuid: u1,
        sessionId: parentSid, // ← CC 自己聲明的歸屬：父會話 id
        timestamp: "2026-08-14T10:00:02.000Z",
        message: { role: "user", content: "子 agent 內部指令" },
      },
    },
    {
      uuid: u2,
      json: {
        parentUuid: u1,
        isSidechain: true,
        agentId,
        type: "assistant",
        uuid: u2,
        sessionId: parentSid,
        timestamp: "2026-08-14T10:00:03.000Z",
        message: { id: `msg-${u2}`, role: "assistant", content: [{ type: "text", text: "子 agent 輸出" }] },
      },
    },
  ];
}

const render = (lines: Line[]): string => lines.map((l) => JSON.stringify(l.json)).join("\n") + "\n";

/** 續接：父檔的行整段複製，sessionId 改寫成新檔自己的 id、uuid 原樣保留（實測形態）。 */
function continuationOf(parentLines: Line[], childSid: string, keep = parentLines.length): Line[] {
  return parentLines.slice(0, keep).map((l) => ({
    uuid: l.uuid,
    json: { ...l.json, sessionId: childSid },
  }));
}

function newProjectsRoot(): string {
  const cfg = mkdtempSync(join(tmpdir(), "cc-lineage-"));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
  writeFileSync(process.env.MACCHIATO_CC_MIRROR, JSON.stringify({ offsets: {}, titles: {}, seeded: true }));
  const proj = join(cfg, "projects", "-home-x-proj");
  mkdirSync(proj, { recursive: true });
  resetLineageMemo();
  return proj;
}

function fakeLinkb(): { linkb: any; frames: Record<string, any>[] } {
  const frames: Record<string, any>[] = [];
  return {
    linkb: {
      agentLinkId: "AL1",
      isReady: true,
      send: (m: Record<string, unknown>) => frames.push(m as Record<string, any>),
      onFrame: () => () => {},
    },
    frames,
  };
}

const appends = (frames: Record<string, any>[]): Record<string, any>[] =>
  frames.filter((f) => f.t === "mirror_append");

beforeEach(() => {
  seq = 0;
});

describe("#947 血緣夾具（子 agent 100% 歸位 / 續接 100% 接回父 / 主會話 0 誤傷）", () => {
  it("合成語料集：12 條主會話 + 24 個子 agent 檔 + 4 條續接，三項驗收全綠", () => {
    const proj = newProjectsRoot();
    const mains: Array<{ sid: string; lines: Line[] }> = [];
    const subagentFiles: string[] = [];
    const continuations: Array<{ child: string; parent: string }> = [];

    for (let i = 0; i < 12; i++) {
      const sid = `1111${String(i).padStart(4, "0")}-0000-4000-8000-000000000000`;
      const body = [
        ...preludeLines(sid),
        userLine(sid, `主會話 ${i} 的第一句`),
        assistantLine(sid, "回答"),
      ];
      body.push(lastPromptLine(sid, body[2]!.uuid!));
      writeFileSync(join(proj, `${sid}.jsonl`), render(body));
      mains.push({ sid, lines: body });

      // 子 agent：一半走新形態（項目目錄頂層的 agent-*.jsonl，帶完整行內聲明），
      // 一半走「未來 CC 又換文件名」的形態（<uuid>.jsonl 但行內照樣聲明）——後者是本刀的重點：
      // 只認文件名的舊實現會把它當成一條新會話。
      const declaredAgentFile = join(proj, `agent-${String(i).padStart(4, "0")}aaaa.jsonl`);
      writeFileSync(declaredAgentFile, render(subagentLines(sid, `agent${i}a`)));
      subagentFiles.push(declaredAgentFile);
      const renamedAgentFile = join(proj, `2222${String(i).padStart(4, "0")}-0000-4000-8000-000000000000.jsonl`);
      writeFileSync(renamedAgentFile, render(subagentLines(sid, `agent${i}b`)));
      subagentFiles.push(renamedAgentFile);
    }

    // 續接：前 4 條主會話各被 `--resume` 一次（第 4 條是 rewind：只複製前半段）。
    mains.slice(0, 4).forEach((m, i) => {
      const child = `3333${String(i).padStart(4, "0")}-0000-4000-8000-000000000000`;
      const keep = i === 3 ? 3 : m.lines.length; // rewind = 截斷副本
      const lines = [...continuationOf(m.lines, child, keep), userLine(child, `續接後的新問題 ${i}`)];
      writeFileSync(join(proj, `${child}.jsonl`), render(lines));
      continuations.push({ child, parent: m.sid });
    });

    // ① 子 agent 100% 歸位：一個都不進發現列表，且都判為 subagent。
    for (const f of subagentFiles) {
      const origin = readTranscriptOrigin(f, basename(f, ".jsonl"));
      expect(origin.kind, f).toBe("subagent");
      expect(origin.evidence, f).toBe("declared");
    }
    const found = discoverSessions(join(proj, ".."));
    const foundSids = new Set(found.map((s) => s.sid));
    for (const f of subagentFiles) expect(foundSids.has(basename(f, ".jsonl")), f).toBe(false);
    expect(found).toHaveLength(mains.length + continuations.length);

    // ② 續接 100% 接回父會話；③ 主會話 0 誤傷。
    const { linkb } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).resolveNewOrigins(found);
    for (const { child, parent } of continuations) {
      expect((m as any).identitySid(child), child).toBe(parent);
    }
    for (const { sid } of mains) expect((m as any).identitySid(sid), sid).toBe(sid);
  });

  it("文件名兜底：沒有任何行內聲明的 agent-*.jsonl 仍判子 agent（evidence=inferred）", () => {
    const proj = newProjectsRoot();
    const sid = "44440000-0000-4000-8000-000000000000";
    const f = join(proj, "agent-legacy0001.jsonl");
    // 老形態：只有文件名，行裡什麼血緣都沒寫。
    writeFileSync(f, render([userLine(sid, "老版本子 agent 輸出")]));
    const origin = readTranscriptOrigin(f, "agent-legacy0001");
    expect(origin.kind).toBe("subagent");
    expect(origin.evidence).toBe("inferred");
    expect(discoverSessions(join(proj, "..")).map((s) => s.sid)).not.toContain("agent-legacy0001");
  });

  it("不誤傷：主會話裡內聯的 sidechain 洪流（老形態）不會讓整條會話消失", () => {
    const proj = newProjectsRoot();
    const sid = "55550000-0000-4000-8000-000000000000";
    const lines: Line[] = [...preludeLines(sid), userLine(sid, "真人開場")];
    for (let i = 0; i < 20; i++) {
      const u = uuid();
      lines.push({
        uuid: u,
        json: {
          type: "assistant",
          isSidechain: true,
          uuid: u,
          sessionId: sid,
          message: { id: `sub-${i}`, role: "assistant", content: [{ type: "text", text: "子流" }] },
        },
      });
    }
    writeFileSync(join(proj, `${sid}.jsonl`), render(lines));
    expect(readTranscriptOrigin(join(proj, `${sid}.jsonl`), sid).kind).toBe("user");
    expect(discoverSessions(join(proj, "..")).map((s) => s.sid)).toContain(sid);
  });

  it("根消息落在超大行之後（IDE 注入 480KB 上下文）也認得出續接", () => {
    const proj = newProjectsRoot();
    const parent = "66660000-0000-4000-8000-000000000000";
    const huge = "x".repeat(480 * 1024);
    const base = [...preludeLines(parent), userLine(parent, huge), assistantLine(parent, "回答")];
    writeFileSync(join(proj, `${parent}.jsonl`), render(base));
    const child = "66660001-0000-4000-8000-000000000000";
    writeFileSync(
      join(proj, `${child}.jsonl`),
      render([...continuationOf(base, child), userLine(child, "續接")]),
    );
    const { linkb } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).resolveNewOrigins(discoverSessions(join(proj, "..")));
    expect((m as any).identitySid(child)).toBe(parent);
  });
});

describe("#947 續接回流的鏡像行為", () => {
  it("終端 --resume 之後不再多出一條會話：新消息投進父會話的 hermesSessionId", () => {
    const proj = newProjectsRoot();
    const parent = "77770000-0000-4000-8000-000000000000";
    const base = [...preludeLines(parent), userLine(parent, "第一句"), assistantLine(parent, "回答")];
    writeFileSync(join(proj, `${parent}.jsonl`), render(base));

    const { linkb, frames } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();
    expect(appends(frames).map((f) => f.sessions[0].hermesSessionId)).toEqual([parent]);

    // 終端 `claude --resume`：新開一個檔，父會話歷史整段複製 + 一句新的。
    const child = "77770001-0000-4000-8000-000000000000";
    writeFileSync(
      join(proj, `${child}.jsonl`),
      render([...continuationOf(base, child), userLine(child, "續接後的新問題")]),
    );
    (m as any).doPoll();

    const sids = new Set(appends(frames).map((f) => f.sessions[0].hermesSessionId));
    expect([...sids]).toEqual([parent]); // ← 沒有第二條會話
    const texts = appends(frames).flatMap((f: any) => f.sessions[0].messages.map((x: any) => x.text));
    expect(texts).toContain("續接後的新問題");
    // 複製來的那段照樣帶原始 srcId（= transcript 行 uuid）→ server 端 (session_id, dedup_key)
    // 唯一索引直接吃掉，不會像今天那樣在另一條會話裡變成 1600 條重複消息。
    const copied = appends(frames)
      .flatMap((f: any) => f.sessions[0].messages)
      .filter((x: any) => x.text === "第一句");
    expect(new Set(copied.map((x: any) => x.srcId)).size).toBe(1);
  });

  it("rewind（截斷副本）同樣接回父會話，不另建", () => {
    const proj = newProjectsRoot();
    const parent = "88880000-0000-4000-8000-000000000000";
    const base = [
      ...preludeLines(parent),
      userLine(parent, "第一句"),
      assistantLine(parent, "回答一"),
      userLine(parent, "第二句"),
      assistantLine(parent, "回答二"),
    ];
    writeFileSync(join(proj, `${parent}.jsonl`), render(base));
    const { linkb, frames } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).doPoll();

    const child = "88880001-0000-4000-8000-000000000000";
    writeFileSync(
      join(proj, `${child}.jsonl`),
      render([...continuationOf(base, child, 4), userLine(child, "換個方向重問")]),
    );
    (m as any).doPoll();
    expect(new Set(appends(frames).map((f) => f.sessions[0].hermesSessionId))).toEqual(new Set([parent]));
  });

  // #967 起這條的判據換成了「別名歷史是否可信」：這裡的 keystore 替身連 protectedSessionIds
  // 都沒有 → `ThreadRegistry` 恆不可信 → 仍然維持舊身份（fail-closed）。放開後的正向用例在
  // `thread-origin.test.ts`。
  it("E2E 會話：別名歷史不可信就不改身份（K_S 按 hermesSessionId 存，改鍵 = #807 不可恢復）", () => {
    const proj = newProjectsRoot();
    const parent = "99990000-0000-4000-8000-000000000000";
    const base = [...preludeLines(parent), userLine(parent, "第一句"), assistantLine(parent, "回答")];
    writeFileSync(join(proj, `${parent}.jsonl`), render(base));
    const child = "99990001-0000-4000-8000-000000000000";
    writeFileSync(
      join(proj, `${child}.jsonl`),
      render([...continuationOf(base, child), userLine(child, "續接")]),
    );

    const { linkb } = fakeLinkb();
    const e2e: any = {
      isE2E: (sid: string) => sid === parent,
      encryptText: (_sid: string, t: string) => `enc:${t}`,
      encryptContent: () => "enc",
    };
    const m = new Mirror(linkb, e2e);
    (m as any).resolveNewOrigins(discoverSessions(join(proj, "..")));
    expect((m as any).identitySid(child)).toBe(child); // 保持現有身份，走老路徑
  });

  it("已經鏡像出去的檔不半路改投（存量重複留給清理工具，別讓用戶的對話當場消失）", () => {
    const proj = newProjectsRoot();
    const parent = "aaaa0000-0000-4000-8000-000000000000";
    const base = [...preludeLines(parent), userLine(parent, "第一句"), assistantLine(parent, "回答")];
    writeFileSync(join(proj, `${parent}.jsonl`), render(base));
    const child = "aaaa0001-0000-4000-8000-000000000000";
    writeFileSync(
      join(proj, `${child}.jsonl`),
      render([...continuationOf(base, child), userLine(child, "續接")]),
    );
    // 模擬升級前：child 早就以自己的身份建過會話（titles 有值）。
    writeFileSync(
      process.env.MACCHIATO_CC_MIRROR!,
      JSON.stringify({ offsets: { [child]: 0 }, titles: { [child]: "舊會話" }, seeded: true }),
    );
    const { linkb } = fakeLinkb();
    const m = new Mirror(linkb);
    (m as any).resolveNewOrigins(discoverSessions(join(proj, "..")));
    expect((m as any).identitySid(child)).toBe(child);
  });
});

// —— 本機真實 transcript 的血緣冒煙搬去了 `lineage-contract.test.ts`（#951）——
//
// 這裡原先掛的是 `describe.runIf(existsSync(projectsDir()))`，看起來「裝了 Claude Code 的機器
// 就會跑」，**實際一次都沒跑過**：#303 的 hermetic setup 把 `HOME` 整個重定向進沙箱（正是為了
// 「單測絕不碰開發者本機數據」），於是 `projectsDir()` 恆指向空沙箱、`runIf` 恆為假。
// 看起來有閘、實際永不響 —— 比沒有更糟。新版改成顯式路徑 opt-in：
//   `MACCHIATO_LINEAGE_LIVE_CC=~/.claude/projects pnpm --filter @macchiato/claude-code-connector test`
