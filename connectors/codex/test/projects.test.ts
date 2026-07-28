import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, symlinkSync, linkSync, unlinkSync, lstatSync, rmSync } from "node:fs";
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

  it("都無 AGENTS.md/CLAUDE.md + 帶初始內容 → 寫 AGENTS.md + 補墊片", () => {
    const { op } = setup();
    const r = op({ reqId: 1, op: "register", path: workdir, agentsMd: "# 初始記憶" });
    expect(r.ok).toBe(true);
    expect(r.agentsMd).toBeNull(); // 無現存
    expect(readFileSync(join(workdir, "AGENTS.md"), "utf8")).toBe("# 初始記憶");
    expect(r.wroteShim).toBe(true);
    expect(readFileSync(join(workdir, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  });

  it("只有 CLAUDE.md 無 AGENTS.md → 遷移:改名為 AGENTS.md + 重建一行墊片(內容無損)", () => {
    writeFileSync(join(workdir, "CLAUDE.md"), "# 這是項目指令(其實就是記憶)");
    const { op } = setup();
    const r = op({ reqId: 1, op: "register", path: workdir });
    expect(r.ok).toBe(true);
    expect(r.migratedClaudeToAgents).toBe(true);
    expect(r.agentsMd).toBe("# 這是項目指令(其實就是記憶)"); // 遷移後作現存記憶回傳
    expect(readFileSync(join(workdir, "AGENTS.md"), "utf8")).toBe("# 這是項目指令(其實就是記憶)");
    expect(readFileSync(join(workdir, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n"); // 重建的墊片
    expect(r.wroteShim).toBe(true);
  });

  it("CLAUDE.md 已是純墊片(無 AGENTS.md)→ 不遷移;帶初始內容寫 AGENTS.md", () => {
    writeFileSync(join(workdir, "CLAUDE.md"), "@AGENTS.md\n");
    const { op } = setup();
    const r = op({ reqId: 1, op: "register", path: workdir, agentsMd: "# 新記憶" });
    expect(r.ok).toBe(true);
    expect(r.migratedClaudeToAgents).toBe(false);
    expect(readFileSync(join(workdir, "AGENTS.md"), "utf8")).toBe("# 新記憶");
    expect(readFileSync(join(workdir, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n"); // 純墊片原樣
  });

  it("超過 MEM_MAX 的 CLAUDE.md → 拒絕 register,兩個文件原樣未動(絕不截斷丟數據)", () => {
    const big = `# 大記憶\n${"x".repeat(256 * 1024)}`; // > 256KB
    const cPath = join(workdir, "CLAUDE.md");
    writeFileSync(cPath, big);
    const { op } = setup();
    const r = op({ reqId: 1, op: "register", path: workdir });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("記憶上限");
    expect(readFileSync(cPath, "utf8")).toBe(big); // 原文件一字節未動(沒被覆蓋成墊片)
    expect(existsSync(join(workdir, "AGENTS.md"))).toBe(false); // 沒落過截斷版
    // 拒絕後未入註冊表 → 後續 mem 操作也拒
    expect(op({ reqId: 2, op: "mem_read", path: workdir }).ok).toBe(false);
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

  it("mem_write 上限按字節(不是 UTF-16 字符):非 ASCII 超字節上限 → 拒", () => {
    const { op } = setup();
    op({ reqId: 1, op: "register", path: workdir });
    const cjk = "中".repeat(100 * 1024); // 10 萬字符 < 256K 字符,但 300KB > 256KB 字節上限
    const w = op({ reqId: 2, op: "mem_write", path: workdir, content: cjk });
    expect(w.ok).toBe(false); // 舊實現按 content.length 擋 → 寫得進、讀回卻是截斷版
    expect(existsSync(join(workdir, "AGENTS.md"))).toBe(false); // 磁盤沒被寫過
    // 字節數在限內的同類內容照舊放行
    expect(op({ reqId: 3, op: "mem_write", path: workdir, content: "中".repeat(1024) }).ok).toBe(true);
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

describe("#378 符號連結:安全解析 + 包含性檢查(項目內照用、項目外拒)", () => {
  let secretDir: string;
  let secret: string;
  beforeEach(() => {
    secretDir = mkdtempSync(join(tmpdir(), "codex-secret-"));
    secret = join(secretDir, "id_rsa");
    writeFileSync(secret, "TOP-SECRET-KEY");
  });

  it("【正例】CLAUDE.md 是指向**項目內**文件的 symlink(dotfiles 常見)→ 備案/讀/寫全部照常,symlink 保留", () => {
    const { op } = setup();
    const store = join(workdir, ".dotfiles");
    mkdirSync(store);
    writeFileSync(join(store, "memory.md"), "# 我的項目記憶");
    symlinkSync(join(store, "memory.md"), join(workdir, "CLAUDE.md"));
    // (B) 遷移路徑:CLAUDE.md 的內容落到 AGENTS.md,原 symlink 被寫成一行墊片(寫穿到目標)
    const r = op({ reqId: 1, op: "register", path: workdir });
    expect(r.ok).toBe(true);
    expect(r.agentsMd).toBe("# 我的項目記憶");
    expect(lstatSync(join(workdir, "CLAUDE.md")).isSymbolicLink()).toBe(true); // symlink 沒被 rename 掉
    expect(readFileSync(join(store, "memory.md"), "utf8")).toBe("@AGENTS.md\n"); // 寫穿到項目內的真實文件
    // 讀寫仍走 symlink,內容一致
    expect(op({ reqId: 2, op: "mem_read", path: workdir, file: "CLAUDE.md" }).agentsMd).toBe("@AGENTS.md\n");
    expect(op({ reqId: 3, op: "mem_write", path: workdir, content: "@AGENTS.md\n# 附註", file: "CLAUDE.md" }).ok).toBe(true);
    expect(lstatSync(join(workdir, "CLAUDE.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(store, "memory.md"), "utf8")).toBe("@AGENTS.md\n# 附註");
  });

  it("【正例】AGENTS.md 是指向項目內文件的 symlink → mem_read/mem_write 讀寫的是目標文件", () => {
    const { op } = setup();
    const store = join(workdir, "shared");
    mkdirSync(store);
    writeFileSync(join(store, "AGENTS.md"), "# 共享記憶");
    symlinkSync(join(store, "AGENTS.md"), join(workdir, "AGENTS.md"));
    expect(op({ reqId: 1, op: "register", path: workdir }).agentsMd).toBe("# 共享記憶");
    expect(op({ reqId: 2, op: "mem_write", path: workdir, content: "# 新記憶" }).ok).toBe(true);
    expect(readFileSync(join(store, "AGENTS.md"), "utf8")).toBe("# 新記憶");
    expect(lstatSync(join(workdir, "AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(op({ reqId: 3, op: "mem_read", path: workdir }).agentsMd).toBe("# 新記憶");
  });

  it("register 時 AGENTS.md 的 symlink 指向**項目外** → 拒(不讀穿)", () => {
    const { op } = setup();
    symlinkSync(secret, join(workdir, "AGENTS.md"));
    const r = op({ reqId: 1, op: "register", path: workdir });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("項目目錄外");
    // 註冊表未收錄 → 後續 mem_read 也拒
    expect(op({ reqId: 2, op: "mem_read", path: workdir }).ok).toBe(false);
  });

  it("備案後 AGENTS.md 被換成指向項目外密鑰的 symlink → mem_read 拒,不洩漏內容", () => {
    const { op } = setup();
    writeFileSync(join(workdir, "AGENTS.md"), "# 正常記憶");
    expect(op({ reqId: 1, op: "register", path: workdir }).ok).toBe(true);
    unlinkSync(join(workdir, "AGENTS.md"));
    symlinkSync(secret, join(workdir, "AGENTS.md"));
    const r = op({ reqId: 2, op: "mem_read", path: workdir });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("TOP-SECRET-KEY");
  });

  it("mem_write 到指向項目外的 symlink → 拒;目標不被寫穿,symlink 也不被替換", () => {
    const { op } = setup();
    writeFileSync(join(workdir, "AGENTS.md"), "# 正常記憶");
    expect(op({ reqId: 1, op: "register", path: workdir }).ok).toBe(true);
    unlinkSync(join(workdir, "AGENTS.md"));
    symlinkSync(secret, join(workdir, "AGENTS.md"));
    const w = op({ reqId: 2, op: "mem_write", path: workdir, content: "evil-overwrite" });
    expect(w.ok).toBe(false);
    expect(String(w.error)).toContain("項目目錄外");
    expect(readFileSync(secret, "utf8")).toBe("TOP-SECRET-KEY"); // 未寫穿
    expect(lstatSync(join(workdir, "AGENTS.md")).isSymbolicLink()).toBe(true); // 用戶的 symlink 原樣還在
  });

  it("symlink 鏈先進項目內再逃逸到項目外 → realpath 到底後仍拒", () => {
    const { op } = setup();
    const hop = join(workdir, "hop");
    symlinkSync(secret, hop); // 項目內的中轉 symlink 指向項目外
    symlinkSync(hop, join(workdir, "AGENTS.md")); // AGENTS.md → hop → 項目外密鑰
    const r = op({ reqId: 1, op: "register", path: workdir });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("項目目錄外");
  });

  it("AGENTS.md 是斷鏈 symlink → 拒(給明確理由,不當作不存在)", () => {
    const { op } = setup();
    symlinkSync(join(workdir, "no-such-file"), join(workdir, "AGENTS.md"));
    const r = op({ reqId: 1, op: "register", path: workdir });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("斷開的符號連結");
  });

  it("AGENTS.md 是硬連結到密鑰 → mem_read 拒(nlink>1)", () => {
    const { op } = setup();
    writeFileSync(join(workdir, "AGENTS.md"), "# 正常記憶");
    expect(op({ reqId: 1, op: "register", path: workdir }).ok).toBe(true);
    unlinkSync(join(workdir, "AGENTS.md"));
    linkSync(secret, join(workdir, "AGENTS.md")); // 硬連結
    const r = op({ reqId: 2, op: "mem_read", path: workdir });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("TOP-SECRET-KEY");
  });

  it("超大 AGENTS.md 讀取按 MEM_MAX 截斷(先量後配,不 OOM)", () => {
    const { op } = setup();
    const big = "x".repeat(256 * 1024 + 5000);
    writeFileSync(join(workdir, "AGENTS.md"), big);
    expect(op({ reqId: 1, op: "register", path: workdir }).ok).toBe(true);
    const r = op({ reqId: 2, op: "mem_read", path: workdir });
    expect(r.ok).toBe(true);
    expect((r.agentsMd as string).length).toBe(256 * 1024);
  });

  it("備案目錄事後被換成指向他處的 symlink → mem 操作拒(dev/ino 身份重驗)", () => {
    const { op } = setup();
    expect(op({ reqId: 1, op: "register", path: workdir, agentsMd: "# m" }).ok).toBe(true);
    // 把備案目錄換成指向另一目錄的 symlink
    const other = mkdtempSync(join(tmpdir(), "codex-other-"));
    writeFileSync(join(other, "AGENTS.md"), "# 冒充");
    rmSync(workdir, { recursive: true, force: true });
    symlinkSync(other, workdir);
    expect(op({ reqId: 2, op: "mem_read", path: workdir }).ok).toBe(false);
    expect(op({ reqId: 3, op: "mem_write", path: workdir, content: "x" }).ok).toBe(false);
  });
});

describe("#498/F-14 ~/ 展開：server 形路徑作註冊表鍵、fs 走 $HOME", () => {
  it("register path=~/rel → 寫入 $HOME/rel；mem_read 仍用 ~/rel 鍵命中", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "codex-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const rel = `f14-tilde-${Date.now()}`;
      const serverPath = `~/${rel}`;
      const abs = join(fakeHome, rel);
      mkdirSync(abs, { recursive: true });
      writeFileSync(join(abs, "AGENTS.md"), "# tilde-mem");
      const { op } = setup();
      const r = op({ reqId: 1, op: "register", path: serverPath });
      expect(r.ok).toBe(true);
      expect(r.agentsMd).toBe("# tilde-mem");
      expect(existsSync(join(abs, "CLAUDE.md"))).toBe(true);
      expect(op({ reqId: 2, op: "mem_read", path: serverPath }).agentsMd).toBe("# tilde-mem");
      expect(op({ reqId: 3, op: "mem_read", path: abs }).ok).toBe(false);
      expect(op({ reqId: 4, op: "mem_write", path: serverPath, content: "# via-tilde" }).ok).toBe(true);
      expect(readFileSync(join(abs, "AGENTS.md"), "utf8")).toBe("# via-tilde");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});
