/**
 * #983 防再漂（openclaw 側）：**真** mirror 造出來的加密實時條目必須能通過出站閘。
 *
 * 與 cc 那份同源同因：`origin`（#968）進了實時 E2E 條目，`LinkBClient` 的字段白名單沒跟上
 * → 整幀被丟、且當時那條分支不打日誌 → 加密會話「發了消息永遠沒有回覆」。這裡不手寫條目
 * 形狀（手寫會跟着白名單一起漂），驅動真 `pollOnce()` 拿它真發出去的那一幀來驗。
 */
import { describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptedMirrorSessionIssue } from "../src/_core/linkb/client";
import { Mirror } from "../src/openclaw/mirror";

const KEY = "agent:main:discord:channel:983";
const FILE_ID = "cccccccc-0000-4000-8000-00000000cccc";
const CIPHER = Buffer.alloc(48, 9).toString("base64"); // 過 looksLikeCiphertext

function line(text: string, i = 0): string {
  return (
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text }], timestamp: 1000 + i },
    }) + "\n"
  );
}

async function encryptedEntry(): Promise<Record<string, unknown>> {
  const stateDir = mkdtempSync(join(tmpdir(), "oc-983-"));
  process.env.MACCHIATO_OPENCLAW_MIRROR = join(stateDir, "mirror.json");
  process.env.OPENCLAW_STATE_DIR = join(stateDir, "openclaw");
  const dir = join(stateDir, "openclaw", "agents/main/sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${FILE_ID}.jsonl`);
  writeFileSync(file, line("加密提問"));
  writeFileSync(
    process.env.MACCHIATO_OPENCLAW_MIRROR,
    JSON.stringify({
      offsets: {},
      fileIds: { [KEY]: FILE_ID },
      fileIdAliases: { [KEY]: [FILE_ID] },
      aliasHistoryTrusted: true,
      pendingMirrors: [],
    }),
  );
  const sent: any[] = [];
  const linkb: any = { agentLinkId: "al-983", isReady: true, send: (m: any) => sent.push(m) };
  const gw: any = {
    sessionsList: async () => ({ sessions: [{ key: KEY, sessionId: FILE_ID, kind: "group" }] }),
  };
  const e2e: any = {
    isE2E: (id: string) => id === KEY,
    protectedSessionIds: () => [KEY],
    hasServerStateSnapshot: () => true,
    encryptText: () => CIPHER,
    encryptContent: () => CIPHER,
  };
  const mirror: any = new Mirror(gw, linkb, e2e);
  await mirror.pollOnce(); // 新 key 首輪只落 baseline
  appendFileSync(file, line("加密回覆", 1));
  await mirror.pollOnce();
  const appends = sent.filter((f) => f.t === "mirror_append");
  expect(appends.length).toBeGreaterThan(0);
  const session = appends.at(-1)!.sessions[0];
  expect(session.hermesSessionId).toBe(KEY);
  expect(session.e2e).toBe(true); // 確實走了加密分支
  return session;
}

describe("#983 openclaw 加密實時鏡像條目 × Link B 出站閘", () => {
  it("真 pollOnce() 發出的加密條目必須被出站閘放行", async () => {
    const session = await encryptedEntry();
    expect(session).toHaveProperty("origin"); // 前提沒退化：確實帶着當年撞牆的那個字段
    expect(encryptedMirrorSessionIssue(session)).toBeNull();
  });

  it("生產者自己省掉 origin.label：加密會話不把子 agent 名 / 路徑明文送出去", async () => {
    const session = (await encryptedEntry()) as any;
    expect(session.origin).not.toHaveProperty("label");
  });

  it("正文一個字都不明文出門", async () => {
    const session = await encryptedEntry();
    expect(JSON.stringify(session)).not.toContain("加密提問");
    expect(JSON.stringify(session)).not.toContain("加密回覆");
  });
});
