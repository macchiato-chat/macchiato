/**
 * #227 Projects:備案目錄的 project_op 處理 + 回合末惰性版本化。
 * 安全紀律(docs/projects.md):
 *  - mem 操作只服務**本地註冊表**裡的路徑——server 被攻破也指不動未備案目錄(硬校驗在用戶機器上);
 *  - 只碰目錄裡的 AGENTS.md 一個文件(#110 具名訪問,絕不做任意路徑讀寫);
 *  - #378 文件原語抗 symlink/TOCTOU:目錄 realpath+dev/ino 釘身份、目標 O_NOFOLLOW+fstat、
 *    寫走隨機臨時名 O_EXCL(見 safe-fs.ts)。AGENTS.md/CLAUDE.md 是符號連結時**安全解析 + 包含性
 *    檢查**:目標仍在備案目錄樹內 → 照常讀寫(dotfiles 可用);指到目錄外 → 拒。
 * 註冊表雙形存儲:server 形(server 認的原始路徑,mem_changed 回報用)→ 可信目錄身份(fs 操作用)。
 */
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LinkBClient } from "../linkb/client";
import { type DirIdentity, dirIdentity, namedFileSize, namedKind, readNamedFile, writeNamedFileAtomic } from "./safe-fs";

function regFile(): string {
  return process.env.MACCHIATO_CC_PROJECTS || join(homedir(), ".macchiato/cc-projects.json");
}
const SHIM = "@AGENTS.md\n";
const MEM_MAX = 256 * 1024;

export const memHash = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

function expand(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export class Projects {
  /** serverPath → 可信目錄身份(#378:realpath+dev/ino 釘住,操作前重驗)。 */
  private reg = new Map<string, DirIdentity>();
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

  /** #378 server 形路徑 → 可信目錄身份(realpath+dev/ino;不存在/非目錄拋錯)。 */
  private identify(serverPath: string): DirIdentity {
    return dirIdentity(resolve(expand(serverPath)));
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
          return this.reply(reqId, this.memRead(String(msg.path ?? ""), msg.file));
        case "mem_write":
          return this.reply(reqId, this.memWrite(String(msg.path ?? ""), typeof msg.content === "string" ? msg.content : null, msg.file));
        case "registry":
          return this.reply(reqId, this.syncRegistry(Array.isArray(msg.paths) ? (msg.paths as string[]) : []));
        default:
          return this.reply(reqId, { ok: false, error: `未知 op:${String(msg.op)}` });
      }
    } catch (e) {
      this.reply(reqId, { ok: false, error: (e as Error).message.slice(0, 300) });
    }
  }

  /** #227 具名文件白名單:AGENTS.md(默認,記憶)| CLAUDE.md(修墊片用)。其餘一律拒。 */
  private static fileFor(file: unknown): "AGENTS.md" | "CLAUDE.md" {
    if (file === undefined || file === "AGENTS.md") return "AGENTS.md";
    if (file === "CLAUDE.md") return "CLAUDE.md";
    throw new Error(`文件不在白名單:${String(file)}`);
  }

  private register(serverPath: string, mkdir: boolean, agentsMd?: string): Record<string, unknown> {
    if (!serverPath) return { ok: false, error: "缺 path" };
    const canonRaw = resolve(expand(serverPath));
    const existed = existsSync(canonRaw);
    if (!existed) {
      if (!mkdir) return { ok: false, error: `目錄不存在:${canonRaw}(可勾選「自動創建」)` };
      mkdirSync(canonRaw, { recursive: true });
    }
    // #378 realpath + dev/ino 釘身份(擋目錄 symlink);非目錄拋錯 → 統一回不是目錄。
    let id: DirIdentity;
    try {
      id = this.identify(serverPath);
    } catch {
      return { ok: false, error: `不是目錄:${canonRaw}` };
    }
    try {
      accessSync(id.canon, constants.W_OK);
    } catch {
      return { ok: false, error: `目錄不可寫:${id.canon}` };
    }
    // #378 符號連結:解析到項目樹內的真實文件 → 當常規文件照常用(dotfiles 用 symlink 管 CLAUDE.md
    // 的用戶不受影響);指到項目目錄外(或斷鏈)→ namedKind 拋錯,由 handle() 統一回 {ok:false,error}。
    const aKind = namedKind(id, "AGENTS.md");
    const cKind = namedKind(id, "CLAUDE.md");
    // AGENTS.md/CLAUDE.md 三態:
    //  (A) 已有 AGENTS.md → 回傳內容(沿用語義);缺 CLAUDE.md 補墊片。
    //  (B) 只有 CLAUDE.md 無 AGENTS.md → **遷移**:CLAUDE.md 內容即項目記憶,寫進 AGENTS.md,
    //      再重建一行墊片 CLAUDE.md(#378:改用兩步 symlink 安全原子寫,不再裸 rename);
    //      **超過 MEM_MAX 則整體拒絕備案**(寧可不備案,也不能截斷丟用戶內容)。
    //  (C) 都沒有 / CLAUDE.md 已是純墊片 → 帶初始內容則寫 AGENTS.md;缺墊片補墊片。
    let existing: string | null = null;
    let wroteShim = false;
    let migrated = false;
    if (aKind === "file") {
      existing = readNamedFile(id, "AGENTS.md", MEM_MAX);
      if (cKind === "absent") {
        writeNamedFileAtomic(id, "CLAUDE.md", SHIM);
        wroteShim = true;
      }
    } else if (cKind === "file") {
      // 超限的 CLAUDE.md 絕不能遷移:照讀會拿到**截斷版**,落進 AGENTS.md 後原文件被覆蓋成一行墊片,
      // 超出 MEM_MAX 的部分永久丟。故先量大小,超限 → 拒絕備案,磁盤一個字節都不動。
      const cSize = namedFileSize(id, "CLAUDE.md") ?? 0;
      if (cSize > MEM_MAX) {
        return { ok: false, error: `CLAUDE.md 超過 ${MEM_MAX / 1024}KB 記憶上限(${cSize} 字節),為避免截斷丟失內容已拒絕遷移;請先精簡 CLAUDE.md 再備案` };
      }
      const cContent = readNamedFile(id, "CLAUDE.md", MEM_MAX) ?? "";
      if (cContent.trim() !== "@AGENTS.md") {
        writeNamedFileAtomic(id, "AGENTS.md", cContent); // (B) 內容落 AGENTS.md
        writeNamedFileAtomic(id, "CLAUDE.md", SHIM); // 重建一行墊片
        existing = cContent;
        wroteShim = true;
        migrated = true;
      } else if (agentsMd !== undefined) {
        writeNamedFileAtomic(id, "AGENTS.md", agentsMd); // CLAUDE.md 已是純墊片
      }
    } else {
      if (agentsMd !== undefined) writeNamedFileAtomic(id, "AGENTS.md", agentsMd);
      writeNamedFileAtomic(id, "CLAUDE.md", SHIM);
      wroteShim = true;
    }
    const content = existing ?? agentsMd ?? "";
    this.reg.set(serverPath, id);
    this.lastHash.set(id.canon, memHash(content)); // 定基線:回合末只報備案後的變化
    this.save();
    console.log(`· #227 project 備案:${serverPath}${migrated ? "(CLAUDE.md→AGENTS.md 遷移)" : wroteShim ? "(+CLAUDE.md 墊片)" : ""}`);
    return { ok: true, existed, agentsMd: existing, hash: memHash(content), wroteShim, migratedClaudeToAgents: migrated };
  }

  private requireRegistered(serverPath: string): DirIdentity {
    const id = this.reg.get(serverPath);
    if (!id) throw new Error("路徑未備案(本地註冊表硬校驗)");
    return id;
  }

  private memRead(serverPath: string, file?: unknown): Record<string, unknown> {
    const id = this.requireRegistered(serverPath);
    const name = Projects.fileFor(file);
    const content = readNamedFile(id, name, MEM_MAX) ?? "";
    if (name === "AGENTS.md") this.lastHash.set(id.canon, memHash(content));
    return { ok: true, agentsMd: content, hash: memHash(content) };
  }

  private memWrite(serverPath: string, content: string | null, file?: unknown): Record<string, unknown> {
    const id = this.requireRegistered(serverPath);
    const name = Projects.fileFor(file);
    // 上限一律按**字節**量:讀路徑(readNamedFile)按字節截,寫路徑若按 UTF-16 字符數擋,
    // 非 ASCII 內容會出現「寫得進、讀回是截斷版、回合末 hash 一變就用截斷版覆蓋 server」的丟數據循環。
    if (content === null || Buffer.byteLength(content, "utf8") > MEM_MAX) return { ok: false, error: "內容缺失或超限" };
    writeNamedFileAtomic(id, name, content);
    if (name === "AGENTS.md") this.lastHash.set(id.canon, memHash(content));
    return { ok: true, hash: memHash(content) };
  }

  /** ready 後 server 全量下發對賬:替換本地註冊表(server 是 project 清單的權威)。 */
  private syncRegistry(paths: string[]): Record<string, unknown> {
    this.reg.clear();
    for (const p of paths) {
      try {
        this.reg.set(p, this.identify(p));
      } catch {
        /* 壞路徑/不存在跳過(重現後由 server 再次下發) */
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
    for (const [serverPath, id] of this.reg) {
      try {
        const content = readNamedFile(id, "AGENTS.md", MEM_MAX) ?? "";
        const h = memHash(content);
        const prev = this.lastHash.get(id.canon);
        this.lastHash.set(id.canon, h);
        if (prev !== undefined && prev !== h) {
          this.linkb.send({ t: "project_mem_changed", agentLinkId: this.linkb.agentLinkId, path: serverPath, content, hash: h });
          console.log(`· #227 AGENTS.md 變更 → 落版本(${serverPath})`);
        }
      } catch {
        /* 單目錄壞(含 symlink 掉包/身份變)不擋其餘 */
      }
    }
  }

  private load(): void {
    try {
      const p = JSON.parse(readFileSync(regFile(), "utf8"));
      for (const sp of Array.isArray(p.paths) ? (p.paths as string[]) : []) {
        try {
          this.reg.set(sp, this.identify(sp));
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
