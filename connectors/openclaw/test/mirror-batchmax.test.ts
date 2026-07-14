import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNewMessages, Mirror } from "../src/openclaw/mirror";

/** #152:batchMax——超大會話拆幀,newOffset 精確指向首條未消費消息,續讀不重不漏。 */

const msg = (i: number) =>
  JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `m${i}` }], timestamp: 1000 + i } }) + "\n";

describe("#152 readNewMessages maxMessages", () => {
  it("截斷到上限;續讀從截斷點繼續,不重不漏", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-bm-"));
    const file = join(dir, "s.jsonl");
    let body = "";
    for (let i = 0; i < 7; i++) body += msg(i);
    writeFileSync(file, body);
    const r1 = readNewMessages(file, 0, 3);
    expect(r1.messages.map((m) => m.text)).toEqual(["m0", "m1", "m2"]);
    const r2 = readNewMessages(file, r1.newOffset, 3);
    expect(r2.messages.map((m) => m.text)).toEqual(["m3", "m4", "m5"]);
    const r3 = readNewMessages(file, r2.newOffset, 3);
    expect(r3.messages.map((m) => m.text)).toEqual(["m6"]);
    const r4 = readNewMessages(file, r3.newOffset, 3);
    expect(r4.messages).toEqual([]);
  });
});

describe("#152 pollOnce 單會話單幀", () => {
  it("兩個會話 → 兩幀(各自 batchId/rewind);超限會話單幀 ≤BATCH_MAX", async () => {
    process.env.MACCHIATO_OPENCLAW_MIRROR = join(mkdtempSync(join(tmpdir(), "oc-bm2-")), "mirror.json");
    const stateDir = mkdtempSync(join(tmpdir(), "oc-bm3-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const dir = join(stateDir, "agents/main/sessions");
    mkdirSync(dir, { recursive: true });
    const mk = (id: string, n: number) => {
      let b = "";
      for (let i = 0; i < n; i++) b += msg(i);
      writeFileSync(join(dir, `${id}.jsonl`), b);
    };
    const idA = "aaaaaaaa-0000-4000-8000-000000000001";
    const idB = "bbbbbbbb-0000-4000-8000-000000000002";
    const sent: any[] = [];
    const linkb: any = { agentLinkId: "al", isReady: true, send: (m: any) => sent.push(m), onFrame: () => () => {} };
    const gw: any = {
      sessionsList: async () => ({
        sessions: [
          { key: "agent:main:discord:channel:a", sessionId: idA, displayName: "a", channel: "discord" },
          { key: "agent:main:discord:channel:b", sessionId: idB, displayName: "b", channel: "discord" },
        ],
      }),
    };
    writeFileSync(join(dir, `${idA}.jsonl`), "");
    writeFileSync(join(dir, `${idB}.jsonl`), "");
    const m = new Mirror(gw, linkb);
    await (m as any).pollOnce(); // 首見 baseline(空文件 → 0)
    mk(idA, 2);
    mk(idB, 3);
    await (m as any).pollOnce();
    const frames = sent.filter((f) => f.t === "mirror_append");
    expect(frames.length).toBe(2); // 單會話單幀
    expect(frames.map((f) => f.sessions.length)).toEqual([1, 1]);
    expect(new Set(frames.map((f) => f.batchId)).size).toBe(2); // 各自 batchId
  });
});

describe("#211 文件輪換偵測", () => {
  const msg2 = (i: number, text: string) =>
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: 2000 + i } }) + "\n";

  it("同 key 換 sessionId(gateway 升級)→ 水位線歸零重讀新文件,不再靜默卡死", async () => {
    process.env.MACCHIATO_OPENCLAW_MIRROR = join(mkdtempSync(join(tmpdir(), "oc-rot-")), "mirror.json");
    const stateDir = mkdtempSync(join(tmpdir(), "oc-rot2-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const dir = join(stateDir, "agents/main/sessions");
    mkdirSync(dir, { recursive: true });
    const key = "agent:main:discord:channel:42";
    const oldId = "aaaaaaaa-0000-4000-8000-000000000011";
    const newId = "bbbbbbbb-0000-4000-8000-000000000022";
    // 舊文件:大(水位線推到很後)
    let body = "";
    for (let i = 0; i < 20; i++) body += msg(i);
    writeFileSync(join(dir, `${oldId}.jsonl`), body);
    const sent: any[] = [];
    const linkb: any = { agentLinkId: "al", isReady: true, send: (m: any) => sent.push(m), onFrame: () => () => {} };
    let sid = oldId;
    const gw: any = { sessionsList: async () => ({ sessions: [{ key, sessionId: sid, displayName: "x", channel: "discord" }] }) };
    const m = new Mirror(gw, linkb);
    await (m as any).pollOnce(); // 首見 baseline 到舊文件末(offset 大)
    // 升級:同 key 換新 sessionId,新文件比舊水位線短
    sid = newId;
    writeFileSync(join(dir, `${newId}.jsonl`), msg2(0, "換文件後的新消息"));
    await (m as any).pollOnce(); // 修復前:offset>size → 永久跳過;修復後:偵測輪換歸零重讀
    const texts = sent
      .filter((f) => f.t === "mirror_append")
      .flatMap((f) => f.sessions)
      .flatMap((s: any) => s.messages)
      .map((x: any) => x.text);
    expect(texts).toContain("換文件後的新消息");
  });
});
