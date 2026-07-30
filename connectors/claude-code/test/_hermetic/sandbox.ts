/**
 * #303 臨時檔 + HOME 沙箱。
 * 對齊各連接器歷史 setup（#453 tmpfs 泄漏 / 2026-07-12 真憑證被覆蓋事故）與
 * hermes-connector/tests/conftest.py 的 HOME 重定向。
 *
 * 關鍵：必須在連接器模塊 import 前改 HOME，否則 `join(homedir(), ".macchiato/…")`
 * 在模塊頂層凍結的常量會鎖死到真路徑。vitest setupFiles 滿足這一點。
 */
import { afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type HermeticSandbox = {
  /** 改寫前的真實 HOME（宿主用戶家目錄）。 */
  realHome: string;
  /** 本 worker 的假 HOME（在 sandboxRoot 下）。 */
  sandboxHome: string;
  /** 臨時檔根（TMPDIR 指向此處）。 */
  sandboxRoot: string;
};

let active: HermeticSandbox | null = null;

const drop = (dir: string) => {
  // 子進程可能仍持有檔案句柄;刪不掉就算了,殘留由下一輪的自愈掃除兜底。
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

/**
 * 建立 HOME + TMPDIR 沙箱並掛到 process.env。
 * 可重複調用：已啟動則返回現有句柄（同一 vitest worker 只建一次）。
 */
export function installHermeticSandbox(): HermeticSandbox {
  if (active) return active;

  // 必須在覆蓋 HOME/TMPDIR 之前取真實值。
  const realHome =
    process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH || tmpdir();
  const REAL_TMP = tmpdir();
  const sandboxRoot = mkdtempSync(join(REAL_TMP, "mc-test-"));
  process.env.TMPDIR = sandboxRoot;
  process.env.TMP = sandboxRoot; // Windows
  process.env.TEMP = sandboxRoot;

  const sandboxHome = join(sandboxRoot, "home");
  mkdirSync(sandboxHome, { recursive: true });
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome; // Windows 兜底

  active = { realHome, sandboxHome, sandboxRoot };

  afterAll(() => {
    drop(sandboxRoot);
    if (active?.sandboxRoot === sandboxRoot) active = null;
  });

  // 自愈掃除:transform/collect 失敗時 afterAll 不跑,vitest 強殺 worker——
  // 掃掉同前綴、超過 2 小時的舊沙箱(遠長於一輪測試,不誤傷並行)。
  const STALE_MS = 2 * 60 * 60 * 1000;
  try {
    for (const name of readdirSync(REAL_TMP)) {
      if (!name.startsWith("mc-test-")) continue;
      const path = join(REAL_TMP, name);
      if (path === sandboxRoot) continue;
      if (Date.now() - statSync(path).mtimeMs > STALE_MS) drop(path);
    }
  } catch {
    /* 掃不動就算了,不該讓清理失敗影響測試 */
  }

  return active;
}

export function getHermeticSandbox(): HermeticSandbox | null {
  return active;
}

export function getRealHome(): string {
  if (!active) {
    // 不寫死包名:本文件會被 sync-public vendored 進公開樹(test/_hermetic/),那裡沒有
    // @macchiato/* 這個說法,照抄包名的錯誤消息只會把人指向不存在的東西。
    throw new Error("hermetic sandbox not installed — vitest setupFiles must import the hermetic setup first");
  }
  return active.realHome;
}

export function getSandboxHome(): string {
  if (!active) {
    // 不寫死包名:本文件會被 sync-public vendored 進公開樹(test/_hermetic/),那裡沒有
    // @macchiato/* 這個說法,照抄包名的錯誤消息只會把人指向不存在的東西。
    throw new Error("hermetic sandbox not installed — vitest setupFiles must import the hermetic setup first");
  }
  return active.sandboxHome;
}

/** 斷言路徑落在假 HOME / 沙箱根下（不觸真 ~/.macchiato / ~/.claude）。 */
export function assertPathIsSandboxed(path: string): void {
  if (!active) {
    throw new Error("hermetic sandbox not installed");
  }
  const { sandboxRoot, realHome } = active;
  if (!path.startsWith(sandboxRoot)) {
    throw new Error(`path escapes hermetic sandbox: ${path} (sandbox=${sandboxRoot})`);
  }
  // 額外防衛:即便路徑碰巧以 sandbox 開頭,也絕不可等於/落在真 HOME 下的敏感目錄
  const realMacchiato = join(realHome, ".macchiato");
  const realClaude = join(realHome, ".claude");
  const realCodex = join(realHome, ".codex");
  const realHermes = join(realHome, ".hermes");
  const realOpenclaw = join(realHome, ".openclaw");
  for (const forbidden of [realMacchiato, realClaude, realCodex, realHermes, realOpenclaw, realHome]) {
    if (path === forbidden || path.startsWith(forbidden + "/") || path.startsWith(forbidden + "\\")) {
      // 僅當 forbidden 不是 sandbox 子路徑時才算越界（CI 上 realHome 可能異常）
      if (!forbidden.startsWith(sandboxRoot)) {
        throw new Error(`path touches real host home data: ${path}`);
      }
    }
  }
}
