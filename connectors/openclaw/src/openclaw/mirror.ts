/**
 * §15 鏡像：tail OpenClaw 的 .jsonl transcript → mirror_append 到 Macchiato。
 *  - 索引（標題/平台）來自 gateway `sessions.list`；消息來自各會話 `<sessionId>.jsonl`
 *    （穩定 append-only, 以**字節偏移**做水位線, 半行字節留到下輪）。
 *  - 新會話只鏡像「連接器啟動後」的消息（baseline = 當前文件末）, 避免全量回灌。
 *  - durable outbox（#348 / F-10 #487）：幀落盤後才發，只有 `mirror_ack` 才提交水位；
 *    `mirror_nack` 默認保留原批重發，終態 `code`（`e2e_direction` / `malformed`）則丟批。
 *    死在 ACK 前不靜默跳批——重啟後同 batchId 重放。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { LinkBClient } from "../linkb/client";
import type { OpenClawGateway } from "./gateway";
import type { E2EKeyStore } from "../e2e/keys";

const POLL_MS = Number(process.env.MACCHIATO_OPENCLAW_POLL_MS) || 5000;
/** #9:水位線條目從 sessions.list 消失多久後裁掉(默認 7 天)。 */
const PRUNE_MS = Number(process.env.MACCHIATO_MIRROR_PRUNE_MS) || 7 * 24 * 3600 * 1000;

/**
 * 鏡像狀態檔的耐久寫（0600 + fsync + 原子 rename + 目錄 fsync）。
 * durable outbox 起裝完整消息正文——與 CC/Codex 同款，掉電也不得半截/默認 0644。
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
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** #6:狀態文件安全讀寫——原子寫 + .bak 輪替;主文件損壞/丟失從 .bak 恢復。
 * 此前 load 失敗靜默重置 = 所有會話回到 baseline-to-end,中間消息永久跳過(寧重發不丟)。 */
export function loadStateFile<T>(path: string, revive: (raw: any) => T, fallback: () => T): T {
  for (const [p, isBak] of [[path, false], [`${path}.bak`, true]] as Array<[string, boolean]>) {
    try {
      const s = revive(JSON.parse(readFileSync(p, "utf8")));
      if (isBak) {
        console.error(`⚠️ ${path} 損壞/丟失 → 已從 .bak 恢復水位線(有意重置請連 .bak 一併刪除)`);
      }
      return s;
    } catch {
      /* 下一個候選 */
    }
  }
  return fallback();
}

/** 與 loadStateFile 同樣恢復內容，但額外保留「身份是否來自主檔」；舊代 .bak 不可證明 E2E 映射完整。 */
export function loadStateFileWithTrust<T>(
  path: string,
  revive: (raw: any) => T,
  fallback: () => T,
): { state: T; identityStateTrusted: boolean } {
  for (const [p, isPrimary] of [[path, true], [`${path}.bak`, false]] as Array<[string, boolean]>) {
    try {
      return { state: revive(JSON.parse(readFileSync(p, "utf8"))), identityStateTrusted: isPrimary };
    } catch {
      /* 下一個候選 */
    }
  }
  return { state: fallback(), identityStateTrusted: false };
}

export function saveStateFile(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  if (existsSync(path)) renameSync(path, `${path}.bak`); // 上一版留作 .bak(#6)
  renameSync(tmp, path);
}

/** Macchiato 新建會話的 key 前綴（drive 專屬、無渠道綁定）—— 純 live 路徑, 鏡像永久跳過。 */
export const MACCHIATO_PREFIX = "agent:main:macchiato:";

/**
 * ⚠️ OpenClaw 會把 session key **轉小寫**（真機實測）。故 key 一律用小寫生成/比對；
 * server 的原始 sid（大寫 ULID）由 Drive.sidByKey 找回。（原在 drive.ts, 鏡像的 E2E 回灌也要用 → 移ここ）
 */
export function keyForSid(sid: string): string {
  return (sid.startsWith("agent:") ? sid : MACCHIATO_PREFIX + sid).toLowerCase();
}
export function sidForKey(key: string): string {
  return key.startsWith(MACCHIATO_PREFIX) ? key.slice(MACCHIATO_PREFIX.length) : key;
}

function statePath(): string {
  return process.env.MACCHIATO_OPENCLAW_MIRROR || join(homedir(), ".macchiato/openclaw-mirror.json");
}
function sessionsDir(): string {
  return join(process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw"), "agents/main/sessions");
}

export interface MirrorTool {
  callId: string;
  name: string;
  state: "ok" | "error";
  input?: unknown;
  output?: string;
}
export interface MirrorMessage {
  role: "user" | "agent";
  text: string;
  createdAt?: number;
  /** #61:assistant 的 thinking 塊(對齊 Hermes 的 reasoning)。 */
  reasoning?: string;
  /** #61:assistant 的 toolCall 塊(output 由後續 toolResult 行折入,對齊 Hermes/CC)。 */
  tools?: MirrorTool[];
}

/** #61:工具輸出上限(防單條結果撐爆批;Hermes 側不截,但 OpenClaw exec/web_fetch 輸出可以很大)。 */
const TOOL_OUTPUT_MAX = 10_000;
/** #61:尾部未結算 toolCall 的 hold-back 時限——超過視為 agent 崩了,照發(對齊 Hermes STALE_TURN_S)。 */
const STALE_TURN_MS = Number(process.env.MACCHIATO_STALE_TURN_S ?? 600) * 1000;
/** #152:單會話單幀每批消息上限(對齊 CC ≈150;防超大 mirror_append 撞 server 8MiB/內存尖峰)。 */
const BATCH_MAX = Number(process.env.MACCHIATO_OPENCLAW_BATCH_MAX ?? 150);

/**
 * §9 鏡像去重身份：OpenClaw .jsonl 消息無穩定 id → 用內容指紋（role+text+createdAt 的 sha256 前綴）。
 * 連接器重發時同一 .jsonl 行逐字節相同 → 指紋相同 → server 據 (session, srcId) 去重。確定性、無狀態。
 */
export function srcIdFor(m: MirrorMessage): string {
  return createHash("sha256")
    .update(`${m.role}\u0000${m.text}\u0000${m.createdAt ?? ""}`)
    .digest("hex")
    .slice(0, 24);
}

// OpenClaw 給渠道消息注入的 metadata wrapper, 標籤多樣（"Conversation info" / "Sender" …）, 
// 形如 `<label> (untrusted metadata):\n```json\n{...}\n```\n\n<正文>`。首行匹配。
const META_RE = /^[^\n]{0,40}\(untrusted metadata\):/;

/**
 * 剝掉 metadata wrapper、取真實正文（否則導入後每條用戶消息都頂著一坨 json）。
 * 循環剝離（一條消息可能疊了多層 wrapper）。非 wrapper 原樣返回。
 */
export function cleanUserText(text: string): string {
  let t = text;
  while (META_RE.test(t)) {
    const open = t.indexOf("```");
    if (open < 0) break;
    const close = t.indexOf("```", open + 3);
    if (close < 0) break;
    t = t.slice(close + 3).replace(/^\s+/, "");
  }
  return t;
}

/** 從用戶消息的 metadata wrapper 提頻道信息（深度導入用：標題/來源/按頻道合併）。掃所有 json 塊。 */
export function extractChannelMeta(rawUserText: string): { channelId?: string; channelName?: string } {
  if (!/\(untrusted metadata\):/.test(rawUserText.slice(0, 200))) return {};
  for (const m of rawUserText.matchAll(/```json\s*([\s\S]*?)```/g)) {
    try {
      const j = JSON.parse(m[1]) as Record<string, unknown>;
      const channelName = (j.group_channel || j.group_subject) as string | undefined;
      const idMatch = String(j.conversation_label || "").match(/channel id:(\d+)/);
      if (channelName || idMatch) return { channelId: idMatch?.[1], channelName };
    } catch {
      /* 下一塊 */
    }
  }
  return {};
}

/** 一行 .jsonl 的 user messages原始文本（未清洗, 供 extractChannelMeta）；非 user 返回 null。 */
export function rawUserText(o: any): string | null {
  if (!o || o.type !== "message" || o.message?.role !== "user") return null;
  return (Array.isArray(o.message.content) ? o.message.content : [])
    .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("");
}

/**
 * 一行 .jsonl → 消息。user 取 text(去 metadata wrapper;content 也可能是純字符串);
 * #61:assistant 除 text 外還取 thinking → reasoning、toolCall → tools(output 空缺,
 * 由 foldMessages 用後續 toolResult 行折入)。toolResult/系統行返回 null。
 */
export function lineToMessage(o: any): MirrorMessage | null {
  if (!o || o.type !== "message" || !o.message) return null;
  const m = o.message;
  const role = m.role === "user" ? "user" : m.role === "assistant" ? "agent" : null;
  if (!role) return null;
  const blocks: any[] = Array.isArray(m.content) ? m.content : [];
  const raw =
    typeof m.content === "string"
      ? m.content
      : blocks.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
  const text = role === "user" ? cleanUserText(raw) : raw;
  const out: MirrorMessage = { role, text, createdAt: typeof m.timestamp === "number" ? m.timestamp : o.timestamp };
  if (role === "agent") {
    const reasoning = blocks
      .filter((b) => b && b.type === "thinking" && typeof b.thinking === "string")
      .map((b) => b.thinking)
      .join("\n");
    if (reasoning.trim()) out.reasoning = reasoning;
    const tools: MirrorTool[] = blocks
      .filter((b) => b && b.type === "toolCall" && (b.id || b.name))
      .map((b) => ({
        callId: String(b.id ?? ""),
        name: String(b.name ?? "tool"),
        state: "ok" as const,
        ...(b.arguments !== undefined || b.input !== undefined ? { input: b.arguments ?? b.input } : {}),
      }));
    if (tools.length) out.tools = tools;
  }
  if (!out.text.trim() && !out.reasoning && !out.tools?.length) return null;
  return out;
}

/**
 * #61:跨行折疊——assistant 的 toolCall 與後續 toolResult 行(message 級帶 toolCallId/
 * toolName/isError,結果正文在 text 塊;變體:toolResult 塊的 content 字串)按 callId 配對,
 * output 折入 tools。返回消息數組 + 每條消息來自哪個 objs 下標(hold-back 定位行首用)。
 */
export function foldMessages(objs: any[]): { messages: MirrorMessage[]; srcIndex: number[] } {
  const messages: MirrorMessage[] = [];
  const srcIndex: number[] = [];
  const byCallId = new Map<string, MirrorTool>();
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    const m = o?.message;
    if (o?.type === "message" && m?.role === "toolResult") {
      const cid = String(m.toolCallId ?? m.tool_use_id ?? "");
      const tool = cid ? byCallId.get(cid) : undefined;
      if (tool) {
        const blocks: any[] = Array.isArray(m.content) ? m.content : [];
        let outText = blocks
          .filter((b) => b && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("");
        if (!outText) {
          outText = blocks
            .filter((b) => b && b.type === "toolResult" && typeof b.content === "string")
            .map((b) => b.content)
            .join("");
        }
        tool.output = outText.slice(0, TOOL_OUTPUT_MAX);
        if (m.isError === true) tool.state = "error";
      }
      continue;
    }
    const msg = lineToMessage(o);
    if (!msg) continue;
    for (const t of msg.tools ?? []) if (t.callId) byCallId.set(t.callId, t);
    messages.push(msg);
    srcIndex.push(i);
  }
  return { messages, srcIndex };
}

/**
 * OpenClaw 會話 → Macchiato 標題。頻道會話的 `displayName` 形如 `discord:<guildId>#<channel>`
 * → 取 `#<channel>`（如 `#crypto`）；Cron / 直接名等已是可讀標籤, 保持原樣。
 * （OpenClaw 不像 Hermes 生成摘要標題、頻道會話 label 為空, 故只能把頻道標識清理得可讀。）
 */
export function deriveTitle(s: { displayName?: string; key?: string; channel?: string }): string {
  const dn = s.displayName;
  if (!dn) return s.key || "OpenClaw";
  if (s.channel && dn.startsWith(`${s.channel}:`) && dn.includes("#")) {
    return dn.slice(dn.lastIndexOf("#")); // "discord:<guildId>#crypto" → "#crypto"
  }
  return dn;
}

/** 平台來源（Macchiato 的 badge）。 */
export function deriveSource(s: { channel?: string; origin?: { provider?: string } }): string {
  return s.channel || s.origin?.provider || "openclaw";
}

/** #347 只有与方向一致的事务结果才可提交水位线/密钥状态。 */
export function isCommittedE2EBackfillResult(
  mode: "enable" | "disable",
  ok: unknown,
  e2e: unknown,
): boolean {
  return ok === true && (mode === "enable" ? e2e === true : e2e === false);
}

/**
 * cron 會話（key 含 `:cron:`）：OpenClaw 已把 cron 輸出**插入 deliver target 的聊天記錄**, 
 * 單獨鏡像/導入會重複 → 跳過（與 Hermes 的 §16 cron feed 不同, OpenClaw 不需要合成 feed）。
 */
export function isCronSession(key: string | undefined): boolean {
  return /:cron:/.test(key || "");
}

/** 從 offset 起讀新內容, 按整行解析（剩半行留到下次）。返回消息 + 新 offset。
 * #61:toolCall 與 toolResult 跨行折疊;尾部 agent 消息的 toolCall 還沒等到結果(回合
 * 進行中)→ hold-back:本輪不發、offset 停在它的行首,下輪連 toolResult 一起重讀。
 * 太舊(>STALE_TURN_MS,agent 中途崩)則照發,免得該會話鏡像永久卡死(對齊 Hermes 修 C)。 */
export function readNewMessages(file: string, offset: number, maxMessages?: number): { messages: MirrorMessage[]; newOffset: number } {
  const size = statSync(file).size;
  if (size <= offset) return { messages: [], newOffset: offset };
  const buf = Buffer.allocUnsafe(size - offset);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { messages: [], newOffset: offset }; // 尚無完整行
  const objs: any[] = [];
  const lineStarts: number[] = [];
  let cursor = offset;
  for (const line of buf.subarray(0, lastNl).toString("utf8").split("\n")) {
    const start = cursor;
    cursor += Buffer.byteLength(line, "utf8") + 1;
    const s = line.trim();
    if (!s) continue;
    try {
      objs.push(JSON.parse(s));
      lineStarts.push(start);
    } catch {
      /* 壞行跳過 */
    }
  }
  const { messages, srcIndex } = foldMessages(objs);
  // #152 batchMax:超出上限截斷到第 max 條,newOffset 指向首條未消費消息的行首(下輪 poll 續讀)。
  // 截斷後的 toolResult 折疊已跨全窗完成——下輪重讀到孤兒 toolResult 行會被 foldMessages 丟棄,不重不漏。
  if (maxMessages !== undefined && messages.length > maxMessages) {
    return {
      messages: messages.slice(0, maxMessages),
      newOffset: lineStarts[srcIndex[maxMessages]!]!,
    };
  }
  const last = messages[messages.length - 1];
  if (last && last.role === "agent" && last.tools?.some((t) => t.output === undefined)) {
    const ts = typeof last.createdAt === "number" ? last.createdAt : Date.now();
    if (Date.now() - ts < STALE_TURN_MS) {
      return {
        messages: messages.slice(0, -1),
        newOffset: lineStarts[srcIndex[messages.length - 1]!]!,
      };
    }
  }
  return { messages, newOffset: offset + lastNl + 1 };
}

interface State {
  offsets: Record<string, number>;
  /** #9:key 首次從 sessions.list 消失的時刻;回歸即清。超 PRUNE_MS → 連 offsets 一起裁。 */
  missingAt?: Record<string, number>;
  /** #161 墓碑:app 刪過的會話 key,鏡像/打撈永不再撈(agent 側 .jsonl 不動)。 */
  tombstones?: string[];
  /** #211 水位線的文件身份:key → 上次消費的 sessionId。gateway 升級/會話重置會給同一 key 換新
   * .jsonl(2026-07-14 OpenClaw 2026.7.1 實測)——舊字節水位線壓在新文件上 offset>size → 永久靜默
   * 跳過。fileId 變 → 從 0 重讀(srcId 內容指紋去重,重讀安全)。 */
  fileIds?: Record<string, string>;
  /**
   * #347 E2E identity aliases：同一 key 歷代所有 transcript sessionId。
   * fileIds 只代表當前檔；rotation 覆蓋後舊 .jsonl 仍留在磁碟，history import 只看 local UUID，
   * 故舊 UUID 也必須永久保留在保護集合。缺此字段的舊 schema 不可宣告 E2E identity 完整。
   */
  fileIdAliases?: Record<string, string[]>;
  /**
   * aliases 是否涵蓋此 registry 建立以來的完整歷史。不可由「字段存在」推斷：
   * 舊 schema 在 protected 狀態下補 seed 仍可能早已丟過 rotation alias，必須持久 false。
   */
  aliasHistoryTrusted?: boolean;
  /**
   * #348 / F-10 durable outbox：已發未 ACK 的 mirror_append 幀。
   * ACK 前不得提交 offsets；重啟後按同 batchId 重放。ACK 可亂序——同 key 只從隊首連續提交。
   */
  pendingMirrors?: Array<{
    batchId: string;
    frame: Record<string, unknown>;
    key: string;
    endOffset: number;
    /** ACK 可亂序到達；只有同 key 的前序批全 ACK 後才允許連續提交水位。 */
    acked?: boolean;
  }>;
}

export class Mirror {
  private state: State;
  /** key↔本地 transcript 身份只在主 mirror state 完整解析時可信。 */
  private identityStateTrusted = false;
  /** 歷代 local UUID registry 只有新 schema 主檔可證明完整；舊 schema/backup 不得靠普通 save 自升。 */
  private aliasHistoryTrusted = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** drive 驅動中的 key：live 路徑獨佔投遞文字;#147 鏡像只「打撈」tool/thinking(去正文),不發文字（防雙投）。 */
  private readonly drivenKeys = new Set<string>();
  /** #147 driven key → server sid(真大小寫;mirror_append 的 hermesSessionId 用它,sidForKey 會丟大小寫)。 */
  private readonly drivenSidByKey = new Map<string, string>();
  private driveIdentityResolver?: (identity: string) => string | undefined;
  private plaintextLocalAllowed?: () => boolean;
  /** #432 live 已投工具的原地補全鉤子(未接線時退化為舊行為:全部 append)。 */
  private liveToolEnricher?: (sid: string, tool: MirrorTool) => boolean;
  /** identity state 寫失敗後保持 poison；任何內容路徑須等同一完整快照重試成功才可繼續。 */
  private identityPersistenceDirty = false;
  /** 每次 history import 前須先以 gateway 當前 key→sessionId 對賬，防離線 rotation 新 UUID 漏保護。 */
  private identityPreflightComplete = false;
  /** durable outbox 最近一次 send 時刻（重啟後 0 → 立刻重放）。 */
  private readonly sentBatchAt = new Map<string, number>();
  /** 健康：最近一次 poll 完成時刻（watchdog 用）。 */
  lastPollAt = Date.now();
  /** 健康：最近一次 poll 錯誤（成功清空）。 */
  lastError: string | null = null;
  /**
   * #348 lastError 的「未結清」標記。poll 成功返回**不等於**問題解決——NACK 後批次仍留在
   * durable outbox 重試、水位就是不動的。錯誤一旦記下就黏住，直到真有一批被 server 提交（ACK）。
   */
  private errorSticky = false;
  /** #10:累計計數(進程生命週期),健康上報帶出。 */
  readonly counters: Record<string, number> = {
    mirrorBatches: 0,
    mirrorMessages: 0,
    mirrorNacks: 0,
    mirrorErrors: 0,
    mirrorDirectionRewinds: 0,
    mirrorDropped: 0,
  };
  private polling = false;
  /** #347 backfill send 不是提交成功；水位线/K_S 要等 server 事务 ACK。 */
  private readonly pendingE2EBackfills = new Map<
    string,
    { key: string; newOffset?: number }
  >();

  /** backfill ACK 前冻结该会话所有水位推进；ACK 丢失时宁可重试/停住，不能跳过唯一历史。 */
  private isE2ETransitionLocked(key: string): boolean {
    for (const pending of this.pendingE2EBackfills.values()) {
      if (pending.key === key) return true;
    }
    return false;
  }

  /** #161 墓碑:永不再鏡像/打撈此 key(持久;agent 側檔案不動)。 */
  tombstone(key: string): void {
    const t = (this.state.tombstones ??= []);
    if (!t.includes(key)) {
      t.push(key);
      this.save();
      console.log(`· 墓碑 ${key}(鏡像永不再撈)`);
    }
  }

  setDriven(key: string, sid?: string): void {
    this.drivenKeys.add(key);
    if (sid) this.drivenSidByKey.set(key, sid);
  }

  setDriveIdentityResolver(
    resolver: (identity: string) => string | undefined,
    plaintextLocalAllowed: () => boolean,
  ): void {
    this.driveIdentityResolver = resolver;
    this.plaintextLocalAllowed = plaintextLocalAllowed;
  }

  /** #432 打撈時判別「live 已投過的工具」並原地補內容(見 Drive.enrichLiveTool)。 */
  setLiveToolEnricher(
    enrich: (sid: string, tool: MirrorTool) => boolean,
  ): void {
    this.liveToolEnricher = enrich;
  }

  /**
   * 同一 key 換 transcript 時，current 與歷代 alias 必須在讀/發新文件前一起持久化。
   * 返回是否改變；呼叫方可據此決定是否同步 save。
   */
  private recordFileIdentity(key: string, localSid: string): boolean {
    const fileIds = (this.state.fileIds ??= {});
    const aliasesByKey = (this.state.fileIdAliases ??= {});
    const aliases = (aliasesByKey[key] ??= []);
    let changed = false;
    const previous = fileIds[key];
    if (previous && !aliases.includes(previous)) {
      aliases.push(previous);
      changed = true;
    }
    if (!aliases.includes(localSid)) {
      aliases.push(localSid);
      changed = true;
    }
    if (previous !== localSid) {
      fileIds[key] = localSid;
      changed = true;
    }
    return changed;
  }

  private persistIdentityStateOrThrow(context: string): void {
    if (!this.save()) {
      this.identityPersistenceDirty = true;
      throw new Error(`OpenClaw E2E mirror identity persistence failed (${context})`);
    }
    this.identityPersistenceDirty = false;
  }

  /**
   * import/announce 前的同步身份對賬：OpenClaw 可在 connector 停機時把同一 key 換成新 transcript。
   * 未完成（含 gateway/磁碟錯）時 localSessionE2EStatus 會全擋，不存在 crash-before-save 明文窗。
   */
  async reconcileIdentityPreflight(): Promise<void> {
    this.identityPreflightComplete = false;
    const list = await this.gw.sessionsList();
    let changed =
      this.identityPersistenceDirty ||
      (!this.aliasHistoryTrusted && this.canSafelyMigrateAliasHistory());
    for (const session of Array.isArray(list?.sessions) ? list.sessions : []) {
      if (typeof session?.key !== "string" || !session.key) continue;
      if (typeof session?.sessionId !== "string" || !session.sessionId) continue;
      changed = this.recordFileIdentity(session.key, session.sessionId) || changed;
    }
    if (changed) this.persistIdentityStateOrThrow("preflight");
    this.identityPreflightComplete = true;
  }

  /** key 或 transcript sessionId → 原始 wire sid（保留 ULID 大小寫）。 */
  wireSessionIdForLocalIdentity(identity: string): string | undefined {
    const direct = this.driveIdentityResolver?.(identity) ?? this.drivenSidByKey.get(identity);
    if (direct) return direct;
    const protectedByKey = new Map(
      this.protectedSessionIds().map((sid) => [keyForSid(sid), sid] as const),
    );
    const allKeys = new Set([
      ...Object.keys(this.state.fileIds ?? {}),
      ...Object.keys(this.state.fileIdAliases ?? {}),
    ]);
    for (const key of allKeys) {
      const aliases = this.state.fileIdAliases?.[key] ?? [];
      if (this.state.fileIds?.[key] !== identity && !aliases.includes(identity)) continue;
      return (
        protectedByKey.get(key.toLowerCase()) ??
        this.driveIdentityResolver?.(key) ??
        this.drivenSidByKey.get(key)
      );
    }
    return undefined;
  }

  private protectedSessionIds(): string[] {
    const fn = (this.e2e as (E2EKeyStore & { protectedSessionIds?: () => string[] }) | undefined)
      ?.protectedSessionIds;
    return typeof fn === "function" ? fn.call(this.e2e) : [];
  }

  private canSafelyMigrateAliasHistory(protectedIds = this.protectedSessionIds()): boolean {
    if (protectedIds.length > 0) return false;
    if (!this.e2e) return true;
    const fn = (this.e2e as E2EKeyStore & { hasServerStateSnapshot?: () => boolean })
      .hasServerStateSnapshot;
    return typeof fn === "function" && fn.call(this.e2e);
  }

  /**
   * mirror state 壞/缺時，local transcript UUID 無法再安全關聯任何 E2E wire sid。
   * allowMissingSids 只供 ready 快照中的 pending-enable bootstrap：server 會緊接著下發 backfill，
   * 由 gateway 權威 sessionId 補圖。它不豁免 state trust，且所有內容路徑仍使用無參 strict assert。
   */
  assertE2EIdentitySafe(allowMissingSids: ReadonlySet<string> = new Set()): void {
    if (this.identityPersistenceDirty) {
      throw new Error("OpenClaw E2E mirror identity persistence is dirty; refusing content");
    }
    const protectedIds = this.protectedSessionIds();
    if (!protectedIds.length) return;
    // agent:* 也不能豁免：current transcript 仍須能由 key 精確分類；pending-enable 是唯一暫缺窗口。
    const missingFileIds = protectedIds.filter(
      (sid) => !allowMissingSids.has(sid) && !(this.state.fileIds?.[keyForSid(sid)]),
    );
    if (
      !this.identityStateTrusted ||
      this.plaintextLocalAllowed?.() === false ||
      missingFileIds.length > 0
    ) {
      throw new Error(
        `OpenClaw E2E mirror identity state unavailable (trusted=${this.identityStateTrusted}, ` +
          `missing=${missingFileIds.slice(0, 3).join(",") || "unknown"}); ` +
          "refusing plaintext fallback",
      );
    }
  }

  /**
   * history import 以本地 transcript sessionId 枚舉，E2E store 則以 wire sid 持鑰。
   * fileIds 是已持久化的 key → transcript 映射；drivenSidByKey 保留 server sid 的原始大小寫。
   * 即使會話已從 gateway 活躍列表消失，歸檔 transcript 也不能被當成新的明文 shadow 導入。
   */
  localSessionE2EStatus(): { isE2E(localSid: string): boolean } {
    // 不可回傳 protection floor 的快照：runImport 會先 await gateway，期間 online enable 可提升
    // server floor。每次 filter 都重新分類，才能阻止舊 closure 把 archived alias 當明文 shadow。
    return { isE2E: (identity) => this.isLocalIdentityProtected(identity) };
  }

  private isLocalIdentityProtected(identity: string): boolean {
    const e2e = this.e2e;
    if (!e2e) return false;
    const protectedIds = this.protectedSessionIds();
    if (!protectedIds.length) return e2e.isE2E(identity);
    try {
      this.assertE2EIdentitySafe();
      if (
        protectedIds.length > 0 &&
        (!this.aliasHistoryTrusted || !this.identityPreflightComplete)
      ) {
        throw new Error("OpenClaw E2E alias history is incomplete");
      }
    } catch {
      return true;
    }
    const protectedByKey = new Map(
      protectedIds.map((sid) => [keyForSid(sid), sid] as const),
    );
    const protectedIdentities = new Set<string>();
    const knownIdentities = new Set<string>();
    const allKeys = new Set([
      ...Object.keys(this.state.fileIds ?? {}),
      ...Object.keys(this.state.fileIdAliases ?? {}),
    ]);
    for (const key of allKeys) {
      const protectedWireSid = protectedByKey.get(key.toLowerCase());
      const wireSid =
        protectedWireSid ??
        this.drivenSidByKey.get(key) ??
        (key.startsWith(MACCHIATO_PREFIX) ? sidForKey(key) : key);
      const target =
        protectedWireSid || e2e.isE2E(wireSid)
          ? protectedIdentities
          : knownIdentities;
      target.add(key);
      target.add(wireSid);
      if (protectedWireSid) target.add(protectedWireSid);
      for (const localSid of new Set([
        ...(this.state.fileIdAliases?.[key] ?? []),
        ...(this.state.fileIds?.[key] ? [this.state.fileIds[key]!] : []),
      ])) {
        target.add(localSid);
      }
    }
    if (protectedIdentities.has(identity) || e2e.isE2E(identity)) return true;
    if (knownIdentities.has(identity)) return false;
    // 任一 protected E2E 存在時，未被可信 registry 分類的 identity 默認 secret。
    return true;
  }

  /** 回合結束:打撈該 key 新寫入的 tool/thinking 塊(#147)。#348：有內容要發時 ACK 前不推水位。 */
  fastForward(key: string): void {
    if (this.isE2ETransitionLocked(key)) return;
    // 下一輪 poll 對 driven key 也會打撈;這裡主動立即跑一次, 縮小競態窗口。
    void this.salvageToEnd(key);
  }

  private async salvageToEnd(key: string): Promise<void> {
    // #252 Link B 未 ready 時整體跳過:不拉 sessionsList、不推水位線、不發——否則 salvage 已推
    // offset 但 mirror_append 被 client 丟(非 E2E 不緩衝),tool/thinking 永久缺失。
    // #348 後有內容走 durable outbox，未 ready 仍不得落盤/發。
    if (!this.linkb.isReady || this.isE2ETransitionLocked(key)) return;
    try {
      // pending-enable ready bootstrap 只准控制面補 fileId；映射補齊前所有 mirror 水位/明文都凍結。
      this.assertE2EIdentitySafe();
      const list = await this.gw.sessionsList();
      const s = (list?.sessions ?? []).find((x: any) => x.key === key);
      if (!s?.sessionId) return;
      const file = join(sessionsDir(), `${s.sessionId}.jsonl`);
      if (!existsSync(file)) return;
      const built = this.salvageDriven(key, file);
      if (built) this.sendOne(key, built.entry, built.endOffset);
      this.save();
    } catch {
      /* 下輪 poll 兜底 */
    }
  }

  /**
   * #147 打撈 driven key 的 tool/thinking:live 路徑只投文字(drive.ts chat final),.jsonl 裡的
   * toolCall/thinking 塊此前被快進永久跳過——記錄保真缺失。改為讀新字節,把**帶 tool/reasoning 的
   * agent 消息去掉正文**(正文 live 已投,防雙投)後補進歷史;純文字行照舊跳過。srcId 用原始內容
   * 指紋(重發冪等)。E2E driven 會話跳過(方案 A:內容走加密批,tools 打撈是獨立課題)——只推水位。
   * 基線:macchiato-native 新會話從 0(文件隨會話新建,首回合工具不丟);頻道續聊 key 首見基線到
   * 文件末(舊歷史已按完整消息鏡像過/或屬導入範疇,不重複)。
   * #348：有內容要發時**不**推 committed offsets（交給 durable outbox / ACK）；僅「無內容可發」
   * 的本地跳過（純文字 / E2E 明文不打撈）在無 pending 時可提交水位，防每輪空轉。
   */
  private salvageDriven(
    key: string,
    file: string,
  ): { entry: { hermesSessionId: string; source: string; messages: any[] }; endOffset: number } | null {
    if (this.isE2ETransitionLocked(key)) return null;
    const resolvedWireSid =
      this.driveIdentityResolver?.(key) ??
      this.drivenSidByKey.get(key);
    if (
      key.startsWith(MACCHIATO_PREFIX) &&
      !resolvedWireSid &&
      this.plaintextLocalAllowed?.() === false
    ) {
      console.error(`[mirror] E2E driven identity 不可信，凍結 ${key}，不推水位/不發明文`);
      return null;
    }
    const size = statSync(file).size;
    const off = this.state.offsets[key];
    if (off === undefined) {
      this.state.offsets[key] = key.startsWith(MACCHIATO_PREFIX) ? 0 : size;
      if (!key.startsWith(MACCHIATO_PREFIX)) return null;
    }
    const from = this.pendingOffset(key);
    if (size <= from) return null;
    const sid = resolvedWireSid ?? sidForKey(key);
    if (this.e2e?.isE2E(sid) || this.e2e?.isE2E(key)) {
      // E2E:加密批投遞,明文打撈不做。有 pending 時不得越过——e2e_direction 要回退重編。
      if (!this.hasPendingMirror(key)) this.state.offsets[key] = size;
      return null;
    }
    const { messages, newOffset } = readNewMessages(file, from);
    const salvaged = messages
      .filter((m) => m.role === "agent" && (m.reasoning || m.tools?.length))
      .map((m) => {
        // #432 #261 之後 live 已經實時投過工具卡了(只是內容單薄:gateway 的 result 無輸出正文)。
        // live 投過的 → 補發同 tool_id 的 tool.complete 帶真輸出,原地填空,**不再進 append 批**;
        // 沒投過的(老 gateway/live 漏收)照舊 append 保真。此前一律 append = 同批工具投兩次。
        const tools = (m.tools ?? []).filter((t) => !this.liveToolEnricher?.(sid, t));
        return {
          role: m.role,
          createdAt: m.createdAt,
          srcId: srcIdFor(m), // 指紋按原始內容算(重發冪等)
          text: "", // 正文 live 已投——只補 tool/thinking
          ...(m.reasoning ? { reasoning: m.reasoning } : {}),
          ...(tools.length ? { tools } : {}),
        };
      })
      // 工具全被 live 認領且無 reasoning → 整條沒內容可補,別發空殼消息
      .filter((m) => m.reasoning || (m as { tools?: MirrorTool[] }).tools?.length);
    if (!salvaged.length) {
      // 本地跳過（純文字 / 工具全被 live 認領）：無 pending 時可提交，否則等前序批 ACK。
      if (!this.hasPendingMirror(key)) this.state.offsets[key] = newOffset;
      return null;
    }
    return {
      entry: { hermesSessionId: sid, source: "openclaw", messages: salvaged },
      endOffset: newOffset,
    };
  }


  /** #308 MACCHIATO_MIRROR=off:停鏡像輪詢(終端側活動不進 app)。⚠️ 只停這一樣——
   * fastForward/墓碑/E2E backfill 是 driven 會話衛生,必須照常跑,多關 = 雙投回歸(#161)。
   * index.ts 的 #154 首裝自動導入也按此開關跳過(自動吸入終端歷史同屬鏡像語義)。 */
  readonly disabled = /^(off|0|false|no)$/i.test(process.env.MACCHIATO_MIRROR ?? "");

  constructor(
    private readonly gw: OpenClawGateway,
    private readonly linkb: LinkBClient,
    private readonly e2e?: E2EKeyStore,
  ) {
    const loaded = this.load();
    this.state = loaded.state;
    this.identityStateTrusted = loaded.identityStateTrusted;
    this.aliasHistoryTrusted =
      loaded.identityStateTrusted &&
      loaded.state.fileIdAliases !== undefined &&
      loaded.state.aliasHistoryTrusted === true;
  }

  start(): void {
    if (this.disabled) {
      // ⚠️ 回歸契約:scripts/localchain/scenarios-mirror-off.mjs 斷言此串,改文案需同步
      console.log("· Mirror disabled (MACCHIATO_MIRROR=off) — terminal sessions stay out of the app; app-driven sessions unaffected");
      return;
    }
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    console.log(`· Mirror started (poll ${POLL_MS / 1000}s, tailing ${sessionsDir()})`);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * mirror_nack。默認語義是「保留 durable 批、按同 batchId 重發」——但幀是在**發送時**凍結進
   * outbox 的，會話事後轉 E2E（或關 E2E）後,凍結的舊方向批被 server 的方向校驗**永遠**拒絕：
   * 水位永久凍結,且每 15 秒把開啟 E2E 前的明文正文重發一次給 server。故終態 code 必須丟批:
   *  - `e2e_direction`:丟掉**該 key 的全部**待確認批,水位停在最後一次 ACK → 下輪重讀重編。
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
    this.errorSticky = true;
    this.sentBatchAt.delete(String(batchId));
    if (code === "e2e_direction") {
      const key = target.key;
      const dropped = (this.state.pendingMirrors ?? []).filter((pending) => pending.key === key);
      for (const pending of dropped) this.sentBatchAt.delete(pending.batchId);
      this.state.pendingMirrors = (this.state.pendingMirrors ?? []).filter(
        (pending) => pending.key !== key,
      );
      this.counters.mirrorDirectionRewinds += 1;
      this.save(true);
      console.warn(
        `· mirror_nack(e2e_direction) ${key} → 丟棄 ${dropped.length} 個舊方向凍結批,回退到水位 ${this.state.offsets[key] ?? 0} 重讀重編`,
      );
      return;
    }
    if (code === "malformed") {
      this.state.offsets[target.key] = Math.max(
        this.state.offsets[target.key] ?? 0,
        target.endOffset,
      );
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

  /** server 事務提交後才推水位；同 key 亂序 ACK 只從隊首連續消費。 */
  handleAck(batchId: string | number): void {
    const pending = (this.state.pendingMirrors ?? []).find(
      (candidate) => candidate.batchId === String(batchId),
    );
    if (!pending) return;
    pending.acked = true;
    while (true) {
      const head = (this.state.pendingMirrors ?? []).find(
        (candidate) => candidate.key === pending.key,
      );
      if (!head?.acked) break;
      this.state.offsets[head.key] = Math.max(
        this.state.offsets[head.key] ?? 0,
        head.endOffset,
      );
      this.state.pendingMirrors = this.state.pendingMirrors!.filter(
        (candidate) => candidate.batchId !== head.batchId,
      );
      this.sentBatchAt.delete(head.batchId);
    }
    this.sentBatchAt.delete(String(batchId));
    this.errorSticky = false;
    this.save(true);
  }

  private hasPendingMirror(key: string): boolean {
    return (this.state.pendingMirrors ?? []).some((pending) => pending.key === key);
  }

  /** 已提交水位 + 未 ACK 批的 endOffset 高水位——讀取起點，防 ACK 前重複編批。 */
  private pendingOffset(key: string): number {
    let offset = this.state.offsets[key] ?? 0;
    for (const pending of this.state.pendingMirrors ?? []) {
      if (pending.key === key) offset = Math.max(offset, pending.endOffset);
    }
    return offset;
  }

  /** 單幀先 WAL 落盤；mirror_ack 才提交 offset。 */
  private sendOne(key: string, entry: Record<string, unknown>, endOffset: number): void {
    const batchId = randomUUID();
    const frame = {
      t: "mirror_append",
      agentLinkId: this.linkb.agentLinkId,
      sessions: [entry],
      batchId,
    };
    (this.state.pendingMirrors ??= []).push({ batchId, frame, key, endOffset });
    this.save(true);
    this.linkb.send(frame);
    this.sentBatchAt.set(batchId, Date.now());
    this.counters.mirrorBatches += 1; // #10
    this.counters.mirrorMessages += Array.isArray((entry as { messages?: unknown[] }).messages)
      ? (entry as { messages: unknown[] }).messages.length
      : 0;
  }

  handleE2EBackfillResult(
    sid: string,
    mode: "enable" | "disable",
    ok: boolean,
  ): void {
    const pendingKey = `${mode}:${sid}`;
    const pending = this.pendingE2EBackfills.get(pendingKey);
    this.pendingE2EBackfills.delete(pendingKey);
    if (!ok || !pending || pending.newOffset === undefined) return;
    this.state.offsets[pending.key] = Math.max(this.state.offsets[pending.key] ?? 0, pending.newOffset);
    this.save();
    console.log(`· E2E backfill ACK(${mode}): ${sid} (watermark → ${pending.newOffset})`);
  }

  private async poll(): Promise<void> {
    if (this.polling) return; // 防重入（上一輪未完不疊加）
    this.polling = true;
    try {
      await this.pollOnce();
      // 只有「本輪成功且沒有仍在重試的待確認錯誤」才清 lastError（#348 靜默凍結教訓）。
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

  /** 重啟輪詢（watchdog 自愈用）。 */
  restart(): void {
    this.stop();
    this.polling = false;
    this.start();
  }

  /**
   * §19 D2 / 關閉：把該會話 .jsonl 全量歷史以 `e2e_backfill` 回灌（server 事務內原地替換）。
   * mode="enable"（新開啟）：K_S 重加密回灌, 清 KEK 可解的舊明文 payload。
   * mode="disable"（關閉）：**明文**回灌（server 恢復可讀+投影）, server ACK 後才刪本地 K_S。
   * 找不到會話/無消息 → found:false：enable 時 server 不動內容；disable 時關閉失敗、K_S 保留。
   * 完成後把水位線推到快照末尾——回灌已含全歷史, 鏡像不得再按舊 offset 追加。
   * 借 polling 標誌與輪詢互斥（poll 對 polling=true 直接讓路）。
   */
  async backfillE2E(sid: string, mode: "enable" | "disable" = "enable"): Promise<void> {
    if (!this.e2e) return;
    while (this.polling) await new Promise((r) => setTimeout(r, 50));
    this.polling = true;
    const key = keyForSid(sid);
    // 先上 transition lock 再碰 gateway/filesystem；否则并发 fastForward 可在快照完成前推进 offset。
    this.pendingE2EBackfills.set(`${mode}:${sid}`, { key });
    try {
      let found: any;
      try {
        const list = await this.gw.sessionsList();
        found = (Array.isArray(list?.sessions) ? list.sessions : []).find((x: any) => x.key === key);
      } catch {
        found = undefined;
      }
      const file = found?.sessionId ? join(sessionsDir(), `${found.sessionId}.jsonl`) : null;
      const notFound = () => {
        this.linkb.send({
          t: "e2e_backfill",
          agentLinkId: this.linkb.agentLinkId,
          hermesSessionId: sid,
          mode,
          found: false,
        });
        console.warn(
          `· E2E backfill(${mode}): no transcript for ${sid} → found:false` +
          (mode === "disable" ? " (disable failed, K_S kept)" : " (server history NOT replaced)"),
        );
      };
      if (!file || !existsSync(file)) return notFound();
      // online enable 可能發生在 mirror 首次看見該 key 之前；backfill 已拿到權威 file identity，
      // 必須先持久綁定，否則 ACK 後立刻歸檔時 history import 只見 local UUID，會失去 E2E 關聯。
      if (this.recordFileIdentity(key, found.sessionId)) {
        // pending-enable 唯一允許的補圖窗口：protection floor 已抬高（import 全擋、poll 有 transition
        // lock），先把 gateway 給出的權威 file identity 落盤，再恢復嚴格 assert / 提交 backfill。
        this.persistIdentityStateOrThrow(`backfill ${sid}`);
      }
      this.assertE2EIdentitySafe();
      const { messages, newOffset } = readNewMessages(file, 0);
      if (!messages.length) return notFound();
      const session =
        mode === "enable"
          ? {
              hermesSessionId: sid,
              title: this.e2e.encryptText(sid, deriveTitle(found)),
              source: deriveSource(found),
              e2e: true,
              messages: messages.map((m) => ({
                role: m.role,
                createdAt: m.createdAt,
                srcId: srcIdFor(m),
                enc: this.e2e!.encryptContent(sid, {
                  text: m.text,
                  ...(m.reasoning ? { reasoning: m.reasoning } : {}),
                  ...(m.tools ? { tools: m.tools } : {}),
                }),
              })),
            }
          : {
              hermesSessionId: sid,
              title: deriveTitle(found),
              source: deriveSource(found),
              messages: messages.map((m) => ({ ...m, srcId: srcIdFor(m) })),
            };
      // 只有完整明文 snapshot 已成功构造后才签 completion receipt；先双快照持久化再发送。
      const disableReceipt =
        mode === "disable" ? this.e2e.disableReceiptForBackfill(sid) : undefined;
      this.linkb.send({
        t: "e2e_backfill",
        agentLinkId: this.linkb.agentLinkId,
        hermesSessionId: sid,
        mode,
        found: true,
        session,
        ...(disableReceipt ? { disableReceipt } : {}),
      });
      this.pendingE2EBackfills.set(`${mode}:${sid}`, { key, newOffset });
      console.log(`· E2E backfill submitted(${mode}): ${sid} — ${messages.length} message(s), waiting for server ACK`);
    } finally {
      this.polling = false;
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.linkb.isReady) return;
    // #348 待確認批超 15s 同 batchId 重放（斷線/ACK 丟失）；死在 ACK 前不靜默跳批。
    for (const pending of this.state.pendingMirrors ?? []) {
      if (Date.now() - (this.sentBatchAt.get(pending.batchId) ?? 0) >= 15_000) {
        this.linkb.send(pending.frame as any);
        this.sentBatchAt.set(pending.batchId, Date.now());
      }
    }
    // ready callback 可精確豁免 pending-enable 的「待補 fileId」，但內容面永遠 strict；
    // bootstrap control 尚未到或上次崩在補圖前時，不讀、不推水位、不發任何 mirror payload。
    this.assertE2EIdentitySafe();
    let list: any;
    try {
      list = await this.gw.sessionsList();
    } catch {
      return; // gateway 暫時不可達, 下輪再試
    }
    const sessions: any[] = Array.isArray(list?.sessions) ? list.sessions : [];
    this.prune(new Set(sessions.map((s: any) => s.key).filter(Boolean)));
    const dir = sessionsDir();
    for (const s of sessions) {
      const key: string | undefined = s.key;
      const sessionId: string | undefined = s.sessionId;
      if (!key || !sessionId || isCronSession(key)) continue; // cron 不鏡像（已在目標聊天裡）
      if (this.state.tombstones?.includes(key)) continue; // #161 app 刪過 → 永不再撈(含打撈)
      if (this.isE2ETransitionLocked(key)) continue; // #347 ACK 前不得由 poll/fastForward 旁路推进
      // #211 文件輪換偵測:同一 key 換了 sessionId(gateway 升級/會話重置)→ 舊字節水位線作廢,
      // 從 0 重讀新文件(srcId 指紋去重防重複)。否則 offset>size 永久靜默卡死(2026-07-14 實測)。
      const previousFileId = this.state.fileIds?.[key];
      if (previousFileId !== sessionId) {
        if (previousFileId !== undefined && this.state.offsets[key] !== undefined) {
          console.log(`· #211 ${key} 文件輪換(${previousFileId.slice(0, 8)}→${String(sessionId).slice(0, 8)}),水位線歸零重讀`);
          this.state.offsets[key] = 0;
          // 輪換後舊文件上的凍結批已無意義——丟棄，從新檔重編。
          const dropped = (this.state.pendingMirrors ?? []).filter((p) => p.key === key);
          for (const p of dropped) this.sentBatchAt.delete(p.batchId);
          this.state.pendingMirrors = (this.state.pendingMirrors ?? []).filter((p) => p.key !== key);
        }
      }
      // crash-before-save 不能留下「新 transcript 已讀/發、alias 尚未落盤」的證明窗口。
      // 即使 current 未變，也會補齊新 schema 中 current∈aliases 的不變量。
      if (this.recordFileIdentity(key, sessionId)) {
        this.persistIdentityStateOrThrow(`rotation ${key} → ${sessionId}`);
      }
      if (key.startsWith(MACCHIATO_PREFIX) || this.drivenKeys.has(key)) {
        // #147 drive 的會話:文字由 live 投遞;鏡像打撈 tool/thinking(去正文)補進歷史。
        // #348：有內容走 durable outbox，ACK 前不推 committed 水位。
        const f = join(dir, `${sessionId}.jsonl`);
        if (existsSync(f)) {
          const built = this.salvageDriven(key, f);
          if (built) this.sendOne(key, built.entry, built.endOffset);
        }
        continue;
      }
      const file = join(dir, `${sessionId}.jsonl`);
      if (!existsSync(file)) continue;
      const size = statSync(file).size;
      const off = this.state.offsets[key];
      if (off === undefined) {
        this.state.offsets[key] = size; // baseline：新會話只鏡像啟動後的消息
        continue;
      }
      const readFrom = this.pendingOffset(key);
      if (size < this.state.offsets[key]!) {
        // #211 兜底:文件比水位線短(被重寫/截短)→ 歸零重讀,srcId 去重兜住;別靜默卡死。
        console.log(`· #211 ${key} 文件縮短(size=${size} < off=${this.state.offsets[key]}),水位線歸零重讀`);
        this.state.offsets[key] = 0;
        const dropped = (this.state.pendingMirrors ?? []).filter((p) => p.key === key);
        for (const p of dropped) this.sentBatchAt.delete(p.batchId);
        this.state.pendingMirrors = (this.state.pendingMirrors ?? []).filter((p) => p.key !== key);
        continue; // 下輪從 0 讀(本輪 off 已失效)
      }
      if (size <= readFrom) continue;
      const { messages, newOffset } = readNewMessages(file, readFrom, BATCH_MAX); // #152
      if (!messages.length) {
        // hold-back / 半行：無消息但 newOffset 可能前進——無 pending 時可提交，否則等 ACK。
        if (!this.hasPendingMirror(key) && newOffset > (this.state.offsets[key] ?? 0)) {
          this.state.offsets[key] = newOffset;
        }
        continue;
      }
      const entry = this.e2e?.isE2E(key)
        ? {
            // §19：原生會話（如 Discord）被標 E2E → 標題+內容加密、打 e2e, server 盲存
            hermesSessionId: key,
            title: this.e2e.encryptText(key, deriveTitle(s)),
            source: deriveSource(s),
            e2e: true,
            messages: messages.map((mm) => ({
              role: mm.role,
              createdAt: mm.createdAt,
              srcId: srcIdFor(mm), // §9：內容指紋去重（明文算，加密前）
              // #61:全內容對象(text+reasoning+tools),與 Hermes E2E 形狀一致,client 已認識
              enc: this.e2e!.encryptContent(key, {
                text: mm.text,
                ...(mm.reasoning ? { reasoning: mm.reasoning } : {}),
                ...(mm.tools ? { tools: mm.tools } : {}),
              }),
            })),
          }
        : {
            hermesSessionId: key,
            title: deriveTitle(s),
            source: deriveSource(s),
            messages: messages.map((m) => ({ ...m, srcId: srcIdFor(m) })), // §9
          };
      // #152 單會話單幀 + #348 durable：ACK 前不推 offsets。
      this.sendOne(key, entry, newOffset);
    }
    this.save();
  }

  /** #9:offsets 無界增長治理——key 從 sessions.list 消失連續 PRUNE_MS 才裁(短暫缺席回歸即清)。
   * 安全性:被裁 key 若日後回歸,走「新會話 baseline-to-end」既有語義,不重發不誤丟。
   * #348：有 pending durable 批的 key 不裁——否則 ACK 前把待確認水位連同 outbox 一併抹掉 = 靜默跳批。 */
  private prune(liveKeys: Set<string>): void {
    const ma = (this.state.missingAt ??= {});
    const now = Date.now();
    let pruned = 0;
    for (const key of Object.keys(this.state.offsets)) {
      if (liveKeys.has(key) || this.hasPendingMirror(key)) {
        delete ma[key];
        continue;
      }
      const since = (ma[key] ??= now);
      if (now - since > PRUNE_MS) {
        delete this.state.offsets[key];
        delete ma[key];
        pruned += 1;
      }
    }
    for (const key of Object.keys(ma)) if (!(key in this.state.offsets)) delete ma[key];
    if (pruned) console.log(`· #9 裁剪 ${pruned} 個消失會話的水位線(剩 ${Object.keys(this.state.offsets).length})`);
  }

  private load(): { state: State; identityStateTrusted: boolean } {
    return loadStateFileWithTrust<State>(
      statePath(),
      (raw) => {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          throw new Error("mirror state root must be an object");
        }
        const record = (value: unknown, kind: "number" | "string"): Record<string, any> => {
          if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("mirror state map must be an object");
          }
          for (const [key, item] of Object.entries(value)) {
            if (
              !key ||
              (kind === "number"
                ? typeof item !== "number" || !Number.isFinite(item) || item < 0
                : typeof item !== "string" || !item)
            ) {
              throw new Error("mirror state map contains an invalid entry");
            }
          }
          return value as Record<string, any>;
        };
        if (!Array.isArray(raw.tombstones ?? []) || (raw.tombstones ?? []).some((v: unknown) => typeof v !== "string")) {
          throw new Error("mirror tombstones must be strings");
        }
        // fileIds 缺字段是舊格式，內容可恢復，但不能被當成完整 E2E identity 快照。
        if (raw.fileIds === undefined) throw new Error("mirror state lacks fileIds identity map");
        const fileIds = record(raw.fileIds, "string") as Record<string, string>;
        let fileIdAliases: Record<string, string[]> | undefined;
        if (raw.fileIdAliases !== undefined) {
          if (raw.fileIdAliases === null || typeof raw.fileIdAliases !== "object" || Array.isArray(raw.fileIdAliases)) {
            throw new Error("mirror fileIdAliases must be an object");
          }
          fileIdAliases = {};
          for (const [key, value] of Object.entries(raw.fileIdAliases)) {
            if (
              !key ||
              !Array.isArray(value) ||
              value.length === 0 ||
              value.some((item) => typeof item !== "string" || !item) ||
              new Set(value).size !== value.length
            ) {
              throw new Error("mirror fileIdAliases contains an invalid/non-unique entry");
            }
            fileIdAliases[key] = [...value];
          }
          for (const [key, current] of Object.entries(fileIds)) {
            if (!fileIdAliases[key]?.includes(current)) {
              throw new Error("mirror fileIdAliases must contain every current fileId");
            }
          }
        }
        if (
          raw.aliasHistoryTrusted !== undefined &&
          typeof raw.aliasHistoryTrusted !== "boolean"
        ) {
          throw new Error("mirror aliasHistoryTrusted must be boolean");
        }
        if (raw.aliasHistoryTrusted === true && fileIdAliases === undefined) {
          throw new Error("trusted alias history requires fileIdAliases");
        }
        const pendingMirrors: NonNullable<State["pendingMirrors"]> = [];
        if (raw.pendingMirrors !== undefined) {
          if (!Array.isArray(raw.pendingMirrors)) {
            throw new Error("mirror pendingMirrors must be an array");
          }
          for (const item of raw.pendingMirrors) {
            if (
              !item ||
              typeof item !== "object" ||
              typeof item.batchId !== "string" ||
              !item.batchId ||
              typeof item.key !== "string" ||
              !item.key ||
              typeof item.endOffset !== "number" ||
              !Number.isFinite(item.endOffset) ||
              item.endOffset < 0 ||
              !item.frame ||
              typeof item.frame !== "object" ||
              Array.isArray(item.frame)
            ) {
              throw new Error("mirror pendingMirrors contains an invalid entry");
            }
            pendingMirrors.push({
              batchId: item.batchId,
              frame: item.frame as Record<string, unknown>,
              key: item.key,
              endOffset: item.endOffset,
              ...(item.acked === true ? { acked: true } : {}),
            });
          }
        }
        return {
          offsets: record(raw.offsets ?? {}, "number"),
          missingAt: record(raw.missingAt ?? {}, "number"),
          tombstones: raw.tombstones ?? [],
          fileIds,
          ...(fileIdAliases ? { fileIdAliases } : {}),
          ...(raw.aliasHistoryTrusted !== undefined
            ? { aliasHistoryTrusted: raw.aliasHistoryTrusted }
            : {}),
          pendingMirrors,
        };
      },
      () => ({
        offsets: {},
        missingAt: {},
        fileIds: {},
        fileIdAliases: {},
        aliasHistoryTrusted: false,
        pendingMirrors: [],
      }),
    );
  }
  private lastSaved = "";
  /** force=true：即使內容未變也 fsync（ACK/NACK 路徑要確保落盤）。 */
  private save(force = false): boolean {
    try {
      const protectedIds = this.protectedSessionIds();
      const canMigrateAliases = this.canSafelyMigrateAliasHistory(protectedIds);
      if (canMigrateAliases && !this.aliasHistoryTrusted) {
        // 沒有任何 E2E 保護承諾時，舊 schema 可安全升級：至少把當前映射種進歷代 registry。
        // 有 protected sid 時絕不走此路，否則一次普通 poll 就會把已遺失的舊 alias 冒充完整。
        this.state.fileIdAliases = {};
        for (const [key, localSid] of Object.entries(this.state.fileIds ?? {})) {
          this.state.fileIdAliases[key] = [localSid];
        }
        this.state.aliasHistoryTrusted = true;
      } else if (!this.aliasHistoryTrusted) {
        // protected 下補出的 aliases 只能作正向安全分類，不能冒充「歷史完整」；重啟後仍須全擋 unknown。
        this.state.aliasHistoryTrusted = false;
      }
      // #262 dirty 判斷:與上次落盤相同 → 跳過(每輪 poll 無條件雙寫傷 SD 卡)。
      const json = JSON.stringify(this.state);
      if (!force && json === this.lastSaved) return true;
      // durable outbox 裝完整正文 → 0600 + fsync（對齊 CC/Codex #348）。
      const path = statePath();
      if (existsSync(path) && this.lastSaved) {
        try {
          durableWrite(`${path}.bak`, this.lastSaved);
        } catch {
          /* .bak 失敗不阻擋主檔 */
        }
      }
      durableWrite(path, json);
      this.lastSaved = json;
      // 壞/缺 identity 快照後，寫入一個只看見「當前 active 普通會話」的新檔不能證明已重建
      // 歸檔 E2E transcript 的 aliases；本進程保持 fail-closed，待人工恢復或無 E2E 時重建。
      if (canMigrateAliases) {
        this.identityStateTrusted = true;
        this.aliasHistoryTrusted = true;
      }
      return true;
    } catch {
      /* 持久化失敗不致命 */
      return false;
    }
  }
}
