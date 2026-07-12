import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 測試副作用隔離(2026-07-12 事故根治):把 HOME 指向臨時目錄,令所有
 * `join(homedir(), ".macchiato/...")` 的默認憑證/水位線/會話映射路徑落到沙箱——
 * 任何測試都碰不到真實 ~/.macchiato(此前 codex creds 測試 env 變量寫錯 →
 * 回退默認路徑 → 覆蓋真實憑證,連接器變未配對)。
 * 每個測試進程一個臨時 HOME;vitest 退出即棄(在 /tmp,系統回收)。
 * 顯式路徑仍可被單測覆蓋成自己的臨時目錄——本 setup 只保證「沒設時不打真實文件」。
 */
const fakeHome = mkdtempSync(join(tmpdir(), "mc-test-home-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome; // Windows 兜底
