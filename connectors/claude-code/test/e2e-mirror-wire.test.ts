/**
 * #983 防再漂：**真** mirror 造出來的加密實時條目，必須能通過出站閘。
 *
 * 這條測試存在的唯一理由是它當年沒有：`entry()` 在 #659（加 `cwd`）和 #973（加 `origin`）
 * 先後多帶了兩個字段，`LinkBClient` 那張白名單沒跟上 → 每一幀加密實時鏡像被整幀丟掉。
 * 症狀是「開了 E2E 之後發出去的消息永遠沒有回覆」——加密回合其實跑完了（agent 收到解密
 * 明文也回了），只是正文回不來：`sendE2ETurn` 早在 #348 就改成只走鏡像 WAL，鏡像一斷，
 * 加密會話就徹底啞了。CC 用戶自 2026-08-01 起裸奔兩週，因為日誌裡它和「agent 沒回」同形。
 *
 * 所以這裡**不手寫條目形狀**（手寫就會跟着白名單一起漂，白測）：驅動真的 `doPoll()`，
 * 把它真發出去的那一幀，喂給出站閘的判定函數。以後誰再給 `entry()` 加字段，這裡當場紅。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptedMirrorSessionIssue } from "../src/_core/linkb/client";
import { Mirror } from "../src/cc/mirror";

const WIRE = "01K0CC983E2EWIREGATE0000001";
const LOCAL = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CIPHER = Buffer.alloc(48, 7).toString("base64"); // 過 looksLikeCiphertext 的長度/字符集

function world(opts: { cwd?: string } = {}) {
  const cfg = mkdtempSync(join(tmpdir(), "cc-983-"));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.MACCHIATO_CC_MIRROR = join(cfg, "mirror-state.json");
  const dir = join(cfg, "projects", "-home-x");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${LOCAL}.jsonl`);
  // 真 CC transcript 每一行都帶 cwd —— 這正是 #659 之後線上必然踩中的那條路徑。
  const cwd = opts.cwd ?? "/w/proj";
  writeFileSync(
    file,
    JSON.stringify({
      type: "user", uuid: "u1", sessionId: LOCAL, cwd,
      timestamp: "2026-08-17T00:00:00Z", message: { role: "user", content: "加密提問" },
    }) + "\n" +
      JSON.stringify({
        type: "assistant", uuid: "a1", sessionId: LOCAL, cwd,
        timestamp: "2026-08-17T00:00:01Z",
        message: { id: "m1", role: "assistant", content: [{ type: "text", text: "加密回覆" }] },
      }) + "\n",
  );
  writeFileSync(
    process.env.MACCHIATO_CC_MIRROR,
    JSON.stringify({
      offsets: {}, titles: {}, seeded: true,
      origins: { [LOCAL]: { evidence: "declared" } },
    }),
  );
  const sent: any[] = [];
  const e2e: any = {
    isE2E: (sid: string) => sid === WIRE,
    encryptText: () => CIPHER,
    encryptContent: () => CIPHER,
    protectedSessionIds: () => [WIRE],
  };
  const m: any = new Mirror(
    { agentLinkId: "AL", isReady: true, send: (x: any) => sent.push(x), onFrame: () => () => {} } as any,
    e2e,
    (localSid: string) => (localSid === LOCAL ? WIRE : undefined), // wire↔local 映射已建立
    () => true,
  );
  return { m, sent };
}

function encryptedSessionFrom(sent: any[]): Record<string, unknown> {
  const appends = sent.filter((x) => x.t === "mirror_append");
  expect(appends).toHaveLength(1);
  const session = appends[0].sessions[0];
  expect(session.hermesSessionId).toBe(WIRE); // 確實走了加密分支，不是明文條目
  expect(session.e2e).toBe(true);
  return session;
}

describe("#983 加密實時鏡像條目 × Link B 出站閘", () => {
  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.MACCHIATO_CC_MIRROR;
  });

  it("真 doPoll() 發出的加密條目必須被出站閘放行（帶 cwd + origin 的完整形態）", () => {
    const { m, sent } = world();
    m.doPoll();
    const session = encryptedSessionFrom(sent);
    // 前提沒退化：這一幀確實同時帶着當年撞牆的兩個字段
    expect(session).toHaveProperty("cwd");
    expect(session).toHaveProperty("origin");
    expect(encryptedMirrorSessionIssue(session)).toBeNull();
  });

  it("正文一個字都不明文出門（閘放行 ≠ 放鬆密文要求）", () => {
    const { m, sent } = world();
    m.doPoll();
    const session = encryptedSessionFrom(sent) as any;
    expect(session.title).toBe(CIPHER);
    for (const msg of session.messages) {
      expect(msg.enc).toBe(CIPHER);
      expect(msg.text ?? "").toBe("");
      expect(msg.reasoning ?? "").toBe("");
    }
    expect(JSON.stringify(session)).not.toContain("加密提問");
    expect(JSON.stringify(session)).not.toContain("加密回覆");
  });

  it("血緣/文件夾是可選的：任一缺席都照樣放行（老連接器、拿不到 cwd 的會話）", () => {
    const { m, sent } = world();
    m.doPoll();
    const { origin: _o, cwd: _c, ...bare } = encryptedSessionFrom(sent) as any;
    expect(encryptedMirrorSessionIssue(bare)).toBeNull();
  });

  it("origin.label 是自由文本 → 加密會話上必須被攔（唯一能夾帶人話的口子）", () => {
    const { m, sent } = world();
    m.doPoll();
    const session = encryptedSessionFrom(sent) as any;
    const issue = encryptedMirrorSessionIssue({
      ...session,
      origin: { ...session.origin, label: "研究 用户的私密项目" },
    });
    expect(issue).toContain("label");
  });

  it("守衛本身有效：往條目裡塞一個未經審核的字段，必須紅並說出是哪個", () => {
    const { m, sent } = world();
    m.doPoll();
    const session = encryptedSessionFrom(sent);
    const issue = encryptedMirrorSessionIssue({ ...session, someNewField: "x" });
    expect(issue).toContain("someNewField");
  });
});
