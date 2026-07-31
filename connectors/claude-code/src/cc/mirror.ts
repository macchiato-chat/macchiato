/**
 * §15 鏡像：tail Claude Code 的 transcript（~/.claude/projects/<slug>/<sessionId>.jsonl）→ mirror_append。
 *  - 發現：掃 projects/ 下全部 <uuid>.jsonl（agent-*.jsonl = 子 agent 轉錄，跳過）。
 *  - 未知會話從 0 全量鏡像完整歷史（自動看到所有會話 = 相對官方 remote control 的核心賣點,
 *    不依賴手動 import）；分批發（batchMax 條/帧，單帧單會話）防超 server maxPayload。
 *  - 字節偏移水位線 + in-flight 保留（見 transcripts.foldEntries）。durable outbox（#348）：幀落盤
 *    後才發，只有 `mirror_ack` 才提交水位；`mirror_nack` 默認保留原批重發，終態 `code`
 *    （`e2e_direction` 方向翻轉 / `malformed` 畸形毒批）則丟批——見 `handleNack`。
 *  - driven 會話（本進程經 SDK 驅動）：live 路徑獨佔投遞；回合在途靠 `drivenSids` 讓路（#200/#348：
 *    未經 server ACK 絕不推進水位），明文靠 #393 的 srcId 去重、E2E 靠 durable outbox 補投。
 *  - `drivenUuids` + wire 反向映射（#395）：曾被驅動的 CLI uuid **不得另建影子會話**；但若能反查到
 *    既有 wire sid（app ULID / 鏡像同源 uuid），終端對該 uuid 的續聊**掛回原 wire 會話**回流。
 *    無映射時仍永久攔截（防影子）。
 *  - §9：消息帶 srcId（transcript 行 uuid），server 端崩潰重發去重。
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import type { LinkBClient } from "../_core/linkb/client";
import type { E2EKeyStore } from "../_core/e2e/keys";
import type { E2EDisableReceiptV1 } from "../_core/e2e/control";
import { foldEntries, projectsDir, readEntries, type CCMessage } from "./transcripts";

/**
 * 鏡像狀態檔的耐久寫（0600 + fsync + 原子 rename + 目錄 fsync）。
 *
 * 為什麼要這麼嚴：這個檔案自 durable outbox 起裝的是**完整消息正文**——待確認批的整個 wire
 * frame 都落在裡面，disable 回灌時更是「整個曾加密會話的明文快照」。同倉 `e2e/keys.ts` 對 K_S
 * 就是 0600 + fsync，這裡沒有理由更鬆（原先是默認 0644，多用戶主機上別的用戶可讀）。
 * 而 fsync 也不是可選項：#200 的動機就是掉電，沒有 fsync 的「先落盤再發送」對掉電根本不成立。
 */
function durableWrite(target: string, contents: string): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  let open = true;
  try {
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    open = false;
    renameSync(temp, target);
  } catch (error) {
    if (open) {
      try {
        closeSync(fd);
      } catch {
        /* 保留原始寫入錯誤 */
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      /* temp 可能未建成或已 rename 走 */
    }
    throw error;
  }
  // rename 本身也要落盤，否則掉電後可能只剩舊檔/半個目錄項。
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}


const POLL_MS = Number(process.env.MACCHIATO_CC_POLL_MS) || 5000;
const MAX_WIRE_BYTES = Number(process.env.MACCHIATO_MIRROR_FRAME_BYTES) || 2 * 1024 * 1024;
/** E2E 回灌分片上限（server 側 parseE2EBackfillFrame 同值硬校驗）。 */
const MAX_BACKFILL_CHUNKS = 512;
/** #9:轉錄文件消失多久後裁掉水位線/標題(默認 7 天;CC 清理舊轉錄後 uuid 不復用,不會回歸)。 */
const PRUNE_MS = Number(process.env.MACCHIATO_MIRROR_PRUNE_MS) || 7 * 24 * 3600 * 1000;
const batchMax = (): number => Number(process.env.MACCHIATO_CC_BATCH_MAX) || 150;
/** 公開 connector 不依賴私有 protocol package；此處鏡像 packages/protocol 的導入 wire shape。 */
interface ImportToolCall {
  callId: string;
  name: string;
  input?: unknown;
  output?: unknown;
  state: "ok" | "error";
}

export interface ImportMessage {
  role: "user" | "agent" | "system";
  text: string;
  reasoning?: string;
  tools?: ImportToolCall[];
  createdAt?: string | number;
  srcId?: string;
  enc?: string;
}

interface ImportSession {
  hermesSessionId: string;
  title?: string;
  source?: string;
  e2e?: boolean;
  messages: ImportMessage[];
}

interface E2EBackfillBase {
  t: "e2e_backfill";
  agentLinkId: string;
  hermesSessionId: string;
  mode?: "enable" | "disable";
  batchId: string;
  chunkIndex?: number;
  chunkCount?: number;
}

type ConnectorE2EBackfill =
  | (E2EBackfillBase & { found: false; session?: never; disableReceipt?: never })
  | (E2EBackfillBase & {
      found: true;
      session: ImportSession;
      disableReceipt?: E2EDisableReceiptV1;
    });

/** 只有 server 明确回报目标终态的成功 ACK 才算 backfill 事务提交。 */
export function isCommittedE2EBackfillResult(
  mode: "enable" | "disable",
  ok: unknown,
  e2e: unknown,
): boolean {
  return ok === true && e2e === (mode === "enable");
}

function statePath(): string {
  return process.env.MACCHIATO_CC_MIRROR || join(homedir(), ".macchiato/claude-code-mirror.json");
}

/** CCMessage → 協議 ImportMessage（tools 對齊 ImportToolCall：input/output/state,別發自造字段）。 */
export function toImportMessage(m: CCMessage): ImportMessage {
  return {
    role: m.role,
    text: m.text,
    ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    ...(m.tools?.length
      ? {
          tools: m.tools.map((t) => ({
            callId: t.callId,
            name: t.name,
            input: t.args ?? {},
            output: t.resultText ?? "",
            state: "ok" as const,
          })),
        }
      : {}),
    ...(m.createdAt ? { createdAt: m.createdAt } : {}),
    srcId: m.srcId,
  };
}

/** <uuid>.jsonl 才是主會話轉錄（agent-* 為子 agent；其它雜檔跳過）。 */
const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

export interface SessionFile {
  sid: string;
  file: string;
}

export function discoverSessions(root = projectsDir()): SessionFile[] {
  const out: SessionFile[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dir = join(root, d);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (SESSION_FILE_RE.test(f)) out.push({ sid: basename(f, ".jsonl"), file: join(dir, f) });
    }
  }
  return out;
}

interface State {
  offsets: Record<string, number>; // sid → 字節水位線
  titles: Record<string, string>; // sid → 已發標題（變了才補發）
  /** #9:sid 的轉錄文件首次消失的時刻;回歸即清,超 PRUNE_MS 連 offsets/titles 一起裁。 */
  missingAt?: Record<string, number>;
  /** #161 墓碑:app 刪過的會話(CLI uuid),鏡像永不再撈;不刪 transcript(app 是遙控器)。 */
  tombstones?: string[];
  /** #154 首掃基線已建(true 之後新發現的會話才 from-zero)。舊安裝(offsets 非空)載入時視為已建。 */
  seeded?: boolean;
  pendingMirrors?: Array<{
    batchId: string;
    frame: Record<string, unknown>;
    sid: string;
    endOffset: number;
    title?: string;
    /** ACK 可乱序到达；只有同 sid 的前序批全 ACK 后才允许连续提交水位。 */
    acked?: boolean;
  }>;
  pendingE2EBackfills?: Record<
    string,
    {
      batchId: string;
      wireSid: string;
      localSid?: string;
      mode: "enable" | "disable";
      frames: Array<Record<string, unknown>>;
      endOffset?: number;
    }
  >;
}

export class Mirror {
  private state: State;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly drivenSids = new Set<string>();
  private readonly sentBatchAt = new Map<string, number>();
  /**
   * 影子 session 兜底(第二道防護,2026-07-13 / #395 重估):**曾被 Macchiato 驅動過**的 CLI 會話
   * uuid(持久,由 Drive 從 wire→CLI 映射灌入,跨重啟)。無 wire 反向映射時,鏡像**永不**為這些
   * uuid **單獨建**會話(正文由 live 在 wire sid 下投遞,另建 = 影子)。有映射時終端續聊掛回原
   * wire 會話(#395,配合 #393 srcId 去重歷史 live 內容)。與「無 user 不建」是雙保險;無映射卻
   * 仍觸發 emit 即記 mirrorGhostBlocked + 錯誤日誌(自檢告警)。
   */
  private readonly drivenUuids = new Set<string>();
  /**
   * #318 live 已投遞的 API message.id(按 sid)。回合末 Drive 登記本回合 live 覆蓋的 message.id;
   * mirror fold 出的 assistant 消息若命中即跳過,防 live×mirror 雙投。#348 後 fastForward 不再
   * 快進水位,回合末鏡像會重讀**整個回合**的 transcript——這個集合是 driven 回合內容不被複讀
   * 落庫的唯一屏障(#393 srcId 只覆蓋 live 那一條),必須罩住回合全部主線 msgId(#551)。
   * 有界:每 sid ≤512 個 id、總 ≤64 個 sid(FIFO 淘汰防洩漏)。
   */
  private readonly livePosted = new Map<string, Set<string>>();
  /**
   * #308 `MACCHIATO_MIRROR=off` 下仍需**定向**輪詢的會話：app 建的、受 E2E 保護的 driven 會話。
   * 它們的正文只有鏡像一條投遞路（live 路徑對 E2E 不投正文），而 off 下沒有全量輪詢定時器。
   * 只裝這一小撮 sid——終端會話一個都不掃，`MIRROR=off` 的契約不破。
   */
  private readonly drivenE2EWatch = new Set<string>();
  /**
   * #268 自適應縮批：sid → 連續 NACK 次數。每次 NACK 把該會話的每批條數上限對半砍（下限 1），
   * ACK 後歸零。server 端的失敗常見於「這批太大」，原樣重發同一批只會一直撞同一堵牆。
   */
  private readonly nackShrink = new Map<string, number>();
  /**
   * 內部 fork 檔（subagent / 後台任務）：CC 會把它們寫成獨立 <uuid>.jsonl（繼承父會話標題
   * 元數據、**無任何真人消息**）。首次鏡像（水位線 0）折不出 user 消息 → 判內部檔，跳過且
   * 不推水位線；記 size，檔沒長就不重讀。若將來用戶真在該會話說話（size 變 + 出現 user），
   * 自動恢復全量鏡像。修「後台任務輸出冒出同名新會話」（2026-07-11 實測）。
   */
  private readonly internalAt = new Map<string, number>();
  /**
   * #56 二期：鏡像側工作態偵測（終端側回合沒有流式事件，busy 只有輪詢看得出）。
   * busy = 文件較上輪增長 ∨（尾部未結算 且 距最近增長 <90s——防 agent 死於工具中途的
   * 30 分鐘殭屍動畫；長工具靜默期會提前歸靜、結果落盤再亮，取捨）。連續 2 輪安靜才轉 idle
   * （防抖）；busy 期間每輪重申（server 端 20s TTL 兜底連接器崩潰）。全部內存態，重啟重測。
   */
  private readonly lastSizeAt = new Map<string, number>();
  private readonly lastGrowthAt = new Map<string, number>();
  private readonly busySids = new Set<string>();
  private readonly quietPolls = new Map<string, number>();
  lastPollAt = Date.now();
  lastError: string | null = null;
  /**
   * #348 lastError 的「未結清」標記。poll 成功返回**不等於**問題解決——NACK 後批次仍留在
   * durable outbox 重試、水位就是不動的。此前 poll 正常返回即無條件清空 lastError，而
   * health.ts 是 lastError 唯一的用戶可見出口 → #348 要求的「明確報錯」實際落成「靜默凍結」：
   * 會話停更、UI 什麼也不說。故錯誤一旦記下就黏住，直到**真有一批被 server 提交**（ACK）
   * 才算恢復正常、允許下一輪 poll 清掉。
   */
  private errorSticky = false;
  /** #10:累計計數(進程生命週期),健康上報帶出。 */
  readonly counters: Record<string, number> = {
    mirrorBatches: 0,
    mirrorMessages: 0,
    mirrorNacks: 0,
    mirrorErrors: 0,
    mirrorGhostBlocked: 0, // 影子 session 兜底:攔下的「為 driven CLI 會話憑空建會話」次數(正常應恆 0)
    mirrorDirectionRewinds: 0, // E2E 方向翻轉導致丟棄凍結批、回退重編的次數
    mirrorDropped: 0, // server 判畸形/毒批而丟棄跳過的批次數(非 0 = 有內容沒進 app)
  };
  private polling = false;
  /** #308 MACCHIATO_MIRROR=off:停鏡像輪詢(終端側活動不進 app)。⚠️ 只停這一樣——
   * fastForward/墓碑/markLivePosted/E2E backfill 是 driven 會話衛生,必須照常跑,
   * 多關任何一個 = 影子會話/雙投全家回歸(#161/#318)。副作用:終端側忙碌指示(#56)一併失去。 */
  readonly disabled = /^(off|0|false|no)$/i.test(process.env.MACCHIATO_MIRROR ?? "");

  constructor(
    private readonly linkb: LinkBClient,
    private readonly e2e?: E2EKeyStore,
    /**
     * 本地 CC uuid → Macchiato wire sid（#395；字段名沿用歷史 e2e* 前綴）。
     * 明文 ULID 與 E2E wire 都走這條——有映射才允許 driven uuid 的終端續聊回流原會話。
     */
    private readonly e2eWireSidForLocal?: (localSid: string) => string | undefined,
    /** 身份快照無法證明完整時，未知 local uuid 不能回落成 plaintext shadow。 */
    private readonly plaintextLocalAllowed?: (localSid: string) => boolean,
  ) {
    this.state = this.load();
  }

  start(): void {
    if (this.disabled) {
      // ⚠️ 回歸契約:scripts/localchain/scenarios-mirror-off.mjs 斷言此串,改文案需同步
      console.log("· Mirror disabled (MACCHIATO_MIRROR=off) — terminal sessions stay out of the app; app-driven sessions unaffected");
      // #308 契約的後半句「app-driven sessions unaffected」也要兌現:E2E driven 回合的正文
      // **只有鏡像這一條路**(live 路徑不投密文正文)。故 off 下仍裝一個**定向**輪詢——只掃
      // drivenE2EWatch 裡的會話(app 建的、受 E2E 保護的),外加待確認批重發;終端會話一個都不掃,
      // 契約不破。缺這條時:尾巴晚落盤的最後一塊、任何需重試的批**永遠不會再發**。
      this.timer = setInterval(() => void this.poll(this.drivenE2EWatch), POLL_MS);
      return;
    }
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    console.log(`· Mirror started (poll ${POLL_MS / 1000}s, tailing ${projectsDir()})`);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const sid of [...this.tailPollTimers.keys()]) this.cancelTailPolls(sid);
  }
  restart(): void {
    this.stop();
    this.polling = false;
    this.start();
  }

  setDriven(sid: string): void {
    this.drivenSids.add(sid);
    if (this.disabled && this.isE2ESession(sid)) this.watchDrivenE2E(sid);
    this.drivenUuids.add(sid);
  }

  /** #161 墓碑:永不再鏡像此 CLI 會話(持久;transcript 不動)。 */
  tombstone(sid: string): void {
    const t = (this.state.tombstones ??= []);
    if (!t.includes(sid)) {
      t.push(sid);
      this.state.pendingMirrors = (this.state.pendingMirrors ?? []).filter(
        (pending) => pending.sid !== sid,
      );
      this.save();
      console.log(`· 墓碑 ${sid}(鏡像永不再撈)`);
    }
  }

  /** 影子兜底(2026-07-13 / #395):登記「曾被 Macchiato 驅動」的 CLI 會話 uuid(持久)。Drive 在
   * init 存 wire→CLI 映射時、及啟動時從既有映射批量灌入。無 wire 反向映射時永不為其單獨建會話;
   * 有映射時終端續聊掛回原 wire(見 poll 第二道)。 */
  markDrivenUuid(cliUuid: string): void {
    if (cliUuid) this.drivenUuids.add(cliUuid);
  }

  /** #318 回合末登記本回合 live 覆蓋的 API message.id(Drive 調)。有界 FIFO 防洩漏。 */
  markLivePosted(sid: string, msgIds: Iterable<string>): void {
    let set = this.livePosted.get(sid);
    if (!set) {
      set = new Set();
      this.livePosted.set(sid, set);
      while (this.livePosted.size > 64) this.livePosted.delete(this.livePosted.keys().next().value!); // 總 sid 上限
    }
    for (const id of msgIds) {
      if (id) set.add(id);
      // #551 上限 64→512:#348 後 fastForward 不再快進,回合末鏡像重讀**整個回合**,集合必須
      // 罩住回合全部主線 msgId;64 會被超長回合擠掉最老的(=重讀最先遇到的),開頭幾組漏過濾複讀落庫。
      while (set.size > 512) set.delete(set.keys().next().value!); // 每 sid id 上限
    }
  }

  /** #318 fold 出的消息過濾:命中 live 已投的 message.id → 跳過。防雙投。
   * #551 非變異(不再一次性 delete):批發送失敗重試、或同一 msgId 的行被字節預算摺分到兩批時,
   * 一次性消耗會放行第二次。msg id 全局唯一——留在集合裡只會繼續吞對同段的重讀,不會誤吞新內容;
   * 洩漏由 markLivePosted 的 FIFO 上限兜住。 */
  private dropLivePosted(sid: string, messages: CCMessage[]): CCMessage[] {
    const set = this.livePosted.get(sid);
    if (!set?.size) return messages;
    return messages.filter((m) => !(m.msgId && set.has(m.msgId)));
  }

  /**
   * 解除 driven（回合結束後調）。CC 與 OpenClaw 的關鍵差異：CC 無常駐 gateway，終端側回合
   * **只有鏡像一條路**——若 driven 永久生效，從 Macchiato 驅動過一次的會話就再也鏡像不到終端
   * 活動（2026-07-06 實測踩中）。故 driven 僅覆蓋驅動回合本身（live 已投遞、鏡像跳過防雙投），
   * 回合結束 fastForward 越過該回合內容後立即解除，終端側活動恢復鏡像。
   */
  unsetDriven(sid: string): void {
    this.drivenSids.delete(sid);
    // #350 回合末尾巴的**定向**追讀。E2E driven 回合的正文只有 transcript 這一條路（live
    // 不投密文），而 SDK 的 result 常常早於 CLI 把 transcript 尾巴寫完 → 下面這次即時 poll
    // 讀不到最後一塊，就要等滿一個 POLL_MS（5s）的常規 tick，用戶側表現為「回覆延遲 0–5s、
    // 且常被拆成兩段到達」。這裡在回合末補幾次**短間隔定向** poll（只掃這一個 sid），把尾巴
    // 追平壓到亞秒級。純屬調度：內容源仍然只有 transcript，不新增任何投遞路徑。
    if (this.isE2ESession(sid)) this.scheduleTailPolls(sid);
    if (this.disabled) {
      // #308 MIRROR=off:**絕不**在這裡做全量 poll——那會把用戶明確要求不進 app 的終端會話
      // 全掃一遍鏡像進去(契約反向破裂)。只對「受 E2E 保護的 app-driven 會話」做定向投遞,
      // 並登記進 watch 讓 start() 的定向輪詢持續兜住晚落盤的尾巴/需重試的批。
      if (this.isE2ESession(sid)) {
        this.watchDrivenE2E(sid);
        void this.poll(new Set([sid]));
      }
      return;
    }
    void this.poll();
  }

  /**
   * #350 回合末尾巴追讀的排程（每 sid 一組，重入即取代——新回合結束時舊排程已無意義）。
   * 間隔刻意前密後疏：常見情況第一兩次就追平，最後一次兜住寫得特別慢的尾巴；全部落在
   * 一個 POLL_MS 之內，超出的部分本來就由常規 tick 接手，故不會與它疊加成重複輪詢。
   */
  private readonly tailPollTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  private static readonly TAIL_POLL_DELAYS_MS = [250, 700, 1500, 3000];

  private scheduleTailPolls(sid: string): void {
    this.cancelTailPolls(sid);
    const scope = new Set([sid]);
    const timers = Mirror.TAIL_POLL_DELAYS_MS.map((delay) => {
      const timer = setTimeout(() => void this.poll(scope), delay);
      timer.unref?.(); // 純加速用，絕不因此拖住進程退出
      return timer;
    });
    this.tailPollTimers.set(sid, timers);
  }

  private cancelTailPolls(sid: string): void {
    for (const timer of this.tailPollTimers.get(sid) ?? []) clearTimeout(timer);
    this.tailPollTimers.delete(sid);
  }

  /**
   * 該本地會話當前是否受 E2E 保護（#308 定向輪詢 / 尾巴追讀的門控）。
   *
   * #395 後 `e2eWireSidForLocal` 回**任意** wire（含明文 ULID）以掛回原會話——**不能**再
   * `!!callback(sid)` 當 E2E 判定，否則明文映射會被誤當 E2E，`MIRROR=off` 下也會
   * `watchDrivenE2E` + 定向 poll，把終端續聊灌進 app（#308 契約反向破裂）。
   * 判定：本地直接持鑰，或映射到的 wire 本身是 E2E。
   */
  private isE2ESession(sid: string): boolean {
    if (this.e2e?.isE2E(sid) === true) return true;
    const wire = this.e2eWireSidForLocal?.(sid);
    return !!wire && this.e2e?.isE2E(wire) === true;
  }

  /** MIRROR=off 下仍需定向輪詢的 app-driven E2E 會話（有界 FIFO，防無限增長）。 */
  private watchDrivenE2E(sid: string): void {
    this.drivenE2EWatch.add(sid);
    while (this.drivenE2EWatch.size > 64) {
      this.drivenE2EWatch.delete(this.drivenE2EWatch.values().next().value!);
    }
  }

  /**
   * #393 回合末只讀快照:折出該 CC 會話 transcript **尾段**的消息(帶 srcId=行 uuid + msgId=API
   * message.id),供 Drive 把 live 投遞過的 user/agent 消息回填 srcId 作 server dedup_key。
   * srcId 是行 uuid(位置無關),故讀尾段窗口即可覆蓋剛結束的回合;窗口起點可能截斷首行(壞 JSON
   * 跳過)、或截斷某 assistant 組首行(該組 srcId 取窗內首行,不影響「取最後一組」的目標)。
   * 純只讀:不推水位線、不 emit、不改狀態。E2E 會話由加密批攜 srcId,不走這裡(調用方已隔離)。
   */
  srcIdSnapshot(sid: string, windowBytes = 1024 * 1024): CCMessage[] {
    const f = this.fileForSid(sid);
    if (!f) return [];
    try {
      const size = statSync(f).size;
      const from = Math.max(0, size - windowBytes);
      const { entries, endOffset } = readEntries(f, from);
      if (!entries.length) return [];
      // now=MAX 強制結算尾部 in-flight 組,回合剛畢的 assistant 組也能取到 srcId。
      return foldEntries(entries, endOffset, Number.MAX_SAFE_INTEGER).messages;
    } catch {
      return [];
    }
  }

  /** #200/#348：回合結束不再未經 ACK 快進；plaintext live 靠 srcId 去重(#393)，E2E 交 durable mirror。 */
  fastForward(sid: string): void {
    void sid;
  }

  /**
   * #489 F-12 崩潰補撈：只讀 transcript **已落盤**內容，經 durable `mirror_append` 補投 agent 消息。
   *
   * 硬約束（prod safety）：
   *  - **絕不**重跑/重投 prompt（雙投副作用雷）；
   *  - 只補 `role=agent`（user 通常 live 已投，重投易雙份；agent 半截 live 可能已 interrupted）；
   *  - force-settle 尾部 in-flight 組（agent 死於工具中途也能撈到已寫文本/工具卡）；
   *  - 水位走 ACK 路徑推進（與 #348 同款）；
   *  - E2E 明文路徑跳過（密文/回灌另走）。
   *
   * @returns 是否補到任何 agent 內容（false → 調用方回退舊「請重發」提示）
   */
  salvageCrash(localSid: string, wireSid?: string): boolean {
    if (!localSid) return false;
    if (this.state.tombstones?.includes(localSid)) return false;
    if (this.hasPendingE2EBackfill(localSid)) return false;
    // 已有 durable 批在途 → 交給 outbox，不另開 salvage 批（防同段雙投）
    if ((this.state.pendingMirrors ?? []).some((p) => p.sid === localSid)) return false;

    const file = this.fileForSid(localSid);
    if (!file) return false;
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return false;
    }
    const off = this.pendingOffset(localSid);
    if (size <= off) return false;

    const { entries, endOffset } = readEntries(file, off);
    if (!entries.length) return false;
    // force-settle 尾部 in-flight（now=MAX），把半截 agent 文本/工具也撈出來
    const folded = foldEntries(entries, endOffset, Number.MAX_SAFE_INTEGER);
    const agents = folded.messages.filter(
      (m) =>
        m.role === "agent" &&
        (!!m.text.trim() || !!m.reasoning?.trim() || (m.tools?.length ?? 0) > 0),
    );
    if (!agents.length) return false;

    const mappedWire = this.e2eWireSidForLocal?.(localSid);
    const targetSid = wireSid ?? mappedWire ?? localSid;
    // E2E 不走明文 salvage（加密批/回灌是獨立路徑）
    if (this.e2e?.isE2E(targetSid) || this.e2e?.isE2E(localSid)) return false;
    if (!wireSid && !mappedWire && this.plaintextLocalAllowed?.(localSid) === false) {
      return false;
    }

    const title = this.pendingTitle(localSid) ?? "Claude Code";
    // endOffset 用 fold 全量 consumedUpTo（含跳過的 user 行）：user 本回合 live 已投，
    // 水位推過後常規 poll 不再重讀；agent 帶 srcId，server 冪等索引兜底可見重複。
    const sent = this.sendOne(
      localSid,
      this.entry(targetSid, title, agents),
      folded.consumedUpTo,
      undefined,
    );
    if (sent) {
      console.log(
        `· #489 F-12 salvageCrash ${localSid} → ${targetSid}: ${agents.length} agent msg(s)`,
      );
    }
    return sent;
  }

  /**
   * #473 rewind 的**只讀**勘察：在 sid 的 transcript 裡找 `targetUuid`，回「最後一條要保留的
   * 行 uuid」與會被丟掉的行數。
   *
   * 為什麼只讀:回退本身交給 SDK 的 `forkSession({ upToMessageId })`——它把 transcript 複製進
   * 一個**新**會話檔並重映射 uuid 鏈,原檔一個字節都不動。我們自己改檔案的舊做法有三個毛病:
   * 繞開 SDK、進程死在覆寫中途會留半行、以及和「用戶同時在終端 resume 同一會話」打架。
   *
   * `upToMessageId` 是 **inclusive**,所以要丟掉目標那條,傳的必須是它**前一條**的 uuid。
   * `keepUpToUuid = null` 表示目標就是首行 → 沒有任何內容可保留,調用方應改為「丟掉映射、
   * 下個 prompt 重開新會話」,而不是 fork(省略 upToMessageId 是全量複製,正好相反)。
   */
  rewindPlan(sid: string, targetUuid: string): { keepUpToUuid: string | null; dropped: number } | null {
    if (!sid || !targetUuid) return null;
    const file = this.fileForSid(sid);
    if (!file) return null;
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    let keepUpToUuid: string | null = null;
    let hit = false;
    let dropped = 0;
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let uuid = "";
      try {
        uuid = String((JSON.parse(t) as { uuid?: unknown }).uuid ?? "");
      } catch {
        continue; // 壞行跳過（與 foldEntries 同款容錯）
      }
      if (hit) {
        dropped += 1;
        continue;
      }
      if (uuid === targetUuid) {
        hit = true;
        dropped = 1;
        continue;
      }
      if (uuid) keepUpToUuid = uuid;
    }
    return hit ? { keepUpToUuid, dropped } : null;
  }

  /**
   * #473 認領 fork 出來的新 transcript：登記為 driven，並把水位線**直接坐到該檔當前 EOF**。
   *
   * ⚠️ 這一步漏了就是本功能最壞的 bug：fork 複製過去的整段歷史會被下一輪 poll（5s）當成新消息
   * 再灌一遍進同一個會話。必須在 fork 返回後**立刻**做，不能等 CLI 下個回合的 `init` 來報。
   */
  adoptForked(sid: string): boolean {
    if (!sid) return false;
    this.markDrivenUuid(sid);
    const file = this.fileForSid(sid);
    let size = 0;
    try {
      if (file) size = statSync(file).size;
    } catch {
      /* 檔還沒落盤 → 水位 0；下輪 poll 從頭讀,但 driven 守衛已擋住明文落地 */
    }
    this.state.offsets[sid] = size;
    this.save(true);
    return true;
  }

  private fileForSid(sid: string): string | null {
    for (const s of discoverSessions()) if (s.sid === sid) return s.file;
    return null;
  }

  /**
   * mirror_nack。默認語義是「保留 durable 批、按同 batchId 重發」——但幀是在**發送時**凍結進
   * outbox 的，會話事後轉 E2E（或關 E2E）後,凍結的舊方向批被 server 的方向校驗**永遠**拒絕：
   * 水位永久凍結,且每 15 秒把開啟 E2E 前的明文正文重發一次給 server。故終態 code 必須丟批:
   *  - `e2e_direction`:丟掉**該 sid 的全部**待確認批(後續批同樣是舊方向),水位停在最後一次
   *    ACK 的位置 → 下輪 poll 從那裡重讀、按當前方向重新編碼,恢復舊實現的自愈路徑。
   *    已 ACK 未提交的批一併丟棄:重讀會再發一次,server 端按 srcId 冪等去重。
   *  - `malformed`:批畸形/毒批,重試永遠不會好 → 丟批並**跳過**這段(推水位),否則該會話從此
   *    永不再前進;lastError 留給 health 讓用戶看見丟了東西。
   */
  handleNack(batchId: string | number, error?: string, code?: string): void {
    const target = (this.state.pendingMirrors ?? []).find(
      (pending) => pending.batchId === String(batchId),
    );
    if (!target) return;
    this.counters.mirrorNacks += 1; // #10
    this.lastError = error ?? `mirror_nack batch ${batchId}`;
    this.errorSticky = true; // 直到真有一批被 server 提交才清（見字段註釋）
    this.sentBatchAt.delete(String(batchId));
    this.nackShrink.set(target.sid, Math.min((this.nackShrink.get(target.sid) ?? 0) + 1, 8));
    if (code === "e2e_direction") {
      const sid = target.sid;
      const dropped = (this.state.pendingMirrors ?? []).filter((pending) => pending.sid === sid);
      for (const pending of dropped) this.sentBatchAt.delete(pending.batchId);
      this.state.pendingMirrors = (this.state.pendingMirrors ?? []).filter(
        (pending) => pending.sid !== sid,
      );
      this.counters.mirrorDirectionRewinds += 1;
      this.save(true);
      console.warn(
        `· mirror_nack(e2e_direction) ${sid} → 丟棄 ${dropped.length} 個舊方向凍結批,回退到水位 ${this.state.offsets[sid] ?? 0} 重讀重編`,
      );
      return;
    }
    if (code === "malformed") {
      this.state.offsets[target.sid] = Math.max(
        this.state.offsets[target.sid] ?? 0,
        target.endOffset,
      );
      if (target.title) this.state.titles[target.sid] = target.title;
      this.state.pendingMirrors = (this.state.pendingMirrors ?? []).filter(
        (pending) => pending.batchId !== target.batchId,
      );
      this.counters.mirrorDropped += 1;
      this.save(true);
      console.error(
        `· mirror_nack(malformed) batch ${batchId} → 丟棄該批並跳過(server 判畸形/毒批):${this.lastError}`,
      );
      return;
    }
    console.warn(`· mirror_nack batch ${batchId} → durable outbox retained for resend`);
  }

  handleAck(batchId: string | number): void {
    const pending = (this.state.pendingMirrors ?? []).find(
      (candidate) => candidate.batchId === String(batchId),
    );
    if (!pending) return;
    pending.acked = true;
    // 同一 sid 可按字节连续发多批，但 ACK/NACK 可能乱序。只从该 sid 队首连续消费已 ACK
    // 前缀；后批先 ACK 时保留 durable marker，绝不能越过仍在重试的前批水位。
    while (true) {
      const head = (this.state.pendingMirrors ?? []).find(
        (candidate) => candidate.sid === pending.sid,
      );
      if (!head?.acked) break;
      this.state.offsets[head.sid] = Math.max(
        this.state.offsets[head.sid] ?? 0,
        head.endOffset,
      );
      if (head.title) this.state.titles[head.sid] = head.title;
      this.nackShrink.delete(head.sid); // 這批過了 → 恢復正常批大小
      this.state.pendingMirrors = this.state.pendingMirrors!.filter(
        (candidate) => candidate.batchId !== head.batchId,
      );
      this.sentBatchAt.delete(head.batchId);
    }
    this.sentBatchAt.delete(String(batchId));
    this.errorSticky = false; // 有批真被 server 提交 → 錯誤結清，下輪 poll 可清 lastError
    this.save(true);
  }

  acceptsE2EBackfillResult(
    wireSid: string,
    mode: "enable" | "disable",
    batchId: unknown,
  ): boolean {
    const pending = this.state.pendingE2EBackfills?.[`${mode}:${wireSid}`];
    return !!pending && typeof batchId === "string" && pending.batchId === batchId;
  }

  handleE2EBackfillResult(
    wireSid: string,
    mode: "enable" | "disable",
    batchIdOrCommitted: unknown,
    committedMaybe?: boolean,
  ): void {
    const pendingKey = `${mode}:${wireSid}`;
    const pending = this.state.pendingE2EBackfills?.[pendingKey];
    const batchId = committedMaybe === undefined ? pending?.batchId : batchIdOrCommitted;
    const committed =
      committedMaybe === undefined ? batchIdOrCommitted === true : committedMaybe;
    if (!pending || pending.batchId !== batchId) return;
    delete this.state.pendingE2EBackfills![pendingKey];
    this.sentBatchAt.delete(pending.batchId);
    if (!committed) {
      this.save(true);
      return;
    }
    if (pending.localSid && pending.endOffset !== undefined) {
      this.state.offsets[pending.localSid] = Math.max(
        this.state.offsets[pending.localSid] ?? 0,
        pending.endOffset,
      );
    }
    this.save(true);
    console.log(
      `· E2E backfill ACK(${mode}): ${wireSid} (local ${pending.localSid}; watermark → ${pending.endOffset})`,
    );
  }

  private hasPendingE2EBackfill(localSid: string): boolean {
    return Object.values(this.state.pendingE2EBackfills ?? {}).some(
      (pending) => pending.localSid === localSid,
    );
  }

  private pendingOffset(sid: string): number {
    let offset = this.state.offsets[sid] ?? 0;
    for (const pending of this.state.pendingMirrors ?? []) {
      if (pending.sid === sid) offset = Math.max(offset, pending.endOffset);
    }
    return offset;
  }

  private pendingTitle(sid: string): string | undefined {
    let title = this.state.titles[sid];
    for (const pending of this.state.pendingMirrors ?? []) {
      if (pending.sid === sid && pending.title) title = pending.title;
    }
    return title;
  }

  private async poll(scope?: Set<string>): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      this.doPoll(scope);
      // ⚠️ 只有「本輪成功 **且** 沒有仍在重試的待確認批」才算恢復正常。無條件清空會把 NACK/
      // 方向不符/毒批留下的錯誤在下一輪 poll(5s 後)抹掉——而 health.ts 是 lastError 唯一的
      // 用戶可見出口,#348 要求的「明確報錯」就會落成「靜默凍結」:水位不動、UI 什麼也不說。
      // 只有沒有未結清錯誤時才算恢復正常（見 errorSticky）。
      if (!this.errorSticky) this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.errorSticky = true;
      this.counters.mirrorErrors += 1; // #10
      console.error("[mirror poll]", this.lastError);
    } finally {
      this.lastPollAt = Date.now();
      this.polling = false;
    }
  }

  /**
   * @param scope 給定時只處理這批 sid（定向輪詢，見 `drivenE2EWatch`）：不掃其餘 transcript、
   *   不做 prune / busy 活動上報、不置 `seeded`（置了會讓日後開啟鏡像時把全部存量會話當「新
   *   會話」從 0 灌一遍），且水位缺失時按 from-zero 處理（這些會話的內容本就該進 app）。
   */
  private doPoll(scope?: Set<string>): void {
    if (!this.linkb.isReady) return;
    const pendingMirrors = this.state.pendingMirrors ?? [];
    const pendingBackfills = Object.values(this.state.pendingE2EBackfills ?? {});
    for (const pending of pendingMirrors) {
      if (Date.now() - (this.sentBatchAt.get(pending.batchId) ?? 0) >= 15_000) {
        this.linkb.send(pending.frame as any);
        this.sentBatchAt.set(pending.batchId, Date.now());
      }
    }
    for (const pending of pendingBackfills) {
      if (Date.now() - (this.sentBatchAt.get(pending.batchId) ?? 0) >= 15_000) {
        for (const frame of pending.frames) this.linkb.send(frame as any);
        this.sentBatchAt.set(pending.batchId, Date.now());
      }
    }

    const now = Date.now();
    const activity: Array<{ hermesSessionId: string; busy: boolean }> = [];
    const all = discoverSessions();
    const found = scope ? all.filter((s) => scope.has(s.sid)) : all;
    if (!scope) this.prune(new Set(all.map((s) => s.sid)), now);
    for (const { sid, file } of found) {
      if (this.state.tombstones?.includes(sid)) continue; // #161 app 刪過 → 永不再撈
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      // #56 增長偵測（首見——含連接器剛啟動——不算增長，避免啟動即全體亮）。
      const prevSize = this.lastSizeAt.get(sid);
      this.lastSizeAt.set(sid, size);
      const grew = prevSize !== undefined && size !== prevSize;
      if (grew) this.lastGrowthAt.set(sid, now);
      // backfill 快照已发送但 server 尚未 ACK：冻结该 sid，避免普通 poll 抢先发送同一段或推进水位。
      if (this.hasPendingE2EBackfill(sid)) continue;
      // #154 基線策略(拍板翻轉,對齊 codex):**首掃**把既有 transcript 基線到文件末——裝上連接器
      // 不再把全部舊會話不請自來灌進側欄,歷史改走「導入」提示(全量/按 project/不導,app 端三選)。
      // 首掃之後新發現的會話 = 連接器運行期間新建 → 照舊從 0 全量鏡像(終端新會話實時可見不變)。
      if (!(sid in this.state.offsets)) {
        // 定向輪詢的目標是 app 自己建的 driven 會話 → 一律 from-zero（`seeded` 在 MIRROR=off
        // 下可能從未置過，按它走會把本會話誤基線到檔末、正文永遠不投）。
        this.state.offsets[sid] = scope || this.state.seeded ? 0 : size;
      }

      if (this.drivenSids.has(sid)) {
        // #200/#348 回合在途只让路；发送成功不代表 server 提交，绝不能预推水位。
        // driven 回合的工作態由 live 路徑權威投遞——鏡像側靜默讓路（不發 false 防踩 live 的 true）。
        this.busySids.delete(sid);
        this.quietPolls.delete(sid);
        continue;
      }
      // 已判定的內部 fork 檔/driven 殘片且沒長 → 不重讀（判據是「鏡像從未建過此會話」，
      // 見下方；driven 殘片水位線已被快進到 >0，不能用 offset===0 判）。
      if (!this.state.titles[sid] && this.internalAt.get(sid) === size) continue;

      // 追平：單會話分批發（每批 ≤ BATCH_MAX 條），單帧只裝一條會話 → 防超 server maxPayload(8MiB)。
      let guard = 0;
      while (guard++ < 2000) {
        const off = this.pendingOffset(sid);
        if (size <= off) break;
        const { entries, endOffset } = readEntries(file, off);
        if (!entries.length) break;
        // 自適應縮批(#268 二期):同一 sid 連續被 NACK 就對半縮條數上限(下限 1)。server 端的
        // 失敗常見於「這一批太大」(聚合條數/總字節撞限額),原樣重發同一批只會一直撞同一堵牆;
        // 縮到能過為止,ACK 後由 successShrink 逐步恢復。
        const shrink = this.nackShrink.get(sid) ?? 0;
        const effectiveMax = Math.max(1, Math.floor(batchMax() / 2 ** Math.min(shrink, 8)));
        const initialFold = foldEntries(entries, endOffset, Date.now(), effectiveMax);
        let byteBudget = 0;
        let messageLimit = 0;
        for (const message of initialFold.messages) {
          // 密文 base64/nonce/tag 也要留余量；最终 frame 仍由 sendOne 按实际 JSON 严格校验。
          const estimate = Buffer.byteLength(JSON.stringify(toImportMessage(message)), "utf8") * 2 + 512;
          if (messageLimit > 0 && byteBudget + estimate > MAX_WIRE_BYTES) break;
          byteBudget += estimate;
          messageLimit += 1;
        }
        const folded =
          initialFold.messages.length > Math.max(1, messageLimit)
            ? foldEntries(entries, endOffset, Date.now(), Math.max(1, messageLimit))
            : initialFold;
        const { consumedUpTo, title } = folded;
        // #318 先濾掉 live 已投的殘片(回合末晚落盤、逃過 fastForward)——防重複最後一塊。濾空的批次
        // 照常推進水位線(下方 consumedUpTo),只是不 emit;不影響「無 user 不建會話」等既有守衛。
        const messages = this.dropLivePosted(sid, folded.messages);
        // 「無真人消息就別建會話」判定：鏡像從未建過此會話（`!titles[sid]`）時,只有含 user 的批次
        // 才允許**創建**它;沒有一條 user 的批次一律跳過。涵蓋三類 driven/fork 殘片,都會冒影子會話:
        //   (1) 內部 fork 檔（subagent/後台任務，繼承標題無真人行）;
        //   (2) driven 回合末殘片——live 已在 ULID 下投遞、鏡像只 fastForward 快進,最後一塊 assistant
        //       在快進之後才落盤,水位線已被推過 0（2026-07-12 實測,故判據用 `!titles` 而非 `off===0`）;
        //   (3) **標題寫回**——CC 回合末把生成的標題寫回 CLI transcript(custom-title 行),鏡像讀到一個
        //       「只有 title、零消息」的批次,會走下面 `newTitle` 分支 emit 出去憑空建會話。故**不能加
        //       `messages.length` 條件**（那樣 title-only 批次繞過守衛,2026-07-13 實測復發）。
        // 真會話首批必含首條 user prompt,故不受影響;殘片會話後續出現真 user 即恢復全量鏡像。
        // 第二道(2026-07-13 / #395 重估):`drivenUuids.has(sid) && !mappedWireSid` —— 曾被驅動且
        // **沒有** wire 反向映射的 CLI uuid 永不單獨建會話(防影子)。有映射時(app ULID / 同源
        // uuid / E2E wire)終端續聊掛回原 wire——#389+#394 後此路徑不再「極少見」,必須回流;
        // 歷史 live 內容靠 #393 srcId 撞唯一索引去重,在途回合仍由 drivenSids 讓路。
        const mappedWireSid = this.e2eWireSidForLocal?.(sid);
        const knownTitle = this.pendingTitle(sid);
        if (
          !knownTitle &&
          ((!mappedWireSid && this.drivenUuids.has(sid)) ||
            !messages.some((m) => m.role === "user"))
        ) {
          this.internalAt.set(sid, size);
          break;
        }
        this.internalAt.delete(sid);
        // 標題優先級：流裡 custom-title > 已記標題 > 首條 user 截斷（分批時首批可能沒讀到 custom-title,
        // 先用 fallback，後續批讀到 custom-title 再更新）。
        const firstUser = messages.find((m) => m.role === "user")?.text.slice(0, 60);
        const candidate = title ?? (knownTitle ? undefined : firstUser);
        const newTitle = candidate && candidate !== knownTitle ? candidate : undefined;
        if (messages.length || newTitle) {
          const directE2ESid = this.e2e?.isE2E(sid) ? sid : undefined;
          const targetSid = mappedWireSid ?? directE2ESid ?? sid;
          if (!mappedWireSid && !directE2ESid && this.plaintextLocalAllowed?.(sid) === false) {
            console.error(
              `[mirror] E2E identity map 不可信，凍結未知 CC transcript ${sid}，不推水位/不發明文`,
            );
            break;
          }
          // 兜底自檢(2026-07-13 / #395):無 wire 映射卻為 driven CLI 走到「首次 emit(=建會話)」=
          // 上面守衛有洞,影子 session。阻止落地 + 記 mirrorGhostBlocked(正常恆 0)。有映射時
          // targetSid 是原 wire,屬合法回流,不觸發。
          if (!mappedWireSid && !knownTitle && this.drivenUuids.has(sid)) {
            this.counters.mirrorGhostBlocked += 1;
            console.error(
              `[mirror] ⚠️ 影子 session 兜底觸發:阻止為 driven CLI 會話 ${sid} 憑空建鏡像會話(守衛有洞?mirrorGhostBlocked=${this.counters.mirrorGhostBlocked})`,
            );
          } else {
            const sent = this.sendOne(
              sid,
              this.entry(targetSid, newTitle ?? knownTitle ?? "Claude Code", messages),
              consumedUpTo,
              newTitle,
            );
            if (sent) {
              if (!scope) this.state.seeded = true; // 定向輪詢沒掃存量,不得謊稱首掃完成
              continue;
            }
            break;
          }
        }
        if (consumedUpTo <= off) break; // 無進展（尾部全 in-flight）→ 下輪 poll
        // 只有没产生 wire mutation（例如 livePosted 已由实时路径确认覆盖）的行可本地消费。
        if (!messages.length && !newTitle) this.state.offsets[sid] = consumedUpTo;
      }

      // #56 工作態結算（內部 fork 檔不算——它們不是 server 端的真會話）。定向輪詢不上報活動。
      if (!scope && !this.internalAt.has(sid)) {
        const inFlight = (this.state.offsets[sid] ?? 0) < size;
        const recentGrowth = now - (this.lastGrowthAt.get(sid) ?? 0) < 90_000;
        if (grew || (inFlight && recentGrowth)) {
          this.quietPolls.set(sid, 0);
          this.busySids.add(sid);
          activity.push({ hermesSessionId: sid, busy: true }); // 轉變即生效、重申供 server TTL 續命
        } else if (this.busySids.has(sid)) {
          const quiet = (this.quietPolls.get(sid) ?? 0) + 1;
          this.quietPolls.set(sid, quiet);
          if (quiet >= 2) {
            this.busySids.delete(sid);
            this.quietPolls.delete(sid);
            activity.push({ hermesSessionId: sid, busy: false });
          }
        }
      }
    }
    if (activity.length) {
      this.linkb.send({ t: "mirror_activity", agentLinkId: this.linkb.agentLinkId, sessions: activity });
    }
    // ⚠️ 定向輪詢**不得**置 seeded:它沒掃過存量會話,置了等於謊稱「首掃完成」,日後開啟鏡像時
    // 全部存量會話會被當「新會話」從 0 全量灌一遍(#154 明確不要的行為)。
    if (!scope) this.state.seeded = true; // #154 首掃完成:此後新發現的會話才 from-zero
    this.save();
  }

  /** 單帧先按实际 JSON 字节校验并 WAL 落盘；mirror_ack 才提交 offset/title。 */
  private sendOne(
    sid: string,
    entry: Record<string, unknown>,
    endOffset: number,
    title?: string,
  ): boolean {
    const batchId = randomUUID();
    const frame = {
      t: "mirror_append",
      agentLinkId: this.linkb.agentLinkId,
      sessions: [entry],
      batchId,
    };
    if (Buffer.byteLength(JSON.stringify(frame), "utf8") > MAX_WIRE_BYTES) {
      this.lastError = `single mirror message exceeds ${MAX_WIRE_BYTES} byte frame budget (${sid})`;
      this.errorSticky = true;
      console.error(`[mirror] ${this.lastError}; watermark retained`);
      return false;
    }
    (this.state.pendingMirrors ??= []).push({ batchId, frame, sid, endOffset, title });
    this.save(true);
    this.linkb.send(frame);
    this.sentBatchAt.set(batchId, Date.now());
    this.counters.mirrorBatches += 1; // #10
    this.counters.mirrorMessages += Array.isArray((entry as any).messages) ? (entry as any).messages.length : 0;
    return true;
  }

  /** 構造批次條目；E2E 會話走加密（標題+內容盲存，srcId 是元數據保留）。 */
  private entry(sid: string, title: string, messages: CCMessage[]): Record<string, unknown> {
    const mapped = messages.map((m) => toImportMessage(m));
    if (this.e2e?.isE2E(sid)) {
      return {
        hermesSessionId: sid,
        title: this.e2e.encryptText(sid, title),
        source: "claude-code",
        e2e: true,
        messages: mapped.map((m) => ({
          role: m.role,
          ...(m.createdAt ? { createdAt: m.createdAt } : {}),
          srcId: m.srcId,
          enc: this.e2e!.encryptContent(sid, { text: m.text, reasoning: (m as any).reasoning, tools: (m as any).tools }),
        })),
      };
    }
    return { hermesSessionId: sid, title, source: "claude-code", messages: mapped };
  }

  /** §19 D2：E2E 開啟/關閉時全量歷史回灌（enable=密文、disable=明文；ACK 后才删 K_S）。 */
  async backfillE2E(
    wireSid: string,
    localSid: string | undefined,
    mode: "enable" | "disable" = "enable",
  ): Promise<void> {
    const e2e = this.e2e;
    if (!e2e) return;
    const pendingKey = `${mode}:${wireSid}`;
    const existing = this.state.pendingE2EBackfills?.[pendingKey];
    if (existing) {
      for (const frame of existing.frames) this.linkb.send(frame as any);
      this.sentBatchAt.set(existing.batchId, Date.now());
      return;
    }
    const file = localSid ? this.fileForSid(localSid) : null;
    const batchId = randomUUID();
    const base = {
      t: "e2e_backfill" as const,
      agentLinkId: this.linkb.agentLinkId,
      hermesSessionId: wireSid,
      mode,
      batchId,
    };
    const notFound = (): void => {
      const frame = { ...base, found: false } satisfies ConnectorE2EBackfill;
      (this.state.pendingE2EBackfills ??= {})[pendingKey] = {
        batchId,
        wireSid,
        localSid,
        mode,
        frames: [frame],
      };
      this.save(true);
      this.linkb.send(frame);
      this.sentBatchAt.set(batchId, Date.now());
      console.warn(
        `· E2E backfill(${mode}): no settled transcript for ${wireSid}` +
          (localSid ? ` (local ${localSid})` : " (no local session mapping)") +
          " → found:false" +
          (mode === "disable" ? " (disable failed, K_S kept)" : " (server history NOT replaced)"),
      );
    };
    /**
     * 本地歷史存在、但**編不出合法 wire 幀**（單條超幀預算 / 分片數超 512）。
     * ⚠️ 這裡絕不能 throw：唯一調用點是 `void ....catch(console.error)`，拋出等於一幀不發 →
     * server 的 pendingOp 永遠掛著、兩側 barrier 永不解除、該會話所有 prompt 靜默丟棄，**重啟
     * 也不救**。必須回一幀讓 server 出終態：`found:false` 是協議裡唯一的「連接器交不出回灌」
     * 信號，server 收到後回 `ok:false` + 釋放 quiesce barrier（disable 另清 pending、會話保持
     * 加密；enable 保持 pending 不誤報成功——那是 server 既有的安全設計）。錯誤同時掛 lastError
     * 上健康,用戶看得見。
     */
    const unrepresentable = (reason: string): void => {
      this.lastError = `E2E backfill(${mode}) ${wireSid}: ${reason}`;
      this.errorSticky = true;
      console.error(`[mirror] ${this.lastError} → 回 found:false 讓 server 出終態(不再靜默掛死)`);
      const frame = { ...base, found: false } satisfies ConnectorE2EBackfill;
      (this.state.pendingE2EBackfills ??= {})[pendingKey] = {
        batchId,
        wireSid,
        localSid,
        mode,
        frames: [frame],
      };
      this.save(true);
      this.linkb.send(frame);
      this.sentBatchAt.set(batchId, Date.now());
    };
    if (!localSid || !file) return notFound();
    const { entries, endOffset } = readEntries(file, 0);
    const { messages, title } = foldEntries(entries, endOffset, Number.MAX_SAFE_INTEGER); // 全結算（歷史快照）
    if (!messages.length) return notFound();
    const t = title ?? this.state.titles[localSid] ?? "Claude Code";
    const msgs: ImportMessage[] = messages.map((m) => {
      const im = toImportMessage(m);
      return mode === "enable"
        ? {
            role: im.role,
            text: "", // ImportMessage wire 必填；密文路徑 server 只讀 enc，不投影此空字串。
            ...(im.createdAt !== undefined ? { createdAt: im.createdAt } : {}),
            ...(im.srcId ? { srcId: im.srcId } : {}),
            enc: e2e.encryptContent(wireSid, { text: im.text, reasoning: im.reasoning, tools: im.tools }),
          }
        : im;
    });
    const session = {
      hermesSessionId: wireSid,
      title: mode === "enable" ? e2e.encryptText(wireSid, t) : t,
      source: "claude-code",
      ...(mode === "enable" ? { e2e: true } : {}),
      messages: msgs,
    } satisfies ImportSession;
    // 只有完整明文 snapshot 已成功构造后才签 release receipt；先持久化 receipt，再释放 frame。
    const disableReceipt =
      mode === "disable" ? e2e.disableReceiptForBackfill(wireSid) : undefined;
    const frame = {
      ...base,
      found: true,
      session,
      ...(disableReceipt ? { disableReceipt } : {}),
    } satisfies ConnectorE2EBackfill;
    const messageChunks: ImportMessage[][] = [];
    let current: ImportMessage[] = [];
    for (const message of session.messages) {
      const candidate = [...current, message];
      // 探測用**最壞情況**分片元數據:真幀是 `chunkIndex:<n>, chunkCount:<m>`,比 0/1 多幾個
      // 字節。用 0/1 探測會讓臨界批在真發時超預算(只能靠下面的兜底校驗發現,整次轉換就廢了)。
      const probe = {
        ...frame,
        session: { ...session, messages: candidate },
        chunkIndex: MAX_BACKFILL_CHUNKS - 1,
        chunkCount: MAX_BACKFILL_CHUNKS,
      };
      if (Buffer.byteLength(JSON.stringify(probe), "utf8") > MAX_WIRE_BYTES) {
        if (!current.length) {
          return unrepresentable(
            `single E2E backfill message exceeds ${MAX_WIRE_BYTES} byte frame budget`,
          );
        }
        messageChunks.push(current);
        current = [message];
      } else {
        current = candidate;
      }
    }
    if (current.length) messageChunks.push(current);
    if (messageChunks.length > MAX_BACKFILL_CHUNKS) {
      return unrepresentable(`E2E backfill requires more than ${MAX_BACKFILL_CHUNKS} chunks`);
    }
    const frames = messageChunks.map((chunk, chunkIndex) => ({
      ...frame,
      session: { ...session, messages: chunk },
      chunkIndex,
      chunkCount: messageChunks.length,
    }));
    if (
      frames.some(
        (chunk) => Buffer.byteLength(JSON.stringify(chunk), "utf8") > MAX_WIRE_BYTES,
      )
    ) {
      // 走到這裡說明上面的最壞情況探測仍不夠保守(不該發生)——照樣回終態,不靜默掛死。
      return unrepresentable(
        `single E2E backfill message exceeds ${MAX_WIRE_BYTES} byte frame budget`,
      );
    }
    (this.state.pendingE2EBackfills ??= {})[pendingKey] = {
      batchId,
      wireSid,
      localSid,
      mode,
      frames,
      endOffset,
    };
    this.save(true);
    for (const chunk of frames) this.linkb.send(chunk);
    this.sentBatchAt.set(batchId, Date.now());
    console.log(
      `· E2E backfill(${mode}) submitted for ${wireSid} (local ${localSid}; ${msgs.length} messages / ${frames.length} chunks; waiting for server ACK)`,
    );
  }

  /** #9:offsets/titles 無界增長治理——轉錄文件消失連續 PRUNE_MS 才裁(短暫缺席回歸即清)。
   * 被裁 sid 理論上不回歸(uuid 不復用);萬一回歸,走「未知會話從 0 全量」語義,srcId 去重兜住。 */
  private prune(liveSids: Set<string>, now: number): void {
    const ma = (this.state.missingAt ??= {});
    let pruned = 0;
    for (const sid of Object.keys(this.state.offsets)) {
      if (liveSids.has(sid)) {
        delete ma[sid];
        continue;
      }
      const since = (ma[sid] ??= now);
      if (now - since > PRUNE_MS) {
        delete this.state.offsets[sid];
        delete this.state.titles[sid];
        delete ma[sid];
        pruned += 1;
      }
    }
    for (const sid of Object.keys(ma)) if (!(sid in this.state.offsets)) delete ma[sid];
    if (pruned) console.log(`· #9 裁剪 ${pruned} 個已消失轉錄的水位線(剩 ${Object.keys(this.state.offsets).length})`);
  }

  private load(): State {
    // #6 同款兜底:主文件損壞/丟失 → 試 .bak(上一版)。CC 的未知會話語義是「從 0 全量 +
    // srcId 去重」,重置代價是全量重發而非丟消息,但 .bak 能把重發也省了。
    for (const [p, isBak] of [[statePath(), false], [`${statePath()}.bak`, true]] as Array<[string, boolean]>) {
      try {
        const s = JSON.parse(readFileSync(p, "utf8")) as State;
        if (isBak) console.error(`⚠️ ${statePath()} 損壞/丟失 → 已從 .bak 恢復`);
        return {
          offsets: s.offsets ?? {},
          titles: s.titles ?? {},
          missingAt: s.missingAt ?? {},
          tombstones: s.tombstones ?? [], // #161
          // #154:舊安裝(有水位線,歷史已全量鏡過)視為已 seeded;白名單漏字段的教訓——顯式帶上。
          seeded: s.seeded ?? Object.keys(s.offsets ?? {}).length > 0,
          pendingMirrors: Array.isArray(s.pendingMirrors) ? s.pendingMirrors : [],
          pendingE2EBackfills:
            s.pendingE2EBackfills && typeof s.pendingE2EBackfills === "object"
              ? s.pendingE2EBackfills
              : {},
        };
      } catch {
        /* 下一個候選 */
      }
    }
    return {
      offsets: {},
      titles: {},
      missingAt: {},
      pendingMirrors: [],
      pendingE2EBackfills: {},
    };
  }
  private lastSaved = "";
  private save(strict = false): void {
    try {
      // #262 dirty 判斷:序列化與上次落盤相同 → 跳過(每 5s 無條件寫盤兩份=主+.bak,≈3.4 萬次/天
      // 傷 SD 卡)。JSON.stringify 遠比兩次 write+rename 便宜。
      const json = JSON.stringify(this.state);
      if (json === this.lastSaved) return;
      // #6:上一版留作 .bak（同樣 0600——它裝的是上一版的完整正文）。
      if (existsSync(statePath())) durableWrite(`${statePath()}.bak`, this.lastSaved || json);
      durableWrite(statePath(), json); // 原子寫（審計 #6 的教訓：別半截損壞）
      this.lastSaved = json;
    } catch (error) {
      if (strict) throw error;
    }
  }
}
