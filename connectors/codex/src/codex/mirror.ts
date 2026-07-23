/**
 * §15 鏡像:tail Codex rollout JSONL → mirror_append 到 Macchiato。
 *  - 枚舉 ~/.codex/sessions 下的 rollout-*.jsonl(零依賴文件遍歷,不碰 state sqlite——
 *    node:sqlite 要 Node≥22.5,公開分發不能假設)。cwd 從 session_meta、標題從首條 user 消息。
 *  - 字節偏移水位線,半行留到下輪;新會話只鏡像啟動後的消息(baseline=當前文件末)。
 *  - driven 會話(本進程 codex exec 驅動)live 獨佔投遞,鏡像只快進、不發(防雙投,Hermes 教訓)。
 *  - mirror_nack → 回退該批水位線下輪重發。
 *  - .jsonl.zst(7 天後壓縮)v1 跳過(已過 baseline,不影響增量;history-import 記數不靜默丟)。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LinkBClient } from "../linkb/client";
import type { E2EKeyStore } from "../e2e/keys";
import { readNewMessages, sessionsRoot, type CodexMessage } from "./transcripts";

const POLL_MS = Number(process.env.MACCHIATO_CODEX_POLL_MS) || 5000;
const REWIND_KEEP = 32;
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

/** 從 rollout 內容派生標題(首條 user 消息截斷)與 cwd(session_meta)。 */
export function deriveMeta(content: string): { title: string; cwd?: string } {
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
      title = o.payload.message.replace(/\s+/g, " ").trim().slice(0, 56);
    }
    if (cwd && title) break;
  }
  return { title: title || "Codex", cwd };
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
}

export class Mirror {
  private state: State;
  private timer: ReturnType<typeof setInterval> | null = null;
  private batchId = 0;
  private readonly rewind: Array<{ id: number; prev: Record<string, number>; prevOrd: Record<string, number> }> = [];
  private readonly drivenIds = new Set<string>();
  /**
   * backfill 已送、server 尚未確認提交：key 用 wire sid 接 ACK；value 保留本地 thread uuid，
   * 供 poll/fastForward 凍結及 ACK 後提交本地水位。
   */
  private readonly pendingE2EBackfills = new Map<
    string,
    { localSid: string; endOffset: number; endOrd: number }
  >();
  lastPollAt = Date.now();
  lastError: string | null = null;
  /** #10:累計計數(進程生命週期),健康上報帶出。 */
  readonly counters: Record<string, number> = { mirrorBatches: 0, mirrorMessages: 0, mirrorNacks: 0, mirrorErrors: 0 };
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
  }
  unsetDriven(threadId: string): void {
    this.drivenIds.delete(threadId);
  }

  private hasPendingE2EBackfill(localSid: string): boolean {
    return [...this.pendingE2EBackfills.values()].some((pending) => pending.localSid === localSid);
  }

  /** 回合結束:driven 會話水位線快進到文件末(live 已投遞,鏡像別重複)。 */
  fastForward(threadId: string): void {
    // backfill 快照尚未 ACK 時，任何旁路都不能越過其暫存水位線。
    if (this.hasPendingE2EBackfill(threadId)) return;
    const rf = discoverRollouts().rollouts.find((r) => r.threadId === threadId);
    if (!rf || !existsSync(rf.file)) return;
    try {
      const content = readFileSync(rf.file, "utf8");
      this.state.offsets[threadId] = Buffer.byteLength(content, "utf8");
      this.state.ords[threadId] = content.split("\n").length;
      this.save();
    } catch {
      /* 下輪 poll 兜底 */
    }
  }

  start(): void {
    if (this.disabled) {
      // ⚠️ 回歸契約:scripts/localchain/scenarios-mirror-off.mjs 斷言此串,改文案需同步
      console.log("· Mirror disabled (MACCHIATO_MIRROR=off) — terminal sessions stay out of the app; app-driven sessions unaffected");
      return;
    }
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    console.log(`· Mirror started (poll ${POLL_MS / 1000}s, tailing ${sessionsRoot()})`);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
  restart(): void {
    this.stop();
    this.polling = false;
    this.start();
  }

  handleNack(batchId: number): void {
    const e = this.rewind.find((r) => r.id === batchId);
    if (!e) return;
    this.counters.mirrorNacks += 1; // #10
    for (const [k, off] of Object.entries(e.prev)) this.state.offsets[k] = off;
    for (const [k, o] of Object.entries(e.prevOrd)) this.state.ords[k] = o;
    this.save();
    console.warn(`· mirror_nack batch ${batchId} → rewinding watermark for resend`);
  }

  /** server backfill 事務結果：只有成功 ACK 才提交對應快照水位線。 */
  handleE2EBackfillResult(
    wireSid: string,
    mode: "enable" | "disable",
    committed: boolean,
  ): void {
    const pendingKey = `${mode}:${wireSid}`;
    const pending = this.pendingE2EBackfills.get(pendingKey);
    this.pendingE2EBackfills.delete(pendingKey);
    if (!committed || !pending) return;
    this.state.offsets[pending.localSid] = Math.max(
      this.state.offsets[pending.localSid] ?? 0,
      pending.endOffset,
    );
    this.state.ords[pending.localSid] = Math.max(this.state.ords[pending.localSid] ?? 0, pending.endOrd);
    this.save();
    console.log(
      `· E2E backfill ACK(${mode}): ${wireSid} (local ${pending.localSid}; watermark → ${pending.endOffset})`,
    );
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      this.pollOnce();
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.counters.mirrorErrors += 1; // #10
      console.error("[mirror poll error]", this.lastError);
    } finally {
      this.polling = false;
      this.lastPollAt = Date.now();
    }
  }

  private pollOnce(): void {
    if (!this.linkb.isReady) return;
    const { rollouts } = discoverRollouts();
    this.pruneState(new Set(rollouts.map((r) => r.threadId)));
    const batch: any[] = [];
    const prev: Record<string, number> = {};
    const prevOrd: Record<string, number> = {};
    for (const { file, threadId } of rollouts) {
      if (this.state.tombstones?.includes(threadId)) continue; // #161 app 刪過 → 永不再撈
      // backfill 快照已送但 server 尚未 ACK：避免普通 poll 跨過/混入同一轉換窗口。
      if (this.hasPendingE2EBackfill(threadId)) continue;
      // #262 stat-first:非 driven 且水位線已到檔末 → 跳過,不 readFileSync。每 5s 對每個未變
      // rollout 全量重讀是 Pi 上的主要開銷(CC 鏡像早已 stat-first);driven/首基線仍讀。
      const off0 = this.state.offsets[threadId];
      if (!this.drivenIds.has(threadId) && off0 !== undefined) {
        try {
          if (statSync(file).size <= off0) continue;
        } catch {
          continue;
        }
      }
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const size = Buffer.byteLength(content, "utf8");
      const off = this.state.offsets[threadId];
      if (this.drivenIds.has(threadId)) {
        this.state.offsets[threadId] = size; // live 獨佔 → 只快進
        this.state.ords[threadId] = content.split("\n").length;
        continue;
      }
      if (off === undefined) {
        // #236:`seeded` 持久化(對齊 CC #154)——首掃把存量會話基線到檔末(歷史走「導入」,
        // 避免裝上/重啟即全量回灌);首掃**成功走完**之後新出現的 rollout(終端新開的會話,
        // 含連接器停機期間新建的)→ 從頭鏡像,首拍不丟。舊版此處是進程級旗標且從未置 true,
        // 導致新會話一律被誤基線、首次發現前的消息永丟。
        if (!this.state.seeded) {
          this.state.offsets[threadId] = size;
          this.state.ords[threadId] = content.split("\n").length;
          continue;
        }
      }
      const startOff = off ?? 0;
      if (size <= startOff) continue;
      const ordBase = this.state.ords[threadId] ?? 0;
      const { messages, newOffset, lineCount } = readNewMessages(content, startOff, ordBase);
      if (messages.length) {
        prev[threadId] = startOff;
        prevOrd[threadId] = ordBase;
        const { title } = deriveMeta(content);
        // app-driven E2E 的 key/session identity 掛在 wire ULID，rollout 則以本地 UUID 命名。
        // unsetDriven 後 terminal 續聊必須仍回到 wire session 並用 wire key 加密，不能另建
        // local UUID 的 plaintext shadow session。
        const mappedWireSid = this.e2eWireSidForLocal?.(threadId);
        const e2eSid = mappedWireSid ?? (this.e2e?.isE2E(threadId) ? threadId : undefined);
        if (e2eSid) {
          batch.push({
            hermesSessionId: e2eSid,
            title: this.e2e!.encryptText(e2eSid, title),
            source: "codex",
            e2e: true,
            messages: messages.map((m) => ({
              role: m.role,
              srcId: srcIdFor(threadId, m),
              enc: this.e2e!.encryptContent(e2eSid, { text: m.text }),
            })),
          });
        } else if (this.plaintextLocalAllowed?.() === false) {
          console.error(
            `[mirror] E2E identity map 不可信，凍結未知 Codex rollout ${threadId}，不推水位/不發明文`,
          );
          continue;
        } else {
          batch.push({
            hermesSessionId: threadId,
            title,
            source: "codex",
            messages: messages.map((m) => ({ role: m.role, text: m.text, srcId: srcIdFor(threadId, m) })),
          });
        }
      }
      this.state.offsets[threadId] = newOffset;
      this.state.ords[threadId] = ordBase + lineCount;
    }
    if (batch.length) {
      this.batchId += 1;
      this.rewind.push({ id: this.batchId, prev, prevOrd });
      if (this.rewind.length > REWIND_KEEP) this.rewind.shift();
      this.linkb.send({ t: "mirror_append", agentLinkId: this.linkb.agentLinkId, sessions: batch, batchId: this.batchId });
      this.counters.mirrorBatches += 1; // #10
      this.counters.mirrorMessages += batch.reduce((a: number, s: any) => a + (s.messages?.length ?? 0), 0);
    }
    this.state.seeded = true; // #236 首掃完成:此後新發現的 rollout 才從頭鏡像
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
    const rf = localSid
      ? discoverRollouts().rollouts.find((r) => r.threadId === localSid)
      : undefined;
    const notFound = (): void => {
      this.linkb.send({
        t: "e2e_backfill",
        agentLinkId: this.linkb.agentLinkId,
        hermesSessionId: wireSid,
        mode,
        found: false,
      });
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
    const { title } = deriveMeta(content);
    const session =
      mode === "enable"
        ? {
            hermesSessionId: wireSid,
            title: this.e2e.encryptText(wireSid, title),
            source: "codex",
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
            messages: messages.map((m) => ({
              role: m.role,
              text: m.text,
              srcId: srcIdFor(localSid, m),
            })),
          };
    // 只有完整明文 snapshot 已成功构造后才签 completion receipt；先双快照持久化再发送。
    const disableReceipt =
      mode === "disable" ? this.e2e.disableReceiptForBackfill(wireSid) : undefined;
    this.linkb.send({
      t: "e2e_backfill",
      agentLinkId: this.linkb.agentLinkId,
      hermesSessionId: wireSid,
      mode,
      found: true,
      session,
      ...(disableReceipt ? { disableReceipt } : {}),
    });
    this.pendingE2EBackfills.set(`${mode}:${wireSid}`, {
      localSid,
      endOffset: Buffer.byteLength(content, "utf8"),
      endOrd: content.split("\n").length,
    });
    console.log(
      `· E2E backfill(${mode}) submitted for ${wireSid} (local ${localSid}; ${messages.length} messages; waiting for server ACK)`,
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
        };
      } catch {
        /* 下一個候選 */
      }
    }
    return { offsets: {}, ords: {} };
  }
  private lastSaved = "";
  private save(): void {
    try {
      // #262 dirty 判斷:與上次落盤相同 → 跳過(每 5s 無條件雙寫傷 SD 卡;Pi OOM/SD 前科)。
      const json = JSON.stringify(this.state);
      if (json === this.lastSaved) return;
      mkdirSync(dirname(statePath()), { recursive: true });
      const tmp = `${statePath()}.tmp`;
      writeFileSync(tmp, json);
      if (existsSync(statePath())) renameSync(statePath(), `${statePath()}.bak`); // #6:上一版留 .bak
      renameSync(tmp, statePath()); // 原子寫
      this.lastSaved = json;
    } catch {
      /* 持久化失敗不致命 */
    }
  }
}
