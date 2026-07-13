/**
 * §15 鏡像：tail OpenClaw 的 .jsonl transcript → mirror_append 到 Macchiato。
 *  - 索引（標題/平台）來自 gateway `sessions.list`；消息來自各會話 `<sessionId>.jsonl`
 *    （穩定 append-only, 以**字節偏移**做水位線, 半行字節留到下輪）。
 *  - 新會話只鏡像「連接器啟動後」的消息（baseline = 當前文件末）, 避免全量回灌。
 *  - mirror_nack → 回退該批水位線下輪重發。
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LinkBClient } from "../linkb/client";
import type { OpenClawGateway } from "./gateway";
import type { E2EKeyStore } from "../e2e/keys";

const POLL_MS = Number(process.env.MACCHIATO_OPENCLAW_POLL_MS) || 5000;
const REWIND_KEEP = 32;
/** #9:水位線條目從 sessions.list 消失多久後裁掉(默認 7 天)。 */
const PRUNE_MS = Number(process.env.MACCHIATO_MIRROR_PRUNE_MS) || 7 * 24 * 3600 * 1000;

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
function srcIdFor(m: MirrorMessage): string {
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
}

export class Mirror {
  private state: State;
  private timer: ReturnType<typeof setInterval> | null = null;
  private batchId = 0;
  private readonly rewind: Array<{ id: number; prev: Record<string, number> }> = [];
  /** drive 驅動中的 key：live 路徑獨佔投遞文字;#147 鏡像只「打撈」tool/thinking(去正文),不發文字（防雙投）。 */
  private readonly drivenKeys = new Set<string>();
  /** #147 driven key → server sid(真大小寫;mirror_append 的 hermesSessionId 用它,sidForKey 會丟大小寫)。 */
  private readonly drivenSidByKey = new Map<string, string>();
  /** 健康：最近一次 poll 完成時刻（watchdog 用）。 */
  lastPollAt = Date.now();
  /** 健康：最近一次 poll 錯誤（成功清空）。 */
  lastError: string | null = null;
  /** #10:累計計數(進程生命週期),健康上報帶出。 */
  readonly counters: Record<string, number> = { mirrorBatches: 0, mirrorMessages: 0, mirrorNacks: 0, mirrorErrors: 0 };
  private polling = false;

  setDriven(key: string, sid?: string): void {
    this.drivenKeys.add(key);
    if (sid) this.drivenSidByKey.set(key, sid);
  }

  /** 回合結束:打撈該 key 新寫入的 tool/thinking 塊(#147)並推進水位線(文字 live 已投,不重發)。 */
  fastForward(key: string): void {
    // 下一輪 poll 對 driven key 也會打撈;這裡主動立即跑一次, 縮小競態窗口。
    void this.salvageToEnd(key);
  }

  private async salvageToEnd(key: string): Promise<void> {
    try {
      const list = await this.gw.sessionsList();
      const s = (list?.sessions ?? []).find((x: any) => x.key === key);
      if (!s?.sessionId) return;
      const file = join(sessionsDir(), `${s.sessionId}.jsonl`);
      if (!existsSync(file)) return;
      const prevOff = this.state.offsets[key];
      const entry = this.salvageDriven(key, file);
      if (entry) {
        this.batchId += 1;
        this.rewind.push({ id: this.batchId, prev: { [key]: prevOff ?? 0 } });
        if (this.rewind.length > REWIND_KEEP) this.rewind.shift();
        this.linkb.send({ t: "mirror_append", agentLinkId: this.linkb.agentLinkId, sessions: [entry], batchId: this.batchId });
        this.counters.mirrorBatches += 1;
        this.counters.mirrorMessages += entry.messages.length;
      }
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
   * 文件末(舊歷史已按完整消息鏡像過/或屬導入範疇,不重複)。返回 batch entry 或 null;推進水位線。
   */
  private salvageDriven(key: string, file: string): { hermesSessionId: string; source: string; messages: any[] } | null {
    const size = statSync(file).size;
    const off = this.state.offsets[key];
    if (off === undefined) {
      this.state.offsets[key] = key.startsWith(MACCHIATO_PREFIX) ? 0 : size;
      if (!key.startsWith(MACCHIATO_PREFIX)) return null;
    }
    const from = this.state.offsets[key] ?? 0;
    if (size <= from) return null;
    const sid = this.drivenSidByKey.get(key) ?? sidForKey(key);
    if (this.e2e?.isE2E(sid) || this.e2e?.isE2E(key)) {
      this.state.offsets[key] = size; // E2E:加密批投遞,明文打撈不做
      return null;
    }
    const { messages, newOffset } = readNewMessages(file, from);
    this.state.offsets[key] = newOffset;
    const salvaged = messages
      .filter((m) => m.role === "agent" && (m.reasoning || m.tools?.length))
      .map((m) => ({
        role: m.role,
        createdAt: m.createdAt,
        srcId: srcIdFor(m), // 指紋按原始內容算(重發冪等)
        text: "", // 正文 live 已投——只補 tool/thinking
        ...(m.reasoning ? { reasoning: m.reasoning } : {}),
        ...(m.tools ? { tools: m.tools } : {}),
      }));
    if (!salvaged.length) return null;
    return { hermesSessionId: sid, source: "openclaw", messages: salvaged };
  }


  constructor(
    private readonly gw: OpenClawGateway,
    private readonly linkb: LinkBClient,
    private readonly e2e?: E2EKeyStore,
  ) {
    this.state = this.load();
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    console.log(`· Mirror started (poll ${POLL_MS / 1000}s, tailing ${sessionsDir()})`);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** server 回 mirror_nack → 回退這批會話的水位線, 下輪重發。 */
  handleNack(batchId: number): void {
    const e = this.rewind.find((r) => r.id === batchId);
    if (!e) return;
    this.counters.mirrorNacks += 1; // #10
    for (const [k, off] of Object.entries(e.prev)) this.state.offsets[k] = off;
    this.save();
    console.warn(`· mirror_nack batch ${batchId} → rewinding watermark for resend`);
  }

  private async poll(): Promise<void> {
    if (this.polling) return; // 防重入（上一輪未完不疊加）
    this.polling = true;
    try {
      await this.pollOnce();
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

  /** 重啟輪詢（watchdog 自愈用）。 */
  restart(): void {
    this.stop();
    this.polling = false;
    this.start();
  }

  /**
   * §19 D2 / 關閉：把該會話 .jsonl 全量歷史以 `e2e_backfill` 回灌（server 事務內原地替換）。
   * mode="enable"（新開啟）：K_S 重加密回灌, 清 KEK 可解的舊明文 payload。
   * mode="disable"（關閉）：**明文**回灌（server 恢復可讀+投影）, 成功後刪本地 K_S。
   * 找不到會話/無消息 → found:false：enable 時 server 不動內容；disable 時關閉失敗、K_S 保留。
   * 完成後把水位線推到快照末尾——回灌已含全歷史, 鏡像不得再按舊 offset 追加。
   * 借 polling 標誌與輪詢互斥（poll 對 polling=true 直接讓路）。
   */
  async backfillE2E(sid: string, mode: "enable" | "disable" = "enable"): Promise<void> {
    if (!this.e2e) return;
    while (this.polling) await new Promise((r) => setTimeout(r, 50));
    this.polling = true;
    try {
      const key = keyForSid(sid);
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
          t: "e2e_backfill", agentLinkId: this.linkb.agentLinkId, hermesSessionId: sid, mode, found: false,
        });
        console.warn(
          `· E2E backfill(${mode}): no transcript for ${sid} → found:false` +
          (mode === "disable" ? " (disable failed, K_S kept)" : " (server history NOT replaced)"),
        );
      };
      if (!file || !existsSync(file)) return notFound();
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
              messages,
            };
      this.linkb.send({
        t: "e2e_backfill",
        agentLinkId: this.linkb.agentLinkId,
        hermesSessionId: sid,
        mode,
        found: true,
        session,
      });
      this.state.offsets[key] = Math.max(this.state.offsets[key] ?? 0, newOffset);
      this.save();
      if (mode === "disable") this.e2e.remove(sid); // 關閉完成：刪 K_S, live/mirror 回明文路徑
      console.log(`· E2E backfill(${mode}): ${sid} — ${messages.length} message(s) (watermark → ${newOffset})`);
    } finally {
      this.polling = false;
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.linkb.isReady) return;
    let list: any;
    try {
      list = await this.gw.sessionsList();
    } catch {
      return; // gateway 暫時不可達, 下輪再試
    }
    const sessions: any[] = Array.isArray(list?.sessions) ? list.sessions : [];
    this.prune(new Set(sessions.map((s: any) => s.key).filter(Boolean)));
    const dir = sessionsDir();
    const batch: any[] = [];
    const batchKeys: string[] = []; // #152 平行數組:每條 entry 的水位線鍵(salvage 條目 hermesSessionId≠key)
    const prev: Record<string, number> = {};
    for (const s of sessions) {
      const key: string | undefined = s.key;
      const sessionId: string | undefined = s.sessionId;
      if (!key || !sessionId || isCronSession(key)) continue; // cron 不鏡像（已在目標聊天裡）
      if (key.startsWith(MACCHIATO_PREFIX) || this.drivenKeys.has(key)) {
        // #147 drive 的會話:文字由 live 投遞;鏡像打撈 tool/thinking(去正文)補進歷史,推進水位線。
        const f = join(dir, `${sessionId}.jsonl`);
        if (existsSync(f)) {
          const prevOff = this.state.offsets[key];
          const entry = this.salvageDriven(key, f);
          if (entry) {
            prev[key] = prevOff ?? 0;
            batch.push(entry);
            batchKeys.push(key);
          }
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
      if (size <= off) continue;
      const { messages, newOffset } = readNewMessages(file, off, BATCH_MAX); // #152
      if (messages.length) {
        prev[key] = off;
        if (this.e2e?.isE2E(key)) {
          // §19：原生會話（如 Discord）被標 E2E → 標題+內容加密、打 e2e, server 盲存
          batch.push({
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
          });
          batchKeys.push(key);
        } else {
          batch.push({
            hermesSessionId: key,
            title: deriveTitle(s),
            source: deriveSource(s),
            messages: messages.map((m) => ({ ...m, srcId: srcIdFor(m) })), // §9
          });
          batchKeys.push(key);
        }
      }
      this.state.offsets[key] = newOffset;
    }
    // #152 單會話單幀(對齊 CC):每幀 ≤BATCH_MAX 條消息,rewind 也細化到單會話——nack 只回退撞壞的那條。
    for (let bi = 0; bi < batch.length; bi++) {
      const entry = batch[bi];
      this.batchId += 1;
      const k = batchKeys[bi]!; // 水位線鍵(≠ entry.hermesSessionId,salvage 條目用真大小寫 sid)
      this.rewind.push({ id: this.batchId, prev: k in prev ? { [k]: prev[k]! } : {} });
      if (this.rewind.length > REWIND_KEEP) this.rewind.shift();
      this.linkb.send({
        t: "mirror_append",
        agentLinkId: this.linkb.agentLinkId,
        sessions: [entry],
        batchId: this.batchId,
      });
      this.counters.mirrorBatches += 1; // #10
      this.counters.mirrorMessages += entry.messages?.length ?? 0;
    }
    this.save();
  }

  /** #9:offsets 無界增長治理——key 從 sessions.list 消失連續 PRUNE_MS 才裁(短暫缺席回歸即清)。
   * 安全性:被裁 key 若日後回歸,走「新會話 baseline-to-end」既有語義,不重發不誤丟。 */
  private prune(liveKeys: Set<string>): void {
    const ma = (this.state.missingAt ??= {});
    const now = Date.now();
    let pruned = 0;
    for (const key of Object.keys(this.state.offsets)) {
      if (liveKeys.has(key)) {
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

  private load(): State {
    return loadStateFile(
      statePath(),
      (raw) => ({ offsets: raw.offsets ?? {}, missingAt: raw.missingAt ?? {} }),
      () => ({ offsets: {}, missingAt: {} }),
    );
  }
  private save(): void {
    try {
      saveStateFile(statePath(), this.state);
    } catch {
      /* 持久化失敗不致命 */
    }
  }
}
