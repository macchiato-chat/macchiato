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
}

export class Mirror {
  private state: State;
  private timer: ReturnType<typeof setInterval> | null = null;
  private batchId = 0;
  private readonly rewind: Array<{ id: number; prev: Record<string, number> }> = [];
  private readonly drivenSids = new Set<string>();
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
  private polling = false;

  constructor(
    private readonly linkb: LinkBClient,
    private readonly e2e?: E2EKeyStore,
  ) {
    this.state = this.load();
  }

  start(): void {
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
    for (const [k, off] of Object.entries(e.prev)) this.state.offsets[k] = off;
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
    for (const { sid, file } of discoverSessions()) {
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
      // 未知會話 → 從 0 全量鏡像（完整歷史，這是相對官方 remote control 的核心——自動看到所有會話；
      // 不再 baseline 到文件末依賴手動 import。srcId 去重保證重發安全、新會話為空插入順序正確）。
      if (!(sid in this.state.offsets)) this.state.offsets[sid] = 0;

      if (this.drivenSids.has(sid)) {
        this.state.offsets[sid] = size; // live 獨佔投遞：只快進
        // driven 回合的工作態由 live 路徑權威投遞——鏡像側靜默讓路（不發 false 防踩 live 的 true）。
        this.busySids.delete(sid);
        this.quietPolls.delete(sid);
        continue;
      }
      // 已判定的內部 fork 檔且沒長 → 不重讀。
      if ((this.state.offsets[sid] ?? 0) === 0 && this.internalAt.get(sid) === size) continue;

      // 追平：單會話分批發（每批 ≤ BATCH_MAX 條），單帧只裝一條會話 → 防超 server maxPayload(8MiB)。
      let guard = 0;
      while (guard++ < 2000) {
        const off = this.state.offsets[sid] ?? 0;
        if (size <= off) break;
        const { entries, endOffset } = readEntries(file, off);
        if (!entries.length) break;
        const { messages, consumedUpTo, title } = foldEntries(entries, endOffset, Date.now(), batchMax());
        // 內部 fork 檔判定：首批（水位線 0）折出的消息裡沒有一條真人消息 → subagent/後台任務
        // 的 fork 轉錄（真會話首批必含首條 user prompt）。跳過、不推水位線。
        if (off === 0 && messages.length && !messages.some((m) => m.role === "user")) {
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
          this.sendOne(sid, this.entry(sid, newTitle ?? this.state.titles[sid] ?? "Claude Code", messages), off);
          if (newTitle) this.state.titles[sid] = newTitle;
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
    this.save();
  }

  /** 發一條會話的一批（單帧單會話）；記 rewind 供 nack 回退。 */
  private sendOne(sid: string, entry: Record<string, unknown>, prevOff: number): void {
    this.batchId += 1;
    this.rewind.push({ id: this.batchId, prev: { [sid]: prevOff } });
    if (this.rewind.length > REWIND_KEEP) this.rewind.shift();
    this.linkb.send({
      t: "mirror_append",
      agentLinkId: this.linkb.agentLinkId,
      sessions: [entry],
      batchId: this.batchId,
    });
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

  private load(): State {
    try {
      const s = JSON.parse(readFileSync(statePath(), "utf8")) as State;
      return { offsets: s.offsets ?? {}, titles: s.titles ?? {} };
    } catch {
      return { offsets: {}, titles: {} };
    }
  }
  private save(): void {
    try {
      mkdirSync(dirname(statePath()), { recursive: true });
      const tmp = `${statePath()}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, statePath()); // 原子寫（審計 #6 的教訓：別半截損壞）
    } catch {
      /* 持久化失敗不致命 */
    }
  }
}
