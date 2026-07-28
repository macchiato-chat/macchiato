import { afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const drop = (dir: string) => {
  // 子進程可能仍持有檔案句柄;刪不掉就算了,殘留由下一輪的自愈掃除兜底。
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

/**
 * 臨時檔沙箱(#453):把本測試檔的 TMPDIR/TMP/TEMP 整個指進一個一次性目錄,
 * 令測試裡任何 `mkdtempSync(join(tmpdir(), …))`、`writeFileSync(tmpdir()…)`
 * 以及 spawn 出去的子進程臨時檔都落在裡面,測試檔跑完一次刪乾淨——
 * 不必在 200+ 個 mkdtemp 呼叫點各補一次清理,新增的呼叫點也自動被兜住。
 *
 * 為什麼要做:原先假設「vitest 退出即棄,在 /tmp 由系統回收」。這在 `/tmp` 是
 * tmpfs 的發行版(Raspberry Pi OS / Fedora / Arch 預設)上不成立——tmpfs 佔的是
 * 記憶體,而系統的 tmpfiles 清理預設要 10 天才動手。2026-07-27 在夜跑機實測:
 * 14 天累積 41694 個目錄 / 1.6GB,把 4GB tmpfs 撐到 99%,連帶把靠 /tmp 放暫存的
 * headless chromium 打進 SIGTRAP 崩潰迴圈(9.9 小時、6444 次重啟)。
 */
const REAL_TMP = tmpdir(); // 必須在覆蓋 TMPDIR 之前取
const sandbox = mkdtempSync(join(REAL_TMP, "mc-test-"));
process.env.TMPDIR = sandbox;
process.env.TMP = sandbox; // Windows
process.env.TEMP = sandbox;

/**
 * 測試副作用隔離(2026-07-12 事故根治):把 HOME 指向臨時目錄,令所有
 * `join(homedir(), ".macchiato/...")` 的默認憑證/水位線/會話映射路徑落到沙箱——
 * 任何測試都碰不到真實 ~/.macchiato(此前 codex creds 測試 env 變量寫錯 →
 * 回退默認路徑 → 覆蓋真實憑證,連接器變未配對)。
 * 每個測試進程一個臨時 HOME;隨上面的沙箱一起回收。
 * 顯式路徑仍可被單測覆蓋成自己的臨時目錄——本 setup 只保證「沒設時不打真實文件」。
 */
const fakeHome = join(sandbox, "home");
mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome; // Windows 兜底

afterAll(() => drop(sandbox));

/**
 * 自愈掃除:測試檔在 transform/collect 階段就失敗時,setupFiles 已經跑完但 afterAll
 * 不會執行,vitest 又會強殺該 worker(exit 鉤子同樣不保證觸發)——實測每個壞掉的
 * 測試檔各留一個空沙箱。這裡在建完自己的沙箱後,順手清掉同前綴、**超過 2 小時**的
 * 舊沙箱:2 小時遠長於任何一輪測試,故不會誤刪並行跑的另一輪。
 */
const STALE_MS = 2 * 60 * 60 * 1000;
try {
  for (const name of readdirSync(REAL_TMP)) {
    if (!name.startsWith("mc-test-")) continue;
    const path = join(REAL_TMP, name);
    if (path === sandbox) continue;
    if (Date.now() - statSync(path).mtimeMs > STALE_MS) drop(path);
  }
} catch {
  /* 掃不動就算了,不該讓清理失敗影響測試 */
}
