import { KIND } from "../src/identity";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { resolveCwd, defaultWorkDir } from "../src/_core/cwd";

/**
 * #392 cwd 校驗:**默認仍是 HOME**(不動用戶路徑);顯式下發的 cwd 才做 realpath/存在性/目錄 +
 * 可選 allowlist 的硬校驗,fail closed。
 */

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "cc-cwd-"));
  delete process.env.MACCHIATO_CC_WORKDIR;
  delete process.env.MACCHIATO_CC_ALLOWED_ROOTS;
});
afterEach(() => {
  delete process.env.MACCHIATO_CC_WORKDIR;
  delete process.env.MACCHIATO_CC_ALLOWED_ROOTS;
});

describe("默認工作目錄 = HOME(本機操作者說了算,連接器不替用戶改路徑)", () => {
  it("空 cwd / undefined → HOME,ok", () => {
    const r = resolveCwd(KIND, "");
    expect(r.ok).toBe(true);
    expect(r.cwd).toBe(homedir());
    expect(defaultWorkDir(KIND)).toBe(homedir());
    expect(resolveCwd(KIND, undefined).cwd).toBe(homedir());
  });
  it("MACCHIATO_CC_WORKDIR 覆蓋默認", () => {
    process.env.MACCHIATO_CC_WORKDIR = ws;
    expect(resolveCwd(KIND, "").cwd).toBe(ws);
  });
  it("默認目錄**原樣返回、不 realpath**(HOME 是 symlink 的機器上不改寫路徑/不搬 transcript slug)", () => {
    const real = join(ws, "real");
    mkdirSync(real);
    const link = join(ws, "link"); // link → real,realpath 後是另一個路徑
    symlinkSync(real, link);
    process.env.MACCHIATO_CC_WORKDIR = link;
    expect(resolveCwd(KIND, "").cwd).toBe(link);
  });
  it("默認目錄不存在(env 打錯字)→ fail closed 並給明確提示", () => {
    process.env.MACCHIATO_CC_WORKDIR = join(ws, "nope");
    const r = resolveCwd(KIND, "");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("不存在");
  });
});

describe("顯式下發的 cwd:realpath / 存在性 / 目錄校驗", () => {
  it("不存在的目錄 → fail closed", () => {
    const r = resolveCwd(KIND, join(ws, "nope"));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("不存在");
  });
  it("是文件不是目錄 → fail closed", () => {
    const f = join(ws, "file.txt");
    writeFileSync(f, "x");
    const r = resolveCwd(KIND, f);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("不是目錄");
  });
  it("合法目錄 → ok,回 realpath 規範路徑", () => {
    const d = join(ws, "proj");
    mkdirSync(d);
    const r = resolveCwd(KIND, d);
    expect(r.ok).toBe(true);
    expect(r.cwd).toBe(realpathSync(d));
  });
  it("~ 展開為 HOME(#105 語義保留)", () => {
    expect(resolveCwd(KIND, "~").cwd).toBe(realpathSync(homedir()));
  });
});

describe("allowlist(MACCHIATO_CC_ALLOWED_ROOTS 配置後才生效,只約束顯式 cwd)", () => {
  let root: string;
  let inside: string;
  let outside: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cc-root-"));
    inside = join(root, "proj");
    mkdirSync(inside);
    outside = mkdtempSync(join(tmpdir(), "cc-out-"));
    process.env.MACCHIATO_CC_ALLOWED_ROOTS = root;
  });

  it("允許根內 → ok", () => {
    expect(resolveCwd(KIND, inside).ok).toBe(true);
  });
  it("允許根外(兄弟目錄)→ 拒", () => {
    const r = resolveCwd(KIND, outside);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("允許根");
  });
  it("HOME → 拒(未授權)", () => {
    expect(resolveCwd(KIND, homedir()).ok).toBe(false);
  });
  it("~/.. (根的父目錄)→ 拒", () => {
    expect(resolveCwd(KIND, join(root, "..")).ok).toBe(false);
  });
  it("symlink 逃逸到根外 → realpath 後拒", () => {
    const escape = join(root, "escape");
    symlinkSync(outside, escape); // 根內的 symlink 指向根外
    const r = resolveCwd(KIND, escape);
    expect(r.ok).toBe(false);
  });
  it("symlink 指回根內 → realpath 後 ok", () => {
    const link = join(outside, "into-root");
    symlinkSync(inside, link); // 根外的 symlink 指向根內
    expect(resolveCwd(KIND, link).ok).toBe(true);
  });
  it("**不下發 cwd 的會話不受 allowlist 約束**(默認目錄是本機操作者的選擇,不是 server 的)", () => {
    const r = resolveCwd(KIND, ""); // HOME 不在 root 內
    expect(r.ok).toBe(true);
    expect(r.cwd).toBe(homedir());
  });
  it("前綴不算在內:/root-x 不在 /root 內(邊界安全)", () => {
    const sibling = `${root}-x`;
    mkdirSync(sibling);
    expect(resolveCwd(KIND, sibling).ok).toBe(false);
  });
});

describe("allowlist 全部根不可用(盤沒掛/路徑打錯)→ 收緊而非放開", () => {
  it("顯式 cwd 一律拒(絕不退化成不限根),reason 指明根不可用", () => {
    const real = mkdtempSync(join(tmpdir(), "cc-real-"));
    process.env.MACCHIATO_CC_ALLOWED_ROOTS = `${join(ws, "no-such-root")}:${join(ws, "gone")}`;
    const r = resolveCwd(KIND, real); // 這個目錄真實存在,fail-open 實現會放行
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("允許根均不可用");
  });
  it("不下發 cwd 仍可用(安全配置壞掉不至於讓連接器整個不能跑)", () => {
    process.env.MACCHIATO_CC_ALLOWED_ROOTS = join(ws, "no-such-root");
    expect(resolveCwd(KIND, "").ok).toBe(true);
  });
  it("部分根壞:好根內仍放行、壞根不影響判定", () => {
    const good = mkdtempSync(join(tmpdir(), "cc-good-"));
    const inside = join(good, "proj");
    mkdirSync(inside);
    process.env.MACCHIATO_CC_ALLOWED_ROOTS = `${join(ws, "no-such-root")}:${good}`;
    expect(resolveCwd(KIND, inside).ok).toBe(true);
  });
  it("只寫分隔符/空白 = 等同沒配 → 不限根", () => {
    const any = mkdtempSync(join(tmpdir(), "cc-any-"));
    process.env.MACCHIATO_CC_ALLOWED_ROOTS = " : : ";
    expect(resolveCwd(KIND, any).ok).toBe(true);
  });
});
