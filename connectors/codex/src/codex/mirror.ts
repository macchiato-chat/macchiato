/**
 * §15 鏡像:tail Codex rollout JSONL → mirror_append 到 Macchiato。
 *  - 枚舉 ~/.codex/sessions 下的 rollout-*.jsonl(零依賴文件遍歷,不碰 state sqlite——
 *    node:sqlite 要 Node≥22.5,公開分發不能假設)。cwd 從 session_meta、標題從首條 user 消息。
 *  - 字節偏移水位線,半行留到下輪;新會話只鏡像啟動後的消息(baseline=當前文件末)。
 *  - driven 會話(本進程 codex exec 驅動)live 獨佔投遞;回合末**不再快進水位**(#200/#348:未經
 *    server ACK 絕不推進),明文靠 #393 的 srcId 去重、E2E 靠 durable outbox 補投。曾被驅動過的
 *    thread 由 `drivenUuids` 守衛兜底,鏡像永不以本地 threadId 另建明文影子會話。
 *  - durable outbox(#348):幀落盤後才發,只有 `mirror_ack` 才提交水位;`mirror_nack` 默認保留原批
 *    重發,終態 `code`(`e2e_direction` 方向翻轉 / `malformed` 畸形毒批)則丟批——見 `handleNack`。
 *  - .jsonl.zst(7 天後壓縮)v1 跳過(已過 baseline,不影響增量;history-import 記數不靜默丟)。
 */
import { createHash, randomUUID } from "node:crypto";
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
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { LinkBClient } from "../_core/linkb/client";
import type { E2EKeyStore } from "../_core/e2e/keys";
import {
  ThreadRegistry,
  type ThreadRegistrySnapshot,
} from "../_core/threads/registry";
import {
  isHiddenKind,
  parseOrigin,
  resolveConversationId,
  toWireOrigin,
  type ThreadOrigin,
} from "./origin";
import { threadName } from "./session-index";
import {
  isCodexInternalHistoryText,
  messagesWithTurns,
  nextOrdAtEof,
  readNewMessages,
  readRolloutPreamble,
  readRolloutTail,
  sessionsRoot,
  type CodexMessage,
} from "./transcripts";

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


const POLL_MS = Number(process.env.MACCHIATO_CODEX_POLL_MS) || 5000;
const MAX_WIRE_BYTES = Number(process.env.MACCHIATO_MIRROR_FRAME_BYTES) || 2 * 1024 * 1024;
/** E2E 回灌分片上限（server 側 parseE2EBackfillFrame 同值硬校驗）。 */
const MAX_BACKFILL_CHUNKS = 512;
/** #9:rollout 文件消失多久後裁掉水位線(默認 7 天;uuid 不復用,不會回歸)。 */
const PRUNE_MS = Number(process.env.MACCHIATO_MIRROR_PRUNE_MS) || 7 * 24 * 3600 * 1000;

function statePath(): string {
  return process.env.MACCHIATO_CODEX_MIRROR || join(homedir(), ".macchiato/codex-mirror.json");
}

/** rollout 文件名嵌 thread uuid:rollout-<ts>-<uuid>.jsonl → uuid(= server 認的 sid)。 */
export function threadIdFromFile(file: string): string | undefined {
  const m = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file);
  return m?.[1];
}

export interface RolloutFile {
  file: string;
  threadId: string;
}

/** 遞歸枚舉全部未壓縮 rollout 文件(跳過 .zst);返回 {file, threadId}。 */
export function discoverRollouts(root = sessionsRoot()): { rollouts: RolloutFile[]; compressed: number } {
  const rollouts: RolloutFile[] = [];
  let compressed = 0;
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".jsonl.zst")) compressed += 1;
      else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
        const threadId = threadIdFromFile(name);
        if (threadId) rollouts.push({ file: p, threadId });
      }
    }
  };
  walk(root);
  return { rollouts, compressed };
}

/**
 * #946 IDE 注入塊剝離。VS Code / Cursor 這類宿主會把上下文塞進**首條 user 消息**：
 *
 *   # Context from my IDE setup:      （本機 152 條）
 *   ## Open tabs: …
 *   ## My request for Codex:
 *   修改我的插件版本号为1.0.0          ← 用戶真正說的話
 *
 * 生產庫裡 117 條會話的標題就是這種機器文本開頭——同一個項目下好幾條長得一模一樣，
 * 用戶連「哪條是哪條」都分不出來。真請求永遠在 `## My request for Codex:` 之後。
 * 取不到正文（用戶只貼了附件、沒寫字）→ 返回空串，調用方換下一條消息取標題。
 */
export function stripIdeContext(message: string): string {
  const marker = /(?:^|\n)##[ \t]*My request for Codex:[ \t]*\r?\n?/.exec(message);
  return marker ? message.slice(marker.index + marker[0].length) : message;
}

/**
 * 從 rollout 內容派生標題與 cwd(session_meta)。
 *
 * #946 標題優先用源系統自己起的名字（`~/.codex/session_index.jsonl` 的 `thread_name`），
 * 拿不到才回退首條 user 消息截斷（並剝掉上面的 IDE 注入塊）。`threadId` 傳的是**對話**的 id
 * ——派生線程要拿父會話的名字，不是自己的。
 */
export function deriveMeta(content: string, threadId?: string): { title: string; cwd?: string } {
  let cwd: string | undefined;
  let title = "";
  for (const line of content.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o: any;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (o.type === "session_meta") cwd = (o.payload ?? o).cwd;
    if (!title && o.type === "event_msg" && o.payload?.type === "user_message" && typeof o.payload.message === "string") {
      if (isCodexInternalHistoryText(o.payload.message)) continue;
      const text = stripIdeContext(o.payload.message).replace(/\s+/g, " ").trim();
      if (!text) continue; // 純 IDE 上下文塊 → 換下一條真人消息
      title = [...text].slice(0, 56).join(""); // 按碼點截,不劈開 emoji
    }
    if (cwd && title) break;
  }
  return { title: threadName(threadId) || title || "Codex", cwd };
}

/**
 * #789 / #918 / #946: 非用戶頂層線程不得成為用戶可見會話。
 *
 * 判據已上移到 `origin.ts` 的 `parseOrigin`（源系統聲明優先、正文啟發式降級成兜底），
 * 這裡只是它的布爾投影，**語義與 reason 逐字保持** #789 的舊行為：
 * subagent / internal / fork（`forked_from_id` 等派生歸屬）一律跳。
 *
 * ⚠️ 鏡像已**不再**用這個口徑（見 `Mirror.metadataFor`）：fork 在鏡像裡改走「歸屬父會話」，
 * 整檔丟掉會讓用戶在終端 rewind 後那條會話靜默停更。歷史導入仍用這裡的保守口徑——
 * 導入是整檔灌庫，把 fork 併進父會話會把 fork 複製的那段歷史再灌一遍。
 */
export function shouldSkipRollout(content: string): { skip: boolean; reason?: string } {
  const origin = parseOrigin(content);
  if (origin.kind === "user") return { skip: false };
  return { skip: true, ...(origin.reason ? { reason: origin.reason } : {}) };
}

/** §9 去重身份:rollout 行無 uuid → 內容指紋(role+text+ord 的 sha256 前綴),確定性、逐字節穩定。 */
export function srcIdFor(threadId: string, m: CodexMessage): string {
  return createHash("sha256").update(`${threadId} ${m.role} ${m.ord} ${m.text}`).digest("hex").slice(0, 24);
}

interface State {
  offsets: Record<string, number>; // threadId → 字節水位線
  ords: Record<string, number>; // threadId → 下一起始行號(ord 連續)
  /** #9:threadId 的 rollout 首次消失的時刻;回歸即清,超 PRUNE_MS 連 offsets/ords 一起裁。 */
  missingAt?: Record<string, number>;
  /** #161 墓碑:app 刪過的 thread,鏡像永不再撈(rollout 檔案不動)。 */
  tombstones?: string[];
  /** #236 首掃已建基線(持久,對齊 CC #154):此後新發現的 rollout 才從頭鏡像。 */
  seeded?: boolean;
  /**
   * #966 `ThreadRegistry` 快照（對話 ↔ 歷代執行線程）。持久化借用本狀態檔——它已經有原子寫、
   * fsync、.bak，再造一份只會多一處不一致（registry 模塊刻意不落盤，見其註釋）。
   */
  threadRegistry?: ThreadRegistrySnapshot;
  /** #348/#350 WAL：送出前已落盤；ACK 才把候選 offsets/ords 提交。 */
  pendingMirrors?: Array<{
    batchId: string;
    frame: Record<string, unknown>;
    offsets: Record<string, number>;
    ords: Record<string, number>;
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
      endOrd?: number;
    }
  >;
}

interface RolloutMetadata {
  title: string;
  cwd?: string;
  /** #946 源系統聲明的身份與歸屬。 */
  origin: ThreadOrigin;
  /** 鏡像口徑的整檔跳過：只有 subagent / internal（fork 改走歸屬，見 `pollOnce`）。 */
  skip: { skip: boolean; reason?: string; inferred?: boolean };
}

export class Mirror {
  private state: State;
  /**
   * #966 對話 ↔ 歷代執行線程（`connector-core` 的公共設施，四家共用；此前 codex 自己沒有這張表，
   * 每輪都靠重掃 rollout 現算歸屬）。它管兩件事：
   *
   *  1. **上報身份不隨檔案消失而漂移**：`resolveConversationId` 靠父 rollout 在盤上才走得通，
   *     父檔被壓縮成 .zst / 被裁掉之後同一條派生線程會解到另一個 id ——那就是一次身份輪換，
   *     server 另起一行、K_S 查不到（#807）。登記過的線程一律用登記時確立的那個身份。
   *  2. **E2E 別名認親**：身份換過的會話，K_S 還壓在舊鍵下，`E2EKeyStore` 靠這張表的
   *     `aliasesFor` 找回來（`setIdentityAliases`）。別名歷史不可信時它恒為空 → 逐字節退回老行為。
   */
  private registry: ThreadRegistry;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly drivenIds = new Set<string>();
  /** title/cwd/internal 判據只來自 rollout 頭部；每個活躍文件在進程內最多掃一次。 */
  private readonly rolloutMetadata = new Map<string, RolloutMetadata>();
  /**
   * 影子兜底(對齊 CC mirror 的 `drivenUuids`,2026-07-12 事故同款):**曾被 Macchiato 驅動過**的
   * 本地 thread uuid(由 Drive 從 wire→local 映射灌入,跨重啟)。這些 thread 的正文由 live 在 wire
   * sid(ULID)下獨佔投遞——鏡像**永不**以本地 threadId 另建明文會話。缺這道守衛時:`fastForward`
   * 不再推水位 → `unsetDriven` 觸發的 poll 讀到 `offsets[threadId] === undefined` → `startOff=0`
   * → 以 `hermesSessionId: threadId` 全量重發 → server `createIfMissing` 建出含全部正文的第二個
   * 明文會話(`dedup_key` 是 `(session_id, dedup_key)` 複合唯一,跨會話救不了)。
   */
  private readonly drivenUuids = new Set<string>();
  /** 已攔下的 ghost thread → 上次見到的檔案大小(只在增長時再記一次日誌,不每輪刷屏)。 */
  private readonly ghostAt = new Map<string, number>();
  /**
   * #308 `MACCHIATO_MIRROR=off` 下仍需**定向**輪詢的 thread：app 建的、受 E2E 保護的 driven
   * 會話。它們的正文只有鏡像一條投遞路（live 不投密文正文），而 off 下沒有全量輪詢定時器。
   */
  private readonly drivenE2EWatch = new Set<string>();
  private readonly sentBatchAt = new Map<string, number>();
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
    mirrorGhostBlocked: 0, // 攔下的「為 driven thread 憑空建明文會話」次數(正常應恆 0)
    mirrorDirectionRewinds: 0, // E2E 方向翻轉導致丟棄凍結批、回退重編的次數
    mirrorDropped: 0, // server 判畸形/毒批而丟棄跳過的批次數(非 0 = 有內容沒進 app)
    mirrorInternalSkipped: 0, // #789: guardian / subagent / fork 等內部 rollout 被整檔跳過的次數
    // #946 兜底判據的用量：源系統沒聲明、只能靠正文啟發式認出的內部 rollout。
    // 與上面那個分開記才看得出「上游還寫不寫聲明」——這個數字漲 = 又有一批老格式/新形態在靠猜。
    mirrorInferredSkipped: 0,
    // #946 派生線程掛回父會話的次數（終端 rewind/fork 後續聊不再靜默停更）。
    mirrorForkAdopted: 0,
    // #966 E2E 身份閘攔下的次數：派生線程自己持鑰、且對話身份下查不到同一把 → 維持舊身份
    // （＝老行為整檔跳過）。**非 0 = 有 E2E 會話沒享受到 rewind 修復**，但絕不誤把密文降級明文，
    // 也絕不新生成 K_S（那會讓此前的密文永久解不開，#807）。
    mirrorE2EIdentityHeld: 0,
  };
  private polling = false;

  /** #308 MACCHIATO_MIRROR=off:停鏡像輪詢(終端側活動不進 app)。⚠️ 只停這一樣——
   * fastForward/墓碑/E2E backfill 是 driven 會話衛生,必須照常跑,多關 = 雙投回歸(#161)。 */
  readonly disabled = /^(off|0|false|no)$/i.test(process.env.MACCHIATO_MIRROR ?? "");

  constructor(
    private readonly linkb: LinkBClient,
    private readonly e2e?: E2EKeyStore,
    /** app-driven 會話的本地 thread UUID → E2E wire ULID；避免終端續聊另建明文影子會話。 */
    private readonly e2eWireSidForLocal?: (localSid: string) => string | undefined,
    /** 身份快照不可信時，未知本地 UUID 不得回落成 plaintext shadow。 */
    private readonly plaintextLocalAllowed?: () => boolean,
  ) {
    this.state = this.load();
    try {
      this.registry = ThreadRegistry.parse(this.state.threadRegistry);
    } catch (error) {
      // 快照非法 **絕不能**當成「這些對話沒有別名」放行（#347 那一刀）：空且不可信才是對的，
      // 於是 aliasesFor 恒空 → 身份閘維持舊身份，不會拿一個猜的鍵去解密。
      console.error(`[mirror] thread registry 快照非法 → 按空且不可信重建：${(error as Error).message}`);
      this.registry = ThreadRegistry.empty();
    }
    // #950 keystore 的別名認親（只讀側，不改盤上的鍵）。不可信時解析器恒返回空數組 ⇒ 與注入前
    // 逐字節等價，所以無條件注入是安全的。
    this.e2e?.setIdentityAliases?.(this.registry.identityAliasResolver());
  }

  /**
   * #966/#347 宣告「別名歷史完整」。判據照抄 openclaw：**權威 server 快照已套用 ∧ 此刻一條受
   * 保護的 E2E 會話都沒有** —— 沒有 K_S 就沒有東西可丟，從此刻起這張表確實涵蓋完整歷史。
   *
   * 反過來一旦錯過（機器上已經有 E2E 會話），就**持久 false、永不自升**：`aliasHistoryTrusted`
   * 不可由「字段存在」推斷，這正是 #347 的原話。不可信 ⇒ 別名恒空 ⇒ 身份閘維持舊身份。
   *
   * 由 Link B ready（`applyServerState` 之後）調用——那是唯一能保證快照權威的時點。
   */
  adoptThreadHistoryIfProvable(): void {
    if (this.registry.historyTrusted) return;
    if (!this.e2e?.hasServerStateSnapshot?.()) return;
    if (this.e2e.protectedSessionIds().length > 0) return;
    if (!this.registry.adoptHistory(true)) return;
    this.save(true);
    console.log("· #966 thread registry 別名歷史已標記可信（零受保護 E2E 會話 + 權威快照已套用）");
  }

  private metadataFor(file: string): RolloutMetadata {
    const cached = this.rolloutMetadata.get(file);
    if (cached) return cached;
    const preamble = readRolloutPreamble(file);
    const origin = parseOrigin(preamble.content, threadIdFromFile(basename(file)) ?? "");
    const metadata: RolloutMetadata = {
      // 標題取**對話**的名字：派生線程掛回父會話時顯示父會話的名字，不是子線程自己的。
      ...deriveMeta(preamble.content, origin.conversationId),
      origin,
      skip: isHiddenKind(origin.kind)
        ? {
            skip: true,
            ...(origin.reason ? { reason: origin.reason } : {}),
            ...(origin.evidence === "inferred" ? { inferred: true } : {}),
          }
        : { skip: false },
    };
    // 空 rollout 之後可能才出現首條 user message；標題尚未確定時不把 Codex fallback 鎖死。
    if (preamble.hasUserMessage || metadata.skip.skip) {
      this.rolloutMetadata.set(file, metadata);
    }
    return metadata;
  }

  /**
   * #946 這條 rollout 的內容該落到哪段對話。
   *
   * 根線程（`session_id === id`、或老格式什麼都沒聲明）解出來就是 `threadId` 自己——本機
   * 825/1399、生產 478/671 的正常會話一個字節都不變，這是本改動最重要的性質。
   * 派生線程則沿判據鏈解到**根**（fork 的 fork 只認直接父會歸到一個 app 裡從不存在的中間
   * 線程上，等於又建一條新會話）。父 rollout 已被壓縮/刪除時就地停下，直接父就是最好的答案。
   */
  private conversationSidFor(
    threadId: string,
    origin: ThreadOrigin,
    rollouts: RolloutFile[],
  ): string {
    // #966 登記過的線程直接用登記時確立的身份：判據鏈要沿着**盤上的父 rollout** 走，父檔被
    // 壓縮/裁掉之後同一條線程會解出另一個 id ——那是一次靜默的身份輪換（server 另起一行、
    // K_S 查不到）。登記表就是為了讓這件事不可能發生。
    const known = this.registry.conversationOf(threadId);
    if (known) return this.registry.wireIdentityOf(known) ?? known;
    if (origin.conversationId === threadId) return threadId; // 根線程：不佔登記表（見下）
    const resolved = resolveConversationId(origin, (id) => {
      const rf = rollouts.find((r) => r.threadId === id);
      if (!rf) return undefined;
      try {
        return this.metadataFor(rf.file).origin;
      } catch {
        return undefined;
      }
    });
    if (resolved === threadId) return threadId;
    // 判據鏈只走得到盤上還在的那一環——同一段對話在不同時刻可能停在不同的中間線程上。
    // 登記表知道那一環屬於哪段對話，先歸一化過去，別為同一段對話另立一份。
    const conversationId = this.registry.conversationOf(resolved) ?? resolved;
    // **只登記真的發生了歸屬的線程**：根線程身份恒等於自己、不會輪換，全登記進去只是讓這張
    // 表跟着 rollout 數量無界長（#9 治理過同一個病）。先把對話 id 自己登記成首個線程，確立的
    // 上報身份就是它——與 #946 落地時的行為逐字節相同，不因為誰先被發現而改變。
    try {
      this.registry.record(conversationId, conversationId);
      this.registry.record(conversationId, threadId);
    } catch (error) {
      // I1 被打破（上游給的血緣自相矛盾）：響亮記一筆，本輪按解析結果走，不靜默改歸屬。
      console.error(`[mirror] thread registry 拒絕登記 ${threadId} → ${conversationId}：${(error as Error).message}`);
      return conversationId;
    }
    return this.registry.wireIdentityOf(conversationId) ?? conversationId;
  }

  /**
   * #966 這條本地 thread 當前的 E2E 身份（wire sid）：app-driven 會話走 ULID 映射，
   * 終端側被 app 開啟 E2E 的會話就是它自己。`undefined` = 這條線程不受 E2E 保護。
   *
   * `isE2E` 內部會走 keystore 的別名認親（見 `setIdentityAliases`），所以身份換過的會話同樣認得出。
   */
  private e2eSidFor(sid: string): string | undefined {
    const mapped = this.e2eWireSidForLocal?.(sid);
    if (mapped) return mapped;
    return this.e2e?.isE2E(sid) ? sid : undefined;
  }

  /**
   * #966 這條本地 thread **自己**（不經別名）持有的 E2E 身份。
   *
   * 為什麼不能用 `e2eSidFor`：`isE2E` 會走別名認親，於是「同一段對話裡有任何一條線程持鑰」
   * 就會讓**每條兄弟線程**都答 true —— 拿它做身份閘，剛 fork 出來的空線程也會被判成「自己
   * 有鑰匙」，閘門永遠關着，rewind 修復對真正的 E2E 用戶等於沒做。身份閘要問的是**直接**
   * 持有：app-driven 的 wire 映射，或它本身就在 keystore 的受保護集合裡。
   */
  private directE2ESidFor(sid: string, protectedSids: ReadonlySet<string>): string | undefined {
    const mapped = this.e2eWireSidForLocal?.(sid);
    if (mapped) return mapped;
    return protectedSids.has(sid) ? sid : undefined;
  }

  /**
   * keystore 直接持鑰 / server protection floor 的完整身份集（每輪取一次快照）。
   * keystore 已 poison 時這裡會拋 —— 交給 `poll` 的 catch 記 lastError（與 encryptText 拋出
   * 同一條路），**不吞**：吞掉就等於在一個看不見保護狀態的 keystore 上放行身份切換。
   */
  private protectedSidSnapshot(): ReadonlySet<string> {
    return new Set(this.e2e?.protectedSessionIds?.() ?? []);
  }

  /**
   * #946 fork 檔的分叉點：fork 出來的 rollout 開頭是父會話歷史的**逐字副本**，這段內容
   * app 裡已經有了。與父 rollout 逐條比 (role, text) 求最長公共前綴，水位坐到其後。
   *
   * 讀不到父檔（已壓縮成 .zst / 已刪 / 已裁）→ 保守坐到 EOF：寧可丟掉這一瞬間的尾巴，
   * 也不能把幾百條歷史複製進用戶會話（#926 截圖裡的「305 條被複製三份」就是這麼來的）。
   */
  private forkBaseline(
    content: string,
    origin: ThreadOrigin,
    rollouts: RolloutFile[],
  ): { offset: number; ord: number } {
    const eof = { offset: Buffer.byteLength(content, "utf8"), ord: nextOrdAtEof(content) };
    const parentId = origin.parentThreadId ?? origin.conversationId;
    const parentFile = rollouts.find((r) => r.threadId === parentId)?.file;
    if (!parentFile) return eof;
    let parentMessages: CodexMessage[];
    try {
      parentMessages = readNewMessages(readFileSync(parentFile, "utf8"), 0, 0).messages;
    } catch {
      return eof;
    }
    const own = readNewMessages(content, 0, 0).messages;
    let shared = 0;
    while (
      shared < own.length
      && shared < parentMessages.length
      && own[shared]!.role === parentMessages[shared]!.role
      && own[shared]!.text === parentMessages[shared]!.text
    ) {
      shared += 1;
    }
    const cut = readNewMessages(content, 0, 0, shared);
    return { offset: cut.newOffset, ord: cut.lineCount };
  }

  /** #161 墓碑:永不再鏡像此 thread(持久;rollout 不動)。 */
  tombstone(threadId: string): void {
    const t = (this.state.tombstones ??= []);
    if (!t.includes(threadId)) {
      t.push(threadId);
      this.save();
      console.log(`· 墓碑 ${threadId}(鏡像永不再撈)`);
    }
  }

  setDriven(threadId: string): void {
    this.drivenIds.add(threadId);
    this.drivenUuids.add(threadId);
    if (this.disabled && this.isE2ESession(threadId)) this.watchDrivenE2E(threadId);
  }

  /** 該本地 thread 當前是否受 E2E 保護（有 wire 映射或本地直接持鑰）。 */
  private isE2ESession(threadId: string): boolean {
    return !!this.e2eSidFor(threadId);
  }

  /**
   * #350 回合末尾巴追讀的排程（每 thread 一組，重入即取代）。間隔前密後疏，且全部落在一個
   * POLL_MS 之內——超出的部分本來就由常規 tick 接手，不會疊加成重複輪詢。
   */
  private readonly tailPollTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  private static readonly TAIL_POLL_DELAYS_MS = [250, 700, 1500, 3000];

  private scheduleTailPolls(threadId: string): void {
    this.cancelTailPolls(threadId);
    const scope = new Set([threadId]);
    const timers = Mirror.TAIL_POLL_DELAYS_MS.map((delay) => {
      const timer = setTimeout(() => void this.poll(scope), delay);
      timer.unref?.(); // 純加速用，絕不因此拖住進程退出
      return timer;
    });
    this.tailPollTimers.set(threadId, timers);
  }

  private cancelTailPolls(threadId: string): void {
    for (const timer of this.tailPollTimers.get(threadId) ?? []) clearTimeout(timer);
    this.tailPollTimers.delete(threadId);
  }

  /** MIRROR=off 下仍需定向輪詢的 app-driven E2E thread（有界 FIFO，防無限增長）。 */
  private watchDrivenE2E(threadId: string): void {
    this.drivenE2EWatch.add(threadId);
    while (this.drivenE2EWatch.size > 64) {
      this.drivenE2EWatch.delete(this.drivenE2EWatch.values().next().value!);
    }
  }

  /** 影子兜底:登記「曾被 Macchiato 驅動」的本地 thread uuid(Drive 在建映射時、及啟動時批量灌入)。 */
  markDrivenUuid(threadId: string): void {
    if (threadId) this.drivenUuids.add(threadId);
  }

  /**
   * 該 thread 是否只能走 wire 身份(driven 過且當前沒有 E2E wire 映射)→ 明文鏡像一律不得落地。
   * E2E 會話由 `e2eWireSidForLocal` 映射回 wire sid,走密文路徑,不受此守衛影響。
   */
  private isDrivenGhost(threadId: string): boolean {
    if (!this.drivenUuids.has(threadId)) return false;
    if (this.e2eWireSidForLocal?.(threadId)) return false;
    return !this.e2e?.isE2E(threadId);
  }

  unsetDriven(threadId: string): void {
    this.drivenIds.delete(threadId);
    // #350 回合末尾巴的**定向**追讀（與 CC mirror 同款）。E2E driven 回合的正文只有 rollout
    // 檔這一條路（live 不投密文），而回合 result 常早於 Codex 把尾巴寫完 → 下面這次即時 poll
    // 讀不到最後一塊，就得等滿一個 POLL_MS（5s）的常規 tick，用戶側就是「延遲 0–5s、常拆兩段」。
    // 補幾次短間隔定向 poll 把尾巴追平壓到亞秒級。純調度改動，內容源仍只有 rollout 檔。
    if (this.isE2ESession(threadId)) this.scheduleTailPolls(threadId);
    if (this.disabled) {
      // #308 MIRROR=off:**絕不**全量 poll(那會把用戶明確要求不進 app 的終端會話全掃進去)。
      // 只對受 E2E 保護的 app-driven thread 做定向投遞,並登記進 watch 讓定向輪詢持續兜住。
      if (this.isE2ESession(threadId)) {
        this.watchDrivenE2E(threadId);
        void this.poll(new Set([threadId]));
      }
      return;
    }
    void this.poll();
  }

  private hasPendingE2EBackfill(localSid: string): boolean {
    return Object.values(this.state.pendingE2EBackfills ?? {}).some(
      (pending) => pending.localSid === localSid,
    );
  }

  /**
   * #393 回合末只讀快照:折出該會話 rollout 全量消息並附 srcId(= srcIdFor 內容指紋),供 Drive
   * 把 live 投遞過的 user/agent 消息回填 srcId 作 server dedup_key。srcId 含**全文行號 ord**,故必須
   * 從檔頭 ord=0 全量折(不能只讀尾段——ord 會錯,與鏡像發的 srcId 對不上)。純只讀:不推水位、不 emit。
   * E2E 會話由加密批攜 srcId,不走這裡(調用方已隔離)。
   */
  srcIdSnapshot(threadId: string): Array<{ role: "user" | "agent"; text: string; srcId: string }> {
    const rf = discoverRollouts().rollouts.find((r) => r.threadId === threadId);
    if (!rf || !existsSync(rf.file)) return [];
    try {
      const content = readFileSync(rf.file, "utf8");
      const { messages } = readNewMessages(content, 0, 0);
      return messages.map((m) => ({ role: m.role, text: m.text, srcId: srcIdFor(threadId, m) }));
    } catch {
      return [];
    }
  }

  /** #350 driven 結束只解除排他；未經 server ACK 絕不快進(明文 live 靠 #393 srcId 去重)。 */
  fastForward(threadId: string): void {
    void threadId;
  }

  /**
   * #473 rewind 的**只讀**勘察(對齊 cc mirror.rewindPlan 的角色):在 threadId 的 rollout 裡
   * 找 targetSrcId,回:
   *  - `lastTurnId`:要**保留**的最後一個回合(`thread/fork` 的 lastTurnId,inclusive)。
   *    null = 目標就在第一個回合 → 沒有任何回合可保留,調用方應丟映射開新會話,而不是 fork
   *    (fork 省略 lastTurnId 是全量複製,正好相反)。
   *  - `cutSrcId`:目標所屬回合裡**第一條**消息的 srcId。codex 只能按回合切——同回合裡目標
   *    之前可能還有別的消息會被一起截掉,server 憑這個把自己的截斷點對齊到 agent 實際忘掉
   *    的位置(rewind_result.fromSrcId),否則 UI 會留下 AI 已經不記得的消息。
   */
  rewindPlan(
    threadId: string,
    targetSrcId: string,
  ): { lastTurnId: string | null; cutSrcId: string } | null {
    if (!threadId || !targetSrcId) return null;
    const rf = discoverRollouts().rollouts.find((r) => r.threadId === threadId);
    if (!rf || !existsSync(rf.file)) return null;
    let msgs: ReturnType<typeof messagesWithTurns>;
    try {
      msgs = messagesWithTurns(readFileSync(rf.file, "utf8"));
    } catch {
      return null;
    }
    const withSrc = msgs.map((m) => ({ ...m, srcId: srcIdFor(threadId, m) }));
    const target = withSrc.find((m) => m.srcId === targetSrcId);
    if (!target) return null;
    // 目標回合(turnId 可能為 null——task_started 前的孤兒消息,視同第一回合)
    const cut = withSrc.find((m) => m.turnId === target.turnId);
    // 保留的最後回合 = 目標回合之前、最近一個**不同**的 turnId
    let lastTurnId: string | null = null;
    for (const m of withSrc) {
      if (m === cut) break;
      if (m.turnId !== null && m.turnId !== target.turnId) lastTurnId = m.turnId;
    }
    return { lastTurnId, cutSrcId: (cut ?? target).srcId };
  }

  /**
   * #473 認領 fork 出來的新 rollout:登記 driven + 水位(offsets **和 ords**——srcId 哈希含
   * 全文行號,兩者必須同源同步)直接坐到當前 EOF。
   *
   * ⚠️ 這一步漏了就是本功能最壞的 bug:fork 複製過去的整段歷史會被下一輪 poll(5s)當成
   * 新消息再灌一遍(cc 同款教訓)。檔案還沒落盤 → 水位 0,driven 守衛仍擋住明文落地。
   */
  adoptForked(threadId: string): boolean {
    if (!threadId) return false;
    this.markDrivenUuid(threadId);
    let bytes = 0;
    let ords = 0;
    const rf = discoverRollouts().rollouts.find((r) => r.threadId === threadId);
    if (rf && existsSync(rf.file)) {
      try {
        const content = readFileSync(rf.file, "utf8");
        bytes = Buffer.byteLength(content, "utf8");
        ords = nextOrdAtEof(content);
      } catch {
        /* 讀失敗按 0:寧可之後靠 srcId 去重兜,也不能標一個讀不到的水位 */
      }
    }
    this.state.offsets[threadId] = bytes;
    this.state.ords[threadId] = ords;
    this.save(true);
    return true;
  }

  /**
   * #489 F-12 崩潰補撈：只讀 rollout **已落盤** agent 消息，經 durable `mirror_append` 補投。
   * 絕不重跑回合；只補 agent；E2E 明文跳過；水位走 ACK。false → 回退「請重發」。
   */
  salvageCrash(localThreadId: string, wireSid?: string): boolean {
    if (!localThreadId) return false;
    if (this.state.tombstones?.includes(localThreadId)) return false;
    if (this.hasPendingE2EBackfill(localThreadId)) return false;
    // 已有 durable 批在途 → 交給 outbox
    if ((this.state.pendingMirrors ?? []).some((p) => p.offsets[localThreadId] !== undefined)) {
      return false;
    }

    const rf = discoverRollouts().rollouts.find((r) => r.threadId === localThreadId);
    if (!rf || !existsSync(rf.file)) return false;
    let content: string;
    try {
      content = readFileSync(rf.file, "utf8");
    } catch {
      return false;
    }
    const size = Buffer.byteLength(content, "utf8");
    const startOff = this.state.offsets[localThreadId] ?? 0;
    const ordBase = this.state.ords[localThreadId] ?? 0;
    if (size <= startOff) return false;

    const { messages, newOffset, lineCount } = readNewMessages(content, startOff, ordBase);
    const agents = messages.filter((m) => m.role === "agent" && m.text.trim());
    if (!agents.length) return false;

    const mappedWire = this.e2eWireSidForLocal?.(localThreadId);
    const targetSid = wireSid ?? mappedWire ?? localThreadId;
    if (this.e2e?.isE2E(targetSid) || this.e2e?.isE2E(localThreadId)) return false;
    if (!wireSid && !mappedWire && this.plaintextLocalAllowed?.() === false) return false;

    // #659 cwd 一直是算出來就扔（deriveMeta 的簽名本來就是 {title, cwd}）——鏡像三處
    // 全只解構 title，於是終端側 codex 會話一律沒有文件夾。cwd 是元數據不是正文，
    // E2E 批也照常帶明文路徑（server 用靜態層 KEK 加密落庫），否則加密會話永遠無文件夾。
    const { title, cwd } = deriveMeta(content);
    const folder = cwd?.trim() ? { cwd: cwd.trim() } : {};
    // 投到 wire sid（app ULID）而非本地 threadId，掛回原會話
    const entry = {
      hermesSessionId: targetSid,
      title,
      source: "codex",
      ...folder,
      messages: agents.map((m) => ({
        role: m.role,
        text: m.text,
        srcId: srcIdFor(localThreadId, m),
      })),
    };
    const batchId = randomUUID();
    const frame = {
      t: "mirror_append",
      agentLinkId: this.linkb.agentLinkId,
      sessions: [entry],
      batchId,
    };
    if (Buffer.byteLength(JSON.stringify(frame), "utf8") > MAX_WIRE_BYTES) {
      this.lastError = `F-12 salvage exceeds ${MAX_WIRE_BYTES} byte frame budget (${localThreadId})`;
      this.errorSticky = true;
      console.error(`[mirror] ${this.lastError}; watermark retained`);
      return false;
    }
    // endOffset 推過本段全部完整行（含 user）：user live 已投；agent 帶 srcId 冪等
    (this.state.pendingMirrors ??= []).push({
      batchId,
      frame,
      offsets: { [localThreadId]: newOffset },
      ords: { [localThreadId]: ordBase + lineCount },
    });
    this.save(true);
    this.linkb.send(frame as any);
    this.sentBatchAt.set(batchId, Date.now());
    this.counters.mirrorBatches += 1;
    this.counters.mirrorMessages += agents.length;
    console.log(
      `· #489 F-12 salvageCrash ${localThreadId} → ${targetSid}: ${agents.length} agent msg(s)`,
    );
    return true;
  }

  start(): void {
    if (this.disabled) {
      // ⚠️ 回歸契約:scripts/localchain/scenarios-mirror-off.mjs 斷言此串,改文案需同步
      console.log("· Mirror disabled (MACCHIATO_MIRROR=off) — terminal sessions stay out of the app; app-driven sessions unaffected");
      // 契約後半句「app-driven sessions unaffected」也要兌現:E2E driven 回合的正文只有鏡像
      // 這一條路。裝一個**定向**輪詢(只掃 drivenE2EWatch + 重發待確認批),終端 rollout 一個
      // 都不掃。缺這條時尾巴晚落盤的最後一塊、需重試的批永遠不會再發。
      this.timer = setInterval(() => void this.poll(this.drivenE2EWatch), POLL_MS);
      return;
    }
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    console.log(`· Mirror started (poll ${POLL_MS / 1000}s, tailing ${sessionsRoot()})`);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const threadId of [...this.tailPollTimers.keys()]) this.cancelTailPolls(threadId);
  }
  restart(): void {
    this.stop();
    this.polling = false;
    this.start();
  }

  /**
   * mirror_nack。默認語義是「保留 durable 批、按同 batchId 重發」；終態 code 必須丟批
   * （理由與 CC mirror 同：幀在發送時凍結，會話事後翻轉 E2E 方向後原批**永遠**會被拒，
   * 水位永久凍結且明文被週期性重傳）。見 cc/mirror.ts handleNack 註釋。
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
    if (code === "e2e_direction") {
      const sids = new Set(Object.keys(target.offsets));
      const dropped = (this.state.pendingMirrors ?? []).filter((pending) =>
        Object.keys(pending.offsets).some((sid) => sids.has(sid)),
      );
      for (const pending of dropped) this.sentBatchAt.delete(pending.batchId);
      this.state.pendingMirrors = (this.state.pendingMirrors ?? []).filter(
        (pending) => !dropped.includes(pending),
      );
      this.counters.mirrorDirectionRewinds += 1;
      this.save(true);
      console.warn(
        `· mirror_nack(e2e_direction) → 丟棄 ${dropped.length} 個舊方向凍結批,回退到已提交水位重讀重編`,
      );
      return;
    }
    if (code === "malformed") {
      for (const [sid, offset] of Object.entries(target.offsets)) {
        this.state.offsets[sid] = Math.max(this.state.offsets[sid] ?? 0, offset);
      }
      for (const [sid, ord] of Object.entries(target.ords)) {
        this.state.ords[sid] = Math.max(this.state.ords[sid] ?? 0, ord);
      }
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
    for (const [sid, offset] of Object.entries(pending.offsets)) {
      this.state.offsets[sid] = Math.max(this.state.offsets[sid] ?? 0, offset);
    }
    for (const [sid, ord] of Object.entries(pending.ords)) {
      this.state.ords[sid] = Math.max(this.state.ords[sid] ?? 0, ord);
    }
    this.state.pendingMirrors = this.state.pendingMirrors!.filter(
      (candidate) => candidate.batchId !== String(batchId),
    );
    this.sentBatchAt.delete(String(batchId));
    this.errorSticky = false; // 有批真被 server 提交 → 錯誤結清，下輪 poll 可清 lastError
    this.save(true);
  }

  /** 先匹配 durable batch，再由 index 結算 K_S；遲到/錯批 ACK 不得觸碰 key 或水位。 */
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
    if (pending.localSid && pending.endOffset !== undefined && pending.endOrd !== undefined) {
      this.state.offsets[pending.localSid] = Math.max(
        this.state.offsets[pending.localSid] ?? 0,
        pending.endOffset,
      );
      this.state.ords[pending.localSid] = Math.max(
        this.state.ords[pending.localSid] ?? 0,
        pending.endOrd,
      );
    }
    this.save(true);
    console.log(
      `· E2E backfill ACK(${mode}): ${wireSid} (watermark → ${pending.endOffset ?? "unchanged"})`,
    );
  }

  private async poll(scope?: Set<string>): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      this.pollOnce(scope);
      // ⚠️ 只有「本輪成功 **且** 沒有仍在重試的待確認批」才算恢復正常(理由見 cc/mirror.ts
      // 同處註釋:無條件清空會把 #348 要求的「明確報錯」變成「靜默凍結」)。
      // 只有沒有未結清錯誤時才算恢復正常（見 errorSticky）。
      if (!this.errorSticky) this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.errorSticky = true;
      this.counters.mirrorErrors += 1; // #10
      console.error("[mirror poll error]", this.lastError);
    } finally {
      this.polling = false;
      this.lastPollAt = Date.now();
    }
  }

  /**
   * @param scope 給定時只處理這批 threadId（定向輪詢，見 `drivenE2EWatch`）：不掃其餘 rollout、
   *   不 prune、不置 `seeded`（置了會讓日後開啟鏡像時把全部存量會話當「新會話」全量灌一遍），
   *   水位缺失時按 from-zero 處理。
   */
  private pollOnce(scope?: Set<string>): void {
    if (!this.linkb.isReady) return;
    const pendingMirrors = this.state.pendingMirrors ?? [];
    const pendingBackfills = Object.values(this.state.pendingE2EBackfills ?? {});
    if (pendingMirrors.length || pendingBackfills.length) {
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
      return;
    }
    const { rollouts: allRollouts } = discoverRollouts();
    // #966 身份閘要的「直接持鑰身份」快照：每輪取一次，別在循環裡反覆問 keystore。
    const protectedSids = this.protectedSidSnapshot();
    if (!scope) this.pruneState(new Set(allRollouts.map((r) => r.threadId)));
    const rollouts = scope ? allRollouts.filter((r) => scope.has(r.threadId)) : allRollouts;
    for (const { file, threadId } of rollouts) {
      if (this.state.tombstones?.includes(threadId)) continue; // #161 app 刪過 → 永不再撈
      // 影子兜底(對齊 CC `drivenUuids`):曾被驅動過、且當前沒有 E2E wire 映射的 thread,鏡像永不
      // 以本地 threadId 建明文會話。不推水位——E2E 之後開啟時映射生效,同一段內容改走密文路徑補投
      // (srcId 相同,server 端唯一索引去重)。日誌按檔案大小去抖,不每 5s 刷屏。
      if (!this.drivenIds.has(threadId) && this.isDrivenGhost(threadId)) {
        let size = -1;
        try {
          size = statSync(file).size;
        } catch {
          /* 檔沒了:照樣跳過 */
        }
        if (this.ghostAt.get(threadId) !== size) {
          this.ghostAt.set(threadId, size);
          this.counters.mirrorGhostBlocked += 1;
          console.error(
            `[mirror] ⚠️ 阻止為 driven thread ${threadId} 建明文影子會話(正文由 live 在 wire sid 下投遞;mirrorGhostBlocked=${this.counters.mirrorGhostBlocked})`,
          );
        }
        continue;
      }
      this.ghostAt.delete(threadId);
      if (this.drivenIds.has(threadId)) {
        // #350 driven 内容必须先进入 durable outbox；poll 只让路，绝不读檔或预推水位。
        continue;
      }

      const off = this.state.offsets[threadId];
      const startOff = off ?? 0;
      let content: string | Buffer;
      let endOffset: number;
      let metadata: RolloutMetadata;

      if (off === undefined) {
        // 首次見到的 rollout 仍需從 0 建基線或投遞；只有已有 per-thread 水位的活躍檔走尾讀。
        let fullContent: string;
        try {
          fullContent = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        content = fullContent;
        endOffset = Buffer.byteLength(fullContent, "utf8");
        metadata = this.metadataFor(file);
      } else {
        try {
          const tail = readRolloutTail(file, off);
          if (!tail.content.length) continue;
          content = tail.content;
          endOffset = tail.endOffset;
          metadata = this.metadataFor(file);
        } catch {
          continue;
        }
      }

      // #946 會話身份 = 源系統聲明的歸屬（`session_meta.session_id` 判據鏈），文件名只用來定位。
      // 根線程（本機 825/1399、生產 478/671）解出來就是它自己，一個字節都不變。
      // 只有真的派生時才去解析鏈路——不然 574 條子 agent 每 5s 都要遞歸查一遍父，純浪費。
      const conversationSid = metadata.skip.skip
        ? threadId
        : this.conversationSidFor(threadId, metadata.origin, allRollouts);
      // #966 E2E 身份閘（取代 #946 的「E2E 一律走老路徑」）。
      //
      // K_S 按**上報身份**存（`e2e/keys.ts`），所以把派生線程改掛父會話 = 換鍵。要不要換，判據
      // 只有一條、且必須可證明：**這段對話裡所有直接持鑰的身份，是不是就是對話身份那一把。**
      //   - 剛 fork 出來的線程自己沒有鑰匙（終端 rewind 的常態，也正是本 issue 要修的那個）→
      //     換，用對話那把鑰匙加密投回父會話。這就是「rewind 之後正文恢復鏡像」的全部機制。
      //   - 對話裡有線程持着**別的**鑰匙（存量：#946 之前它自己是一條獨立 E2E 會話）→
      //     **維持舊身份**（＝老行為整檔跳過）。絕不把密文會話降級成明文、絕不新生成 K_S
      //     ——後者會讓此前的密文永久解不開（#807）。
      // 別名歷史不可信時 keystore 的 `aliasesFor` 恒空 ⇒ 認不出「換過身份的同一把」⇒ 落到
      // 後一檔，維持舊身份（#347 的 fail-closed 原樣照抄）。
      const conversationE2ESid = this.e2eSidFor(conversationSid);
      const conversationThreads = this.registry.threadsOf(
        this.registry.conversationOf(threadId) ?? conversationSid,
      );
      const e2eHoldsIdentity =
        conversationSid !== threadId
        && [threadId, conversationSid, ...conversationThreads].some((id) => {
          const direct = this.directE2ESidFor(id, protectedSids);
          return !!direct && direct !== conversationE2ESid;
        });
      // #161 墓碑對父會話同樣有效：用戶刪掉的那段對話，不許被它的派生線程借屍還魂。
      const parentTombstoned =
        conversationSid !== threadId && !!this.state.tombstones?.includes(conversationSid);

      // #789:內部 thread 只消費本輪新增尾部，不建用戶會話。它的正文不投遞，
      // 因此可直接把 byte/ord 水位推到本次 snapshot EOF。
      if (metadata.skip.skip || e2eHoldsIdentity || parentTombstoned) {
        this.state.offsets[threadId] = endOffset;
        this.state.ords[threadId] =
          (this.state.ords[threadId] ?? 0) + nextOrdAtEof(content);
        const reason = e2eHoldsIdentity
          ? `${metadata.origin.reason ?? "derived"}/e2e-hold`
          : parentTombstoned
            ? `${metadata.origin.reason ?? "derived"}/parent-tombstoned`
            : metadata.skip.reason;
        if (metadata.skip.inferred) this.counters.mirrorInferredSkipped += 1;
        if (e2eHoldsIdentity) this.counters.mirrorE2EIdentityHeld += 1;
        this.counters.mirrorInternalSkipped += 1;
        console.log(
          `· #789 skip internal rollout ${threadId} (${reason}; mirrorInternalSkipped=${this.counters.mirrorInternalSkipped})`,
        );
        continue;
      }

      if (off === undefined) {
        // #236:`seeded` 持久化(對齊 CC #154)——首掃把存量會話基線到檔末(歷史走「導入」,
        // 避免裝上/重啟即全量回灌);首掃**成功走完**之後新出現的 rollout(終端新開的會話,
        // 含連接器停機期間新建的)→ 從頭鏡像,首拍不丟。舊版此處是進程級旗標且從未置 true,
        // 導致新會話一律被誤基線、首次發現前的消息永丟。
        // 定向輪詢的目標是 app 自己建的 driven thread → 一律 from-zero（`seeded` 在 MIRROR=off
        // 下可能從未置過，按它走會把本 thread 誤基線到檔末、正文永遠不投）。
        if (!this.state.seeded && !scope) {
          this.state.offsets[threadId] = endOffset;
          // #418:與 readNewMessages 的「下一完整行 ord」對齊；split("\n").length 尾 \n 恒多 1。
          this.state.ords[threadId] = nextOrdAtEof(content);
          continue;
        }
        // #946 派生線程首次出現:它掛回父會話,而 fork 檔案開頭是**父會話歷史的逐字副本**
        // (rewind 保留的那幾個回合)——從 0 投遞等於把已經在 app 裡的消息再灌一遍(srcId 含
        // 行號,跨檔對不上,server 去重救不了)。所以先與父 rollout 對齊公共前綴,水位坐到
        // 分叉點,只投**分叉之後**的新內容。與 `adoptForked`(我們自己的 rewind)同一道理。
        if (conversationSid !== threadId) {
          const base = this.forkBaseline(content as string, metadata.origin, allRollouts);
          this.state.offsets[threadId] = base.offset;
          this.state.ords[threadId] = base.ord;
          this.counters.mirrorForkAdopted += 1;
          console.log(
            `· #946 派生線程 ${threadId} → 會話 ${conversationSid}(${metadata.origin.reason}; 水位坐到分叉點 ${base.offset}B; mirrorForkAdopted=${this.counters.mirrorForkAdopted})`,
          );
          continue;
        }
      }
      const ordBase = this.state.ords[threadId] ?? 0;
      const relativeAll = readNewMessages(content, 0, ordBase);
      const all = {
        ...relativeAll,
        newOffset: startOff + relativeAll.newOffset,
      };
      const { messages } = all;
      if (messages.length) {
        const { title, cwd } = metadata; // #659 文件夾：rollout 的 session_meta.cwd
        const folder = cwd?.trim() ? { cwd: cwd.trim() } : {};
        // app-driven E2E 的 key/session identity 掛在 wire ULID，rollout 則以本地 UUID 命名。
        // unsetDriven 後 terminal 續聊必須仍回到 wire session 並用 wire key 加密，不能另建
        // local UUID 的 plaintext shadow session。
        // #966 派生線程走**對話**的 E2E 身份：終端裡 rewind 出來的 fork 檔自己沒有映射也沒有
        // 鑰匙，但它屬於的那條會話有——上面的身份閘已經確認過兩者是同一把（不是就整檔跳過了）。
        const e2eSid = conversationE2ESid;
        // #966/#985 上報血緣（元數據非正文 → E2E 會話一樣帶得動）。派生仍在本地隱藏 /
        // 併進父（舊 server 兼容），所以掛在父身份上的批次仍是 root；獨立 session 據實報 kind。
        const origin = toWireOrigin(metadata.origin, e2eSid ?? conversationSid);
        const wireOrigin = origin ? { origin } : {};
        const makeEntry = (picked: CodexMessage[]): Record<string, unknown> => {
          if (e2eSid) {
            return {
            hermesSessionId: e2eSid,
            ...wireOrigin,
            title: this.e2e!.encryptText(e2eSid, title),
            source: "codex",
            ...folder,
            e2e: true,
            messages: picked.map((m) => ({
              role: m.role,
              srcId: srcIdFor(threadId, m),
              enc: this.e2e!.encryptContent(e2eSid, { text: m.text }),
            })),
            };
          }
          return {
            ...wireOrigin,
            // #946 身份 = 源系統聲明的歸屬（根線程 = threadId 自己）；srcId 仍按**本地
            // thread**算，它只是本會話內的去重鍵，換了會讓已投遞過的消息重新長出一份。
            hermesSessionId: conversationSid,
            title,
            source: "codex",
            ...folder,
            messages: picked.map((m) => ({
              role: m.role,
              text: m.text,
              srcId: srcIdFor(threadId, m),
            })),
          };
        };
        if (!e2eSid && this.plaintextLocalAllowed?.() === false) {
          console.error(
            `[mirror] E2E identity map 不可信，凍結未知 Codex rollout ${threadId}，不推水位/不發明文`,
          );
          continue;
        }
        let lo = 1;
        let hi = messages.length;
        let accepted:
          | { frame: Record<string, unknown>; newOffset: number; lineCount: number }
          | undefined;
        const batchId = randomUUID();
        while (lo <= hi) {
          const take = Math.floor((lo + hi) / 2);
          const relative = readNewMessages(content, 0, ordBase, take);
          const partial = {
            ...relative,
            newOffset: startOff + relative.newOffset,
          };
          const frame = {
            t: "mirror_append",
            agentLinkId: this.linkb.agentLinkId,
            sessions: [makeEntry(partial.messages)],
            batchId,
          };
          if (Buffer.byteLength(JSON.stringify(frame), "utf8") <= MAX_WIRE_BYTES) {
            accepted = { frame, newOffset: partial.newOffset, lineCount: partial.lineCount };
            lo = take + 1;
          } else {
            hi = take - 1;
          }
        }
        if (!accepted) {
          this.lastError = `mirror message exceeds ${MAX_WIRE_BYTES} byte frame budget (${threadId})`;
          this.errorSticky = true;
          console.error(`[mirror] ${this.lastError}; watermark retained`);
          continue;
        }
        const pending = {
          batchId,
          frame: accepted.frame,
          offsets: { [threadId]: accepted.newOffset },
          ords: { [threadId]: ordBase + accepted.lineCount },
        };
        (this.state.pendingMirrors ??= []).push(pending);
        this.save(true);
        this.linkb.send(accepted.frame as any);
        this.sentBatchAt.set(batchId, Date.now());
        this.counters.mirrorBatches += 1;
        this.counters.mirrorMessages += (
          ((accepted.frame as any).sessions as Array<{ messages?: unknown[] }>)[0]?.messages ?? []
        ).length;
        break;
      }
      // 只有無可投遞消息的完整行可本地消費；內容消息的候選水位必須等 ACK。
      this.state.offsets[threadId] = all.newOffset;
      this.state.ords[threadId] = ordBase + all.lineCount;
    }
    // ⚠️ 定向輪詢**不得**置 seeded:它沒掃過存量 rollout,置了等於謊稱「首掃完成」,日後開啟
    // 鏡像時全部存量會話會被當「新會話」從 0 全量灌一遍(#236 明確不要的行為)。
    if (!scope) this.state.seeded = true; // #236 首掃完成:此後新發現的 rollout 才從頭鏡像
    this.save();
  }

  /**
   * §19 D2 / 關閉:把該會話 rollout 全量歷史以 e2e_backfill 回灌(server 事務內原地替換)。
   * enable:K_S 重加密;disable:明文回灌。K_S 只由 index 在 server ACK ok/e2e:false 後刪除。
   * 找不到會話/無消息 → found:false。
   */
  async backfillE2E(
    wireSid: string,
    localSid: string | undefined,
    mode: "enable" | "disable" = "enable",
  ): Promise<void> {
    if (!this.e2e) return;
    const pendingKey = `${mode}:${wireSid}`;
    const existing = this.state.pendingE2EBackfills?.[pendingKey];
    if (existing) {
      for (const frame of existing.frames) this.linkb.send(frame as any);
      this.sentBatchAt.set(existing.batchId, Date.now());
      return;
    }
    const rf = localSid
      ? discoverRollouts().rollouts.find((r) => r.threadId === localSid)
      : undefined;
    const notFound = (): void => {
      const batchId = randomUUID();
      const frame = {
        t: "e2e_backfill",
        agentLinkId: this.linkb.agentLinkId,
        hermesSessionId: wireSid,
        mode,
        found: false,
        batchId,
      };
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
    /**
     * 本地歷史存在、但**編不出合法 wire 幀**（單條超幀預算 / 分片數超上限）。
     * ⚠️ 絕不能 throw：唯一調用點是 `void ....catch(console.error)`，拋出等於一幀不發 → server
     * 的 pendingOp 永遠掛著、兩側 barrier 永不解、該會話所有 prompt 靜默丟棄，重啟也不救。
     * 回 `found:false` 讓 server 出終態並釋放 barrier；錯誤掛 lastError 上健康讓用戶看得見。
     */
    const unrepresentable = (reason: string): void => {
      this.lastError = `E2E backfill(${mode}) ${wireSid}: ${reason}`;
      this.errorSticky = true;
      console.error(`[mirror] ${this.lastError} → 回 found:false 讓 server 出終態(不再靜默掛死)`);
      const batchId2 = randomUUID();
      const frame = {
        t: "e2e_backfill",
        agentLinkId: this.linkb.agentLinkId,
        hermesSessionId: wireSid,
        mode,
        found: false,
        batchId: batchId2,
      };
      (this.state.pendingE2EBackfills ??= {})[pendingKey] = {
        batchId: batchId2,
        wireSid,
        localSid,
        mode,
        frames: [frame],
      };
      this.save(true);
      this.linkb.send(frame as any);
      this.sentBatchAt.set(batchId2, Date.now());
    };
    if (!localSid || !rf || !existsSync(rf.file)) return notFound();
    let content: string;
    try {
      content = readFileSync(rf.file, "utf8");
    } catch {
      return notFound();
    }
    const { messages } = readNewMessages(content, 0, 0);
    if (!messages.length) return notFound();
    const { title, cwd } = deriveMeta(content); // #659 E2E 開關回灌同樣帶文件夾
    const folder = cwd?.trim() ? { cwd: cwd.trim() } : {};
    const session: {
      hermesSessionId: string;
      title: string;
      source: string;
      cwd?: string;
      e2e?: true;
      messages: Array<Record<string, unknown>>;
    } =
      mode === "enable"
        ? {
            hermesSessionId: wireSid,
            title: this.e2e.encryptText(wireSid, title),
            source: "codex",
            ...folder,
            e2e: true,
            messages: messages.map((m) => ({
              role: m.role,
              srcId: srcIdFor(localSid, m),
              enc: this.e2e!.encryptContent(wireSid, { text: m.text }),
            })),
          }
        : {
            hermesSessionId: wireSid,
            title,
            source: "codex",
            ...folder,
            messages: messages.map((m) => ({
              role: m.role,
              text: m.text,
              srcId: srcIdFor(localSid, m),
            })),
          };
    // 只有完整明文 snapshot 已成功构造后才签 completion receipt；先双快照持久化再发送。
    const disableReceipt =
      mode === "disable" ? this.e2e.disableReceiptForBackfill(wireSid) : undefined;
    const batchId = randomUUID();
    const frameBase = {
      t: "e2e_backfill" as const,
      agentLinkId: this.linkb.agentLinkId,
      hermesSessionId: wireSid,
      mode,
      found: true,
      batchId,
      ...(disableReceipt ? { disableReceipt } : {}),
    };
    const messageChunks: typeof session.messages[] = [];
    let current: typeof session.messages = [];
    for (const message of session.messages) {
      const candidate = [...current, message];
      // 探測用**最壞情況**分片元數據:真幀是 `chunkIndex:<n>, chunkCount:<m>`,比 0/1 多幾個
      // 字節。用 0/1 探測會讓臨界批在真發時超預算(只能靠下面的兜底校驗發現,整次轉換就廢了)。
      const probe = {
        ...frameBase,
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
      ...frameBase,
      session: { ...session, messages: chunk },
      chunkIndex,
      chunkCount: messageChunks.length,
    }));
    if (
      frames.some(
        (frame) => Buffer.byteLength(JSON.stringify(frame), "utf8") > MAX_WIRE_BYTES,
      )
    ) {
      // 走到這裡說明最壞情況探測仍不夠保守(不該發生)——照樣回終態,不靜默掛死。
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
      endOffset: Buffer.byteLength(content, "utf8"),
      // #418:與增量路徑 nextOrd 一致（尾 \n 不可用 split("\n").length）。
      endOrd: nextOrdAtEof(content),
    };
    this.save(true);
    for (const frame of frames) this.linkb.send(frame);
    this.sentBatchAt.set(batchId, Date.now());
    console.log(
      `· E2E backfill(${mode}) submitted for ${wireSid} (local ${localSid}; ${messages.length} messages / ${frames.length} chunks; waiting for server ACK)`,
    );
  }

  /** #9:offsets/ords 無界增長治理——rollout 消失連續 PRUNE_MS 才裁(7 天後壓縮 .zst 即「消失」)。
   * uuid 不復用,被裁 id 不會回歸;萬一回歸,#236 後按「新 rollout」從頭鏡像,srcId 內容哈希
   * 在 server 端唯一索引去重 → 不重複入庫、不誤丟(與 CC 行為一致)。 */
  private pruneState(liveIds: Set<string>): void {
    const ma = (this.state.missingAt ??= {});
    const now = Date.now();
    let pruned = 0;
    for (const id of Object.keys(this.state.offsets)) {
      if (liveIds.has(id)) {
        delete ma[id];
        continue;
      }
      const since = (ma[id] ??= now);
      if (now - since > PRUNE_MS) {
        delete this.state.offsets[id];
        delete this.state.ords[id];
        delete ma[id];
        pruned += 1;
      }
    }
    for (const id of Object.keys(ma)) if (!(id in this.state.offsets)) delete ma[id];
    // ⚠️ #966 `threadRegistry` **不跟着裁**：別名只增不刪（I3）。裁掉一環等於讓一條換過身份的
    // E2E 會話再也認不出自己的舊鍵（#807），而它只登記真正發生過歸屬的線程，量級遠小於水位表。
    if (pruned) console.log(`· #9 裁剪 ${pruned} 個已消失 rollout 的水位線(剩 ${Object.keys(this.state.offsets).length})`);
  }

  private load(): State {
    // #6 同款兜底:主文件損壞/丟失 → 試 .bak(上一版);雙亡才重置(重建 baseline,存量跳過)。
    for (const [p, isBak] of [[statePath(), false], [`${statePath()}.bak`, true]] as Array<[string, boolean]>) {
      try {
        const s = JSON.parse(readFileSync(p, "utf8"));
        if (isBak) console.error(`⚠️ ${statePath()} 損壞/丟失 → 已從 .bak 恢復水位線`);
        return {
          offsets: s.offsets ?? {},
          ords: s.ords ?? {},
          missingAt: s.missingAt ?? {},
          tombstones: s.tombstones ?? [], // #161
          // #236:舊安裝(有水位線,存量已基線過)視為已 seeded;白名單漏字段的教訓——顯式帶上。
          seeded: s.seeded ?? Object.keys(s.offsets ?? {}).length > 0,
          pendingMirrors: Array.isArray(s.pendingMirrors) ? s.pendingMirrors : [],
          pendingE2EBackfills:
            s.pendingE2EBackfills && typeof s.pendingE2EBackfills === "object"
              ? s.pendingE2EBackfills
              : {},
          // #966 原樣交給 ThreadRegistry.parse 嚴格校驗（構造函數裡），這裡不做寬鬆兜底：
          // 「解析失敗 = 這些對話沒有別名」正是 #347 要防的那一刀。
          threadRegistry: s.threadRegistry,
        };
      } catch {
        /* 下一個候選 */
      }
    }
    return { offsets: {}, ords: {}, pendingMirrors: [], pendingE2EBackfills: {} };
  }
  private lastSaved = "";
  private save(strict = false): void {
    try {
      // #966 registry 是內存權威，落盤前同步回狀態檔（**必須在發送本線程內容之前**——崩在中間
      // 會讓別名少一環，而 aliasHistoryTrusted 是持久 true 的，丟了就再也發現不了）。
      this.state.threadRegistry = this.registry.toJSON();
      // #262 dirty 判斷:與上次落盤相同 → 跳過(每 5s 無條件雙寫傷 SD 卡;Pi OOM/SD 前科)。
      const json = JSON.stringify(this.state);
      if (json === this.lastSaved) return;
      // #6:上一版留 .bak（同樣 0600——它裝的是上一版的完整正文）。
      if (existsSync(statePath())) durableWrite(`${statePath()}.bak`, this.lastSaved || json);
      durableWrite(statePath(), json);
      this.lastSaved = json;
    } catch (error) {
      if (strict) throw error;
    }
  }
}
