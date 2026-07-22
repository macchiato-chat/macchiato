/**
 * §15 鏡像：tail Claude Code 的 transcript（~/.claude/projects/<slug>/<sessionId>.jsonl）→ mirror_append。
 *  - 發現：掃 projects/ 下全部 <uuid>.jsonl（agent-*.jsonl = 子 agent 轉錄，跳過）。
 *  - 未知會話從 0 全量鏡像完整歷史（自動看到所有會話 = 相對官方 remote control 的核心賣點,
 *    不依賴手動 import）；分批發（batchMax 條/帧，單帧單會話）防超 server maxPayload。
 *  - 字節偏移水位線 + in-flight 保留（見 transcripts.foldEntries）+ mirror_nack 回退。
 *  - driven 會話（本進程經 SDK 驅動）：live 路徑獨佔投遞，鏡像只快進水位線（防雙投，Hermes 教訓）。
 *  - §9：消息帶 srcId（transcript 行 uuid），server 端崩潰重發去重。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import type { LinkBClient } from "../linkb/client";
import type { E2EKeyStore } from "../e2e/keys";
import { foldEntries, projectsDir, readEntries, type CCMessage } from "./transcripts";

const POLL_MS = Number(process.env.MACCHIATO_CC_POLL_MS) || 5000;
const REWIND_KEEP = 256; // 首輪全量一個大會話可連發多批，rewind 要留夠深供 nack 回退
/** #9:轉錄文件消失多久後裁掉水位線/標題(默認 7 天;CC 清理舊轉錄後 uuid 不復用,不會回歸)。 */
const PRUNE_MS = Number(process.env.MACCHIATO_MIRROR_PRUNE_MS) || 7 * 24 * 3600 * 1000;
/** 單批最多消息數（防單帧超 server maxPayload）。運行時讀 env,便於測試覆蓋。 */
const batchMax = (): number => Number(process.env.MACCHIATO_CC_BATCH_MAX) || 150;

function statePath(): string {
  return process.env.MACCHIATO_CC_MIRROR || join(homedir(), ".macchiato/claude-code-mirror.json");
}

/** CCMessage → 協議 ImportMessage（tools 對齊 ImportToolCall：input/output/state,別發自造字段）。 */
export function toImportMessage(m: CCMessage): Record<string, unknown> {
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
}

export class Mirror {
  private state: State;
  private timer: ReturnType<typeof setInterval> | null = null;
  private batchId = 0;
  // #266 rewind 除 offset 也記發批前的 title——nack 回退時一起還原,否則「無真人消息不建會話」
  // 守衛(!titles[sid])在重發時失效(offset 回退了但 titles[sid] 已被 set,守衛判假)。
  private readonly rewind: Array<{ id: number; prev: Record<string, number>; prevTitle: Record<string, string | undefined> }> = [];
  private readonly drivenSids = new Set<string>();
  /**
   * 影子 session 兜底(第二道防護,2026-07-13):**曾被 Macchiato 驅動過**的 CLI 會話 uuid(持久,
   * 由 Drive 從 ULID→CLI 映射灌入,跨重啟)。driven 會話的正文由 live 在 ULID 下獨佔投遞,鏡像
   * **永遠不該**給這些 uuid 單獨建會話——不管是殘片還是終端續問(極少見,取捨)。與「無 user 不建」
   * 是雙保險;真觸發 emit 即記 mirrorGhostBlocked 計數 + 錯誤日誌(自檢告警,漏了當場可見)。
   */
  private readonly drivenUuids = new Set<string>();
  /**
   * #318 live 已投遞的 API message.id(按 sid)。回合末 Drive 登記本回合 live 覆蓋的 message.id;
   * mirror fold 出的 assistant 消息若命中即跳過(一次性移除)——精確吞掉「SDK result 早於 CLI 寫完
   * transcript 尾巴」逃過 fastForward 的晚落盤殘片,防 live×mirror 雙投(bug:回合末重複最後一塊)。
   * 有界:每 sid ≤64 個 id、總 ≤64 個 sid(FIFO 淘汰)——殘片落盤窗口很短,淘汰不會誤刪在用的。
   * 常態下多數 id 被 fastForward 先吃、永不匹配,故必須靠淘汰防洩漏。
   */
  private readonly livePosted = new Map<string, Set<string>>();
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
  /** #10:累計計數(進程生命週期),健康上報帶出。 */
  readonly counters: Record<string, number> = {
    mirrorBatches: 0,
    mirrorMessages: 0,
    mirrorNacks: 0,
    mirrorErrors: 0,
    mirrorGhostBlocked: 0, // 影子 session 兜底:攔下的「為 driven CLI 會話憑空建會話」次數(正常應恆 0)
  };
  private polling = false;

  /** #308 MACCHIATO_MIRROR=off:停鏡像輪詢(終端側活動不進 app)。⚠️ 只停這一樣——
   * fastForward/墓碑/markLivePosted/E2E backfill 是 driven 會話衛生,必須照常跑,
   * 多關任何一個 = 影子會話/雙投全家回歸(#161/#318)。副作用:終端側忙碌指示(#56)一併失去。 */
  readonly disabled = /^(off|0|false|no)$/i.test(process.env.MACCHIATO_MIRROR ?? "");

  constructor(
    private readonly linkb: LinkBClient,
    private readonly e2e?: E2EKeyStore,
  ) {
    this.state = this.load();
  }

  start(): void {
    if (this.disabled) {
      // ⚠️ 回歸契約:scripts/localchain/scenarios-mirror-off.mjs 斷言此串,改文案需同步
      console.log("· Mirror disabled (MACCHIATO_MIRROR=off) — terminal sessions stay out of the app; app-driven sessions unaffected");
      return;
    }
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    console.log(`· Mirror started (poll ${POLL_MS / 1000}s, tailing ${projectsDir()})`);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
  restart(): void {
    this.stop();
    this.polling = false;
    this.start();
  }

  setDriven(sid: string): void {
    this.drivenSids.add(sid);
  }

  /** #161 墓碑:永不再鏡像此 CLI 會話(持久;transcript 不動)。 */
  tombstone(sid: string): void {
    const t = (this.state.tombstones ??= []);
    if (!t.includes(sid)) {
      t.push(sid);
      this.save();
      console.log(`· 墓碑 ${sid}(鏡像永不再撈)`);
    }
  }

  /** 影子兜底(2026-07-13):登記「曾被 Macchiato 驅動」的 CLI 會話 uuid(持久)。Drive 在 init 存
   * ULID→CLI 映射時、及啟動時從既有映射批量灌入。鏡像據此永不給這些 uuid 單獨建會話。 */
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
      while (set.size > 64) set.delete(set.keys().next().value!); // 每 sid id 上限
    }
  }

  /** #318 fold 出的消息過濾:命中 live 已投的 message.id → 跳過(一次性移除)。防雙投。 */
  private dropLivePosted(sid: string, messages: CCMessage[]): CCMessage[] {
    const set = this.livePosted.get(sid);
    if (!set?.size) return messages;
    const kept = messages.filter((m) => {
      if (m.msgId && set.has(m.msgId)) {
        set.delete(m.msgId); // 一次性:吞掉這條殘片後即釋放
        return false;
      }
      return true;
    });
    if (!set.size) this.livePosted.delete(sid);
    return kept;
  }

  /**
   * 解除 driven（回合結束後調）。CC 與 OpenClaw 的關鍵差異：CC 無常駐 gateway，終端側回合
   * **只有鏡像一條路**——若 driven 永久生效，從 Macchiato 驅動過一次的會話就再也鏡像不到終端
   * 活動（2026-07-06 實測踩中）。故 driven 僅覆蓋驅動回合本身（live 已投遞、鏡像跳過防雙投），
   * 回合結束 fastForward 越過該回合內容後立即解除，終端側活動恢復鏡像。
   */
  unsetDriven(sid: string): void {
    this.drivenSids.delete(sid);
  }

  /** 回合結束：driven 會話水位線快進到文件末（live 已投遞，鏡像別重複）。 */
  fastForward(sid: string): void {
    const f = this.fileForSid(sid);
    if (!f) return;
    try {
      this.state.offsets[sid] = statSync(f).size;
      this.save();
    } catch {
      /* 下輪 poll 兜底 */
    }
  }

  private fileForSid(sid: string): string | null {
    for (const s of discoverSessions()) if (s.sid === sid) return s.file;
    return null;
  }

  handleNack(batchId: number): void {
    const e = this.rewind.find((r) => r.id === batchId);
    if (!e) return;
    this.counters.mirrorNacks += 1; // #10
    for (const [k, off] of Object.entries(e.prev)) this.state.offsets[k] = off;
    // #266 title 也回退:發批前無標題的會話,nack 後恢復「無標題」→ 守衛在重發時照常生效。
    for (const [k, t] of Object.entries(e.prevTitle)) {
      if (t === undefined) delete this.state.titles[k];
      else this.state.titles[k] = t;
    }
    this.save();
    console.warn(`· mirror_nack batch ${batchId} → rewinding watermark for resend`);
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      this.doPoll();
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.counters.mirrorErrors += 1; // #10
      console.error("[mirror poll]", this.lastError);
    } finally {
      this.lastPollAt = Date.now();
      this.polling = false;
    }
  }

  private doPoll(): void {
    if (!this.linkb.isReady) return;

    const now = Date.now();
    const activity: Array<{ hermesSessionId: string; busy: boolean }> = [];
    const found = discoverSessions();
    this.prune(new Set(found.map((s) => s.sid)), now);
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
      // #154 基線策略(拍板翻轉,對齊 codex):**首掃**把既有 transcript 基線到文件末——裝上連接器
      // 不再把全部舊會話不請自來灌進側欄,歷史改走「導入」提示(全量/按 project/不導,app 端三選)。
      // 首掃之後新發現的會話 = 連接器運行期間新建 → 照舊從 0 全量鏡像(終端新會話實時可見不變)。
      if (!(sid in this.state.offsets)) this.state.offsets[sid] = this.state.seeded ? 0 : size;

      if (this.drivenSids.has(sid)) {
        this.state.offsets[sid] = size; // live 獨佔投遞：只快進
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
        const off = this.state.offsets[sid] ?? 0;
        if (size <= off) break;
        const { entries, endOffset } = readEntries(file, off);
        if (!entries.length) break;
        const folded = foldEntries(entries, endOffset, Date.now(), batchMax());
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
        // 第二道(2026-07-13):`drivenUuids.has(sid)` —— 曾被 Macchiato 驅動的 CLI 會話**永不**單獨建
        // 鏡像會話(其正文由 live 在 ULID 下獨佔投遞),連「有 user 的終端續問」也不建(極少見,取捨)。
        if (!this.state.titles[sid] && (this.drivenUuids.has(sid) || !messages.some((m) => m.role === "user"))) {
          this.internalAt.set(sid, size);
          break;
        }
        this.internalAt.delete(sid);
        // 標題優先級：流裡 custom-title > 已記標題 > 首條 user 截斷（分批時首批可能沒讀到 custom-title,
        // 先用 fallback，後續批讀到 custom-title 再更新）。
        const firstUser = messages.find((m) => m.role === "user")?.text.slice(0, 60);
        const candidate = title ?? (this.state.titles[sid] ? undefined : firstUser);
        const newTitle = candidate && candidate !== this.state.titles[sid] ? candidate : undefined;
        if (messages.length || newTitle) {
          // 兜底自檢(2026-07-13):若竟為 driven CLI 會話走到「首次 emit(=建會話)」,說明上面兩道守衛
          // 有洞——這正是影子 session。阻止落地 + 記 mirrorGhostBlocked(健康上報帶出;正常恆 0,非 0=有洞
          // 當場可見)+ 錯誤日誌。正常路徑上這永遠不觸發(主守衛已攔)——它是防未來回歸的絆線。
          if (!this.state.titles[sid] && this.drivenUuids.has(sid)) {
            this.counters.mirrorGhostBlocked += 1;
            console.error(
              `[mirror] ⚠️ 影子 session 兜底觸發:阻止為 driven CLI 會話 ${sid} 憑空建鏡像會話(守衛有洞?mirrorGhostBlocked=${this.counters.mirrorGhostBlocked})`,
            );
          } else {
            this.sendOne(sid, this.entry(sid, newTitle ?? this.state.titles[sid] ?? "Claude Code", messages), off);
            if (newTitle) this.state.titles[sid] = newTitle;
          }
        }
        if (consumedUpTo <= off) break; // 無進展（尾部全 in-flight）→ 下輪 poll
        this.state.offsets[sid] = consumedUpTo;
      }

      // #56 工作態結算（內部 fork 檔不算——它們不是 server 端的真會話）。
      if (!this.internalAt.has(sid)) {
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
    this.state.seeded = true; // #154 首掃完成:此後新發現的會話才 from-zero
    this.save();
  }

  /** 發一條會話的一批（單帧單會話）；記 rewind 供 nack 回退。 */
  private sendOne(sid: string, entry: Record<string, unknown>, prevOff: number): void {
    this.batchId += 1;
    // #266 記發批前的 title(此刻尚未 set 新標題,見調用點 302→303 順序)供 nack 一起回退。
    this.rewind.push({ id: this.batchId, prev: { [sid]: prevOff }, prevTitle: { [sid]: this.state.titles[sid] } });
    if (this.rewind.length > REWIND_KEEP) this.rewind.shift();
    this.linkb.send({
      t: "mirror_append",
      agentLinkId: this.linkb.agentLinkId,
      sessions: [entry],
      batchId: this.batchId,
    });
    this.counters.mirrorBatches += 1; // #10
    this.counters.mirrorMessages += Array.isArray((entry as any).messages) ? (entry as any).messages.length : 0;
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

  /** §19 D2：E2E 開啟/關閉時全量歷史回灌（enable=密文、disable=明文）。 */
  async backfillE2E(sid: string, mode: "enable" | "disable" = "enable"): Promise<void> {
    const file = this.fileForSid(sid);
    const base = { t: "e2e_backfill", agentLinkId: this.linkb.agentLinkId, hermesSessionId: sid, mode };
    if (!file) {
      this.linkb.send({ ...base, found: false });
      return;
    }
    const { entries, endOffset } = readEntries(file, 0);
    const { messages, title } = foldEntries(entries, endOffset, Number.MAX_SAFE_INTEGER); // 全結算（歷史快照）
    const t = title ?? this.state.titles[sid] ?? "Claude Code";
    const msgs = messages.map((m) => {
      const im = toImportMessage(m);
      return mode === "enable"
        ? {
            role: m.role,
            createdAt: m.createdAt,
            srcId: m.srcId,
            enc: this.e2e!.encryptContent(sid, { text: im.text, reasoning: im.reasoning, tools: im.tools }),
          }
        : im;
    });
    this.linkb.send({
      ...base,
      found: true,
      title: mode === "enable" ? this.e2e!.encryptText(sid, t) : t,
      messages: msgs,
    });
    // 回灌覆蓋全歷史 → 水位線推到文件末防重複
    this.state.offsets[sid] = endOffset;
    this.save();
    if (mode === "disable") this.e2e?.remove(sid);
    console.log(`· E2E backfill(${mode}) sent for ${sid} (${msgs.length} messages)`);
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
        };
      } catch {
        /* 下一個候選 */
      }
    }
    return { offsets: {}, titles: {}, missingAt: {} };
  }
  private lastSaved = "";
  private save(): void {
    try {
      // #262 dirty 判斷:序列化與上次落盤相同 → 跳過(每 5s 無條件寫盤兩份=主+.bak,≈3.4 萬次/天
      // 傷 SD 卡)。JSON.stringify 遠比兩次 write+rename 便宜。
      const json = JSON.stringify(this.state);
      if (json === this.lastSaved) return;
      mkdirSync(dirname(statePath()), { recursive: true });
      const tmp = `${statePath()}.tmp`;
      writeFileSync(tmp, json);
      if (existsSync(statePath())) renameSync(statePath(), `${statePath()}.bak`); // #6:上一版留作 .bak
      renameSync(tmp, statePath()); // 原子寫（審計 #6 的教訓：別半截損壞）
      this.lastSaved = json;
    } catch {
      /* 持久化失敗不致命 */
    }
  }
}
