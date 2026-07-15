import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Projects, memHash } from "../src/codex/projects";

/** #227:register/mem_read/mem_write/registry + 安全紀律 + 回合末惰性版本化。 */

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "codex-proj-"));
  process.env.MACCHIATO_CODEX_PROJECTS = join(dir, "registry.json");
  const sent: any[] = [];
  const handlers: any[] = [];
  const linkb: any = {
    agentLinkId: "al1",
    isReady: true,
    send: (m: any) => sent.push(m),
    onFrame: (h: any) => {
      handlers.push(h);
      return () => {};
    },
  };
  const p = new Projects(linkb);
  p.wire();
  const op = (msg: any) => {
    handlers.forEach((h) => h({ t: "project_op", ...msg }));
    return sent.filter((m) => m.t === "project_op_result").at(-1);
  };
  return { p, sent, op, dir };
}

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "codex-proj-ws-"));
});

describe("#227 register", () => {
  it("已有目錄:回傳現存 AGENTS.md(沿用語義)、補 CLAUDE.md 墊片、入註冊表", () => {
    writeFileSync(join(workdir, "AGENTS.md"), "# 已有記憶");
    const { op } = setup();
    const r = op({ reqId: 1, op: "register", path: workdir });
    expect(r.ok).toBe(true);
    expect(r.existed).toBe(true);
    expect(r.agentsMd).toBe("# 已有記憶");
    expect(r.hash).toBe(memHash("# 已有記憶"));
    expect(r.wroteShim).toBe(true);
    expect(readFileSync(join(workdir, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  });

  it("無 AGENTS.md + 帶初始內容 → 寫入;已有 CLAUDE.md 絕不動", () => {
    writeFileSync(join(workdir, "CLAUDE.md"), "# 用戶自己的配置");
    const { op } = setup();
    const r = op({ reqId: 1, op: "register", path: workdir, agentsMd: "# 初始記憶" });
    expect(r.ok).toBe(true);
    expect(r.agentsMd).toBeNull();
    expect(readFileSync(join(workdir, "AGENTS.md"), "utf8")).toBe("# 初始記憶");
    expect(r.wroteShim).toBe(false);
    expect(readFileSync(join(workdir, "CLAUDE.md"), "utf8")).toBe("# 用戶自己的配置"); // 沒被踩
  });

  it("目錄不存在:默認拒;mkdir=true → 創建", () => {
    const { op } = setup();
    const missing = join(workdir, "new-proj");
    expect(op({ reqId: 1, op: "register", path: missing }).ok).toBe(false);
    const r = op({ reqId: 2, op: "register", path: missing, mkdir: true });
    expect(r.ok).toBe(true);
    expect(r.existed).toBe(false);
    expect(existsSync(missing)).toBe(true);
  });
});

describe("#227 mem 讀寫 + 安全紀律", () => {
  it("未備案路徑 → 拒(本地註冊表硬校驗,server 被攻破也指不動)", () => {
    const { op } = setup();
    expect(op({ reqId: 1, op: "mem_read", path: workdir }).ok).toBe(false);
    expect(op({ reqId: 2, op: "mem_write", path: workdir, content: "x" }).ok).toBe(false);
  });

  it("mem_read/mem_write 只碰 AGENTS.md;寫入原子且 hash 回傳", () => {
    const { op } = setup();
    op({ reqId: 1, op: "register", path: workdir });
    const w = op({ reqId: 2, op: "mem_write", path: workdir, content: "# v2" });
    expect(w.ok).toBe(true);
    expect(w.hash).toBe(memHash("# v2"));
    expect(readFileSync(join(workdir, "AGENTS.md"), "utf8")).toBe("# v2");
    const r = op({ reqId: 3, op: "mem_read", path: workdir });
    expect(r.agentsMd).toBe("# v2");
  });

  it("registry 對賬:全量替換;重啟後從本地文件恢復", () => {
    const { op } = setup();
    const dir2 = mkdtempSync(join(tmpdir(), "codex-proj-ws2-"));
    op({ reqId: 1, op: "registry", paths: [workdir, dir2] });
    expect(op({ reqId: 2, op: "mem_read", path: workdir }).ok).toBe(true);
    expect(op({ reqId: 3, op: "mem_read", path: dir2 }).ok).toBe(true);
    // 重啟(同 registry 文件)
    const sent2: any[] = [];
    const handlers2: any[] = [];
    const linkb2: any = { agentLinkId: "al1", isReady: true, send: (m: any) => sent2.push(m), onFrame: (h: any) => (handlers2.push(h), () => {}) };
    const p2 = new Projects(linkb2);
    p2.wire();
    handlers2.forEach((h) => h({ t: "project_op", reqId: 9, op: "mem_read", path: workdir }));
    expect(sent2.at(-1).ok).toBe(true);
  });
});

describe("#227 回合末惰性版本化", () => {
  it("備案後 agent 改了 AGENTS.md → checkTurnEnd 推 project_mem_changed;無變化不推;未定基線只定不推", () => {
    const { p, op, sent } = setup();
    writeFileSync(join(workdir, "AGENTS.md"), "v1");
    op({ reqId: 1, op: "register", path: workdir }); // 定基線 v1
    p.checkTurnEnd();
    expect(sent.filter((m) => m.t === "project_mem_changed")).toHaveLength(0); // 無變化
    writeFileSync(join(workdir, "AGENTS.md"), "v2(agent 回合裡寫的)");
    p.checkTurnEnd();
    const changed = sent.filter((m) => m.t === "project_mem_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0].path).toBe(workdir); // server 形路徑(server 按它歸屬 project)
    expect(changed[0].content).toBe("v2(agent 回合裡寫的)");
    p.checkTurnEnd();
    expect(sent.filter((m) => m.t === "project_mem_changed")).toHaveLength(1); // 去抖
  });
});

describe("#227 file 白名單(CLAUDE.md 修墊片)", () => {
  it("mem_read/write 可指名 CLAUDE.md;白名單外一律拒", () => {
    const { op } = setup();
    op({ reqId: 1, op: "register", path: workdir });
    const w = op({ reqId: 2, op: "mem_write", path: workdir, content: "@AGENTS.md\n# 用戶的", file: "CLAUDE.md" });
    expect(w.ok).toBe(true);
    expect(readFileSync(join(workdir, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n# 用戶的");
    const r = op({ reqId: 3, op: "mem_read", path: workdir, file: "CLAUDE.md" });
    expect(r.agentsMd).toBe("@AGENTS.md\n# 用戶的");
    expect(op({ reqId: 4, op: "mem_read", path: workdir, file: "secrets.json" }).ok).toBe(false);
    expect(op({ reqId: 5, op: "mem_write", path: workdir, content: "x", file: "../etc/passwd" }).ok).toBe(false);
  });
});
