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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LinkBClient } from "../linkb/client";
import type { E2EKeyStore } from "../e2e/keys";
import { readNewMessages, sessionsRoot, type CodexMessage } from "./transcripts";

const POLL_MS = Number(process.env.MACCHIATO_CODEX_POLL_MS) || 5000;
const REWIND_KEEP = 32;

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
function srcIdFor(threadId: string, m: CodexMessage): string {
  return createHash("sha256").update(`${threadId} ${m.role} ${m.ord} ${m.text}`).digest("hex").slice(0, 24);
}

interface State {
  offsets: Record<string, number>; // threadId → 字節水位線
  ords: Record<string, number>; // threadId → 下一起始行號(ord 連續)
}

export class Mirror {
  private state: State;
  private timer: ReturnType<typeof setInterval> | null = null;
  private batchId = 0;
  private readonly rewind: Array<{ id: number; prev: Record<string, number>; prevOrd: Record<string, number> }> = [];
  private readonly drivenIds = new Set<string>();
  lastPollAt = Date.now();
  lastError: string | null = null;
  private polling = false;
  /** 首輪 poll 已建立基線——之後新出現的 rollout 從頭鏡像(而非跳過)。 */
  private baselined = false;

  constructor(
    private readonly linkb: LinkBClient,
    private readonly e2e?: E2EKeyStore,
  ) {
    this.state = this.load();
  }

  setDriven(threadId: string): void {
    this.drivenIds.add(threadId);
  }
  unsetDriven(threadId: string): void {
    this.drivenIds.delete(threadId);
  }

  /** 回合結束:driven 會話水位線快進到文件末(live 已投遞,鏡像別重複)。 */
  fastForward(threadId: string): void {
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
    for (const [k, off] of Object.entries(e.prev)) this.state.offsets[k] = off;
    for (const [k, o] of Object.entries(e.prevOrd)) this.state.ords[k] = o;
    this.save();
    console.warn(`· mirror_nack batch ${batchId} → rewinding watermark for resend`);
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      this.pollOnce();
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      console.error("[mirror poll error]", this.lastError);
    } finally {
      this.polling = false;
      this.lastPollAt = Date.now();
    }
  }

  private pollOnce(): void {
    if (!this.linkb.isReady) return;
    const { rollouts } = discoverRollouts();
    const batch: any[] = [];
    const prev: Record<string, number> = {};
    const prevOrd: Record<string, number> = {};
    for (const { file, threadId } of rollouts) {
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
        if (!this.baselined) {
          // 首輪:存量會話建基線(跳過歷史,避免每次啟動全量回灌——導入走 runImport)
          this.state.offsets[threadId] = size;
          this.state.ords[threadId] = content.split("\n").length;
          continue;
        }
        // 連接器啟動後**新出現**的 rollout(終端新開的會話)→ 從頭鏡像
      }
      const startOff = off ?? 0;
      if (size <= startOff) continue;
      const ordBase = this.state.ords[threadId] ?? 0;
      const { messages, newOffset, lineCount } = readNewMessages(content, startOff, ordBase);
      if (messages.length) {
        prev[threadId] = startOff;
        prevOrd[threadId] = ordBase;
        const { title } = deriveMeta(content);
        if (this.e2e?.isE2E(threadId)) {
          batch.push({
            hermesSessionId: threadId,
            title: this.e2e.encryptText(threadId, title),
            source: "codex",
            e2e: true,
            messages: messages.map((m) => ({
              role: m.role,
              srcId: srcIdFor(threadId, m),
              enc: this.e2e!.encryptContent(threadId, { text: m.text }),
            })),
          });
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
    }
    this.save();
  }

  /**
   * §19 D2 / 關閉:把該會話 rollout 全量歷史以 e2e_backfill 回灌(server 事務內原地替換)。
   * enable:K_S 重加密;disable:明文回灌 + 刪 K_S。找不到會話/無消息 → found:false。
   */
  async backfillE2E(threadId: string, mode: "enable" | "disable" = "enable"): Promise<void> {
    if (!this.e2e) return;
    const rf = discoverRollouts().rollouts.find((r) => r.threadId === threadId);
    const notFound = (): void => {
      this.linkb.send({ t: "e2e_backfill", agentLinkId: this.linkb.agentLinkId, hermesSessionId: threadId, mode, found: false });
    };
    if (!rf || !existsSync(rf.file)) return notFound();
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
            hermesSessionId: threadId,
            title: this.e2e.encryptText(threadId, title),
            source: "codex",
            e2e: true,
            messages: messages.map((m) => ({ role: m.role, enc: this.e2e!.encryptContent(threadId, { text: m.text }) })),
          }
        : { hermesSessionId: threadId, title, source: "codex", messages: messages.map((m) => ({ role: m.role, text: m.text })) };
    this.linkb.send({ t: "e2e_backfill", agentLinkId: this.linkb.agentLinkId, hermesSessionId: threadId, mode, found: true, session });
    this.state.offsets[threadId] = Buffer.byteLength(content, "utf8");
    this.state.ords[threadId] = content.split("\n").length;
    this.save();
    if (mode === "disable") this.e2e.remove(threadId);
  }

  private load(): State {
    try {
      const s = JSON.parse(readFileSync(statePath(), "utf8"));
      return { offsets: s.offsets ?? {}, ords: s.ords ?? {} };
    } catch {
      return { offsets: {}, ords: {} };
    }
  }
  private save(): void {
    try {
      mkdirSync(dirname(statePath()), { recursive: true });
      writeFileSync(statePath(), JSON.stringify(this.state));
    } catch {
      /* 持久化失敗不致命 */
    }
  }
}
