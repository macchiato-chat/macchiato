/**
 * #227 Projects:備案目錄的 project_op 處理 + 回合末惰性版本化。
 * 安全紀律(docs/projects.md):
 *  - mem 操作只服務**本地註冊表**裡的路徑——server 被攻破也指不動未備案目錄(硬校驗在用戶機器上);
 *  - 只碰目錄裡的 AGENTS.md 一個文件(#110 具名訪問,絕不做任意路徑讀寫);
 *  - 寫入原子(tmp+rename);路徑 canonicalize 防 ../ 與 symlink 把戲。
 * 註冊表雙形存儲:server 形(server 認的原始路徑,mem_changed 回報用)→ canonical 形(fs 操作用)。
 */
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LinkBClient } from "../linkb/client";

function regFile(): string {
  return process.env.MACCHIATO_CODEX_PROJECTS || join(homedir(), ".macchiato/codex-projects.json");
}
const SHIM = "@AGENTS.md\n";
const MEM_MAX = 256 * 1024;

export const memHash = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

function expand(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export class Projects {
  /** serverPath → canonicalPath。 */
  private reg = new Map<string, string>();
  /** canonicalPath → 上次已知 AGENTS.md hash(回合末比對)。 */
  private lastHash = new Map<string, string>();

  constructor(private readonly linkb: LinkBClient) {
    this.load();
  }

  wire(): void {
    this.linkb.onFrame((m) => {
      if (m.t === "project_op") this.handle(m as Record<string, unknown>);
    });
  }

  private canon(serverPath: string): string {
    return resolve(expand(serverPath));
  }

  private reply(reqId: unknown, body: Record<string, unknown>): void {
    this.linkb.send({ t: "project_op_result", reqId, ...body });
  }

  private handle(msg: Record<string, unknown>): void {
    const reqId = msg.reqId;
    try {
      switch (msg.op) {
        case "register":
          return this.reply(reqId, this.register(String(msg.path ?? ""), msg.mkdir === true, typeof msg.agentsMd === "string" ? msg.agentsMd : undefined));
        case "mem_read":
          return this.reply(reqId, this.memRead(String(msg.path ?? "")));
        case "mem_write":
          return this.reply(reqId, this.memWrite(String(msg.path ?? ""), typeof msg.content === "string" ? msg.content : null));
        case "registry":
          return this.reply(reqId, this.syncRegistry(Array.isArray(msg.paths) ? (msg.paths as string[]) : []));
        default:
          return this.reply(reqId, { ok: false, error: `未知 op:${String(msg.op)}` });
      }
    } catch (e) {
      this.reply(reqId, { ok: false, error: (e as Error).message.slice(0, 300) });
    }
  }

  private agentsPath(canon: string): string {
    return join(canon, "AGENTS.md");
  }

  private register(serverPath: string, mkdir: boolean, agentsMd?: string): Record<string, unknown> {
    if (!serverPath) return { ok: false, error: "缺 path" };
    const canon = this.canon(serverPath);
    const existed = existsSync(canon);
    if (!existed) {
      if (!mkdir) return { ok: false, error: `目錄不存在:${canon}(可勾選「自動創建」)` };
      mkdirSync(canon, { recursive: true });
    }
    if (!statSync(canon).isDirectory()) return { ok: false, error: `不是目錄:${canon}` };
    try {
      accessSync(canon, constants.W_OK);
    } catch {
      return { ok: false, error: `目錄不可寫:${canon}` };
    }
    // AGENTS.md:已有 → 回傳內容(沿用語義);沒有且帶初始內容 → 寫入。
    const ap = this.agentsPath(canon);
    let existing: string | null = null;
    if (existsSync(ap)) {
      existing = readFileSync(ap, "utf8").slice(0, MEM_MAX);
    } else if (agentsMd !== undefined) {
      this.atomicWrite(ap, agentsMd);
    }
    const content = existing ?? agentsMd ?? "";
    // CLAUDE.md 墊片:讓 CC 經 @import 讀 AGENTS.md;已有 CLAUDE.md 絕不動(別踩用戶配置)。
    const cp = join(canon, "CLAUDE.md");
    let wroteShim = false;
    if (!existsSync(cp)) {
      this.atomicWrite(cp, SHIM);
      wroteShim = true;
    }
    this.reg.set(serverPath, canon);
    this.lastHash.set(canon, memHash(content)); // 定基線:回合末只報備案後的變化
    this.save();
    console.log(`· #227 project 備案:${serverPath}${wroteShim ? "(+CLAUDE.md 墊片)" : ""}`);
    return { ok: true, existed, agentsMd: existing, hash: memHash(content), wroteShim };
  }

  private requireRegistered(serverPath: string): string {
    const canon = this.reg.get(serverPath);
    if (!canon) throw new Error("路徑未備案(本地註冊表硬校驗)");
    return canon;
  }

  private memRead(serverPath: string): Record<string, unknown> {
    const canon = this.requireRegistered(serverPath);
    const ap = this.agentsPath(canon);
    const content = existsSync(ap) ? readFileSync(ap, "utf8").slice(0, MEM_MAX) : "";
    this.lastHash.set(canon, memHash(content));
    return { ok: true, agentsMd: content, hash: memHash(content) };
  }

  private memWrite(serverPath: string, content: string | null): Record<string, unknown> {
    const canon = this.requireRegistered(serverPath);
    if (content === null || content.length > MEM_MAX) return { ok: false, error: "內容缺失或超限" };
    this.atomicWrite(this.agentsPath(canon), content);
    this.lastHash.set(canon, memHash(content));
    return { ok: true, hash: memHash(content) };
  }

  /** ready 後 server 全量下發對賬:替換本地註冊表(server 是 project 清單的權威)。 */
  private syncRegistry(paths: string[]): Record<string, unknown> {
    this.reg.clear();
    for (const p of paths) {
      try {
        this.reg.set(p, this.canon(p));
      } catch {
        /* 壞路徑跳過 */
      }
    }
    this.save();
    return { ok: true };
  }

  /**
   * 回合末惰性版本化:掃全部備案目錄(數量極少)的 AGENTS.md,hash 變了 → 推 project_mem_changed。
   * 未定基線的(重啟後首個回合)只定基線不推——重啟間隙的變化由面板打開時的穿透讀對賬兜住。
   */
  checkTurnEnd(): void {
    for (const [serverPath, canon] of this.reg) {
      try {
        const ap = this.agentsPath(canon);
        const content = existsSync(ap) ? readFileSync(ap, "utf8").slice(0, MEM_MAX) : "";
        const h = memHash(content);
        const prev = this.lastHash.get(canon);
        this.lastHash.set(canon, h);
        if (prev !== undefined && prev !== h) {
          this.linkb.send({ t: "project_mem_changed", agentLinkId: this.linkb.agentLinkId, path: serverPath, content, hash: h });
          console.log(`· #227 AGENTS.md 變更 → 落版本(${serverPath})`);
        }
      } catch {
        /* 單目錄壞不擋其餘 */
      }
    }
  }

  private atomicWrite(file: string, content: string): void {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, file);
  }

  private load(): void {
    try {
      const p = JSON.parse(readFileSync(regFile(), "utf8"));
      for (const sp of Array.isArray(p.paths) ? (p.paths as string[]) : []) {
        try {
          this.reg.set(sp, this.canon(sp));
        } catch {
          /* skip */
        }
      }
    } catch {
      /* 首次無文件 */
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(regFile()), { recursive: true });
      const tmp = `${regFile()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, paths: [...this.reg.keys()] }));
      renameSync(tmp, regFile());
    } catch (e) {
      console.error("[#227 projects registry save failed]", (e as Error).message);
    }
  }
}
