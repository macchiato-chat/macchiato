/**
 * #893 進程級故障的**地板** + 可見出口。四家 TS 連接器共用一份。
 *
 * 為什麼需要它（不是「更嚴謹」，是已經咬過兩次的形狀）：
 *   `package.json` 是 `"node": ">=22"`，而 Node ≥15 默認 `--unhandled-rejections=throw`
 *   ——**一條逃逸的 promise rejection 直接殺進程**。此前三家 `index.ts` 一個進程級 handler 都沒有，
 *   於是整條異步路徑靠「每個調用點各自 `.catch()`」自覺，漏一處就是掉線。而這條路已經漏過：
 *     · `openclaw/index.ts` 的 `import_start` 注釋原文：「此前 rejection 直接漏出去」（#874）；
 *     · `codex/appserver.ts` 的注釋也在擔心同一件事（「respondError 若同步拋更會冒成 unhandled
 *       rejection(void async)」）。
 *   兩次都只修了那一處，從沒加過地板。
 *
 * 為什麼「掉線」在本產品裡格外貴：進程死 → supervisor（#528）拉起 → 若觸發是**數據驅動**的
 *   （某條消息 / 某個會話穩定復現）就是崩潰循環，而 heal 拉的是**同版 repair**，裝完還是崩。
 *   #528 修的是**壞包**，不是壞數據——所以這一類完全繞過那整套自愈，那台機器只能等下一個好版本。
 *
 * 兩條 handler 的語義**與 server（`services/server/src/index.ts`）刻意一致**：
 *   · `unhandledRejection` → 記錄 + 落 health，**不退出**。多為可恢復的局部失敗（每個幀處理器
 *     本就各自 try/catch），退出只會把「一條壞消息」升級成「整條 Link B 掉線」。
 *   · `uncaughtException` → 記錄 + 落 health，**優雅退出交 supervisor**。進程狀態已不可信。
 *     注意這一條**不改變今天的行為**（無 handler 時 Node 也是打堆棧後 exit(1)），改變的只有
 *     「死之前留下了一行用戶和 supervisor 都看得見的真話」。
 *
 * 🚨 `lastError` 會經 `connector_health` 上到 server、再進 app —— 故一律走 `safeErr()` 脫敏
 *    （默認只出類型 + 長度，正文要顯式開 `MACCHIATO_LOG_CONTENT=1`）。絕不把用戶內容/路徑/密鑰
 *    順着錯誤消息漏出去。
 */
import { safeErr } from "./safe-log";

/**
 * 故障通知的存活窗。過期即不再上報——一小時前的一次瞬時 rejection 不該永久佔着 `lastError`
 * （那正是 #348「靜默凍結」與 #888「真原因被 sticky 錯誤擋在門口」的反面教訓：信息位不許蓋真問題，
 * 但真問題也不該變成永久噪音）。env 只為測試提供注入點。
 */
export const RUNTIME_FAULT_TTL_MS =
  Number(process.env.MACCHIATO_RUNTIME_FAULT_TTL_MS) || 10 * 60_000;

export type RuntimeFaultKind = "unhandledRejection" | "uncaughtException";

interface RuntimeFault {
  kind: RuntimeFaultKind;
  /** 已脫敏的簡短原因（`safeErr`）。 */
  detail: string;
  /** 最近一次發生時刻（epoch ms）。 */
  at: number;
  /** 窗口內累計次數——「偶發一次」和「每秒一次」是兩種病，用戶該看得出來。 */
  count: number;
}

let current: RuntimeFault | null = null;

/** 記一次進程級故障（純函數式狀態，便於單測）。 */
export function noteRuntimeFault(
  kind: RuntimeFaultKind,
  err: unknown,
  now: number = Date.now(),
): void {
  const detail = safeErr(err);
  // 同類同因在窗口內只累加計數，不刷新為新條目——否則「同一個 bug 每秒一次」會看起來像
  // 「剛剛才出過一次」，嚴重程度被抹平。
  if (current && current.kind === kind && current.detail === detail && now - current.at < RUNTIME_FAULT_TTL_MS) {
    current.count += 1;
    current.at = now;
    return;
  }
  current = { kind, detail, at: now, count: 1 };
}

/**
 * 給 health 的一句人話（過期 / 從未發生 → null）。
 * 措辭刻意只說「發生了什麼 + 下一步」，不甩堆棧、不甩內部狀態（CLAUDE.md：失敗要說人話）。
 */
export function runtimeFaultNotice(now: number = Date.now()): string | null {
  if (!current) return null;
  if (now - current.at >= RUNTIME_FAULT_TTL_MS) return null;
  const times = current.count > 1 ? ` ×${current.count}` : "";
  const tail =
    current.kind === "uncaughtException"
      ? "連接器已重啟；若反復出現請在終端重跑安裝命令"
      : "已兜住、仍在運行；若消息收發異常請重啟連接器";
  const notice = `⚠️ 連接器內部異常(${current.detail})${times} —— ${tail}`;
  // server 的 healthFromState 會截到 240；這裡先自截，別讓截斷發生在多字節字符中間。
  return notice.length > 240 ? `${notice.slice(0, 237)}…` : notice;
}

/** @internal 單測隔離用。 */
export function resetRuntimeFaults(): void {
  current = null;
}

/** @internal 單測讀取用。 */
export function currentRuntimeFault(): Readonly<RuntimeFault> | null {
  return current;
}

let installed = false;

/**
 * 掛上兩條進程級 handler。**在 `linkb.start()` 之前調**——啟動段（憑證解析、keystore、
 * gateway 首連）本身就是逃逸高發區，掛晚了那一段就沒有地板。
 *
 * @param opts.flushHealth 立刻把 health 快照落盤（傳 `() => heartbeat.writeNow()`）。
 *   落盤是唯一能讓 **supervisor** 看到原因的通道（它絕不 import 連接器樹，只讀文件，見 #528）；
 *   `connector_health` 幀則要等下一個 tick、且進程正在退出時根本發不出去。
 * @param opts.exit 覆蓋退出動作（單測用；生產默認 `process.exit`）。
 */
export function installProcessFaultHandlers(
  opts: { flushHealth?: () => void; exit?: (code: number) => void } = {},
): void {
  if (installed) return; // 冪等：重複安裝會讓同一次故障被記多遍
  installed = true;
  const flush = (): void => {
    try {
      opts.flushHealth?.();
    } catch {
      /* 落盤失敗不能反過來把兜底 handler 自己搞崩 */
    }
  };

  process.on("unhandledRejection", (reason) => {
    noteRuntimeFault("unhandledRejection", reason);
    // 日誌走 console.error（連接器沒有結構化 logger）；正文已脫敏。
    console.error(`[unhandledRejection] ${safeErr(reason)} —— 已兜住，不退出`);
    flush();
  });

  process.on("uncaughtException", (err) => {
    noteRuntimeFault("uncaughtException", err);
    console.error(`[uncaughtException] ${safeErr(err)} —— 落 health 後退出，交 supervisor 拉起`);
    flush();
    (opts.exit ?? ((code: number) => process.exit(code)))(1);
  });
}

/** @internal 單測隔離用（連帶清掉 installed 閂）。 */
export function resetProcessFaultHandlersForTest(): void {
  installed = false;
  resetRuntimeFaults();
}
