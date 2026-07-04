/**
 * §15 鏡像：tail OpenClaw 的 .jsonl transcript → mirror_append 到 Macchiato。
 *  - 索引（標題/平台）來自 gateway `sessions.list`；消息來自各會話 `<sessionId>.jsonl`
 *    （穩定 append-only, 以**字節偏移**做水位線, 半行字節留到下輪）。
 *  - 新會話只鏡像「連接器啟動後」的消息（baseline = 當前文件末）, 避免全量回灌。
 *  - mirror_nack → 回退該批水位線下輪重發。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LinkBClient } from "../linkb/client";
import type { OpenClawGateway } from "./gateway";
import type { E2EKeyStore } from "../e2e/keys";

const POLL_MS = Number(process.env.MACCHIATO_OPENCLAW_POLL_MS) || 5000;
const REWIND_KEEP = 32;

/** Macchiato 新建會話的 key 前綴（drive 專屬、無渠道綁定）—— 純 live 路徑, 鏡像永久跳過。 */
export const MACCHIATO_PREFIX = "agent:main:macchiato:";

function statePath(): string {
  return process.env.MACCHIATO_OPENCLAW_MIRROR || join(homedir(), ".macchiato/openclaw-mirror.json");
}
function sessionsDir(): string {
  return join(process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw"), "agents/main/sessions");
}

export interface MirrorMessage {
  role: "user" | "agent";
  text: string;
  createdAt?: number;
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

/** 一行 .jsonl → ImportMessage；只取 user/assistant 的 text（toolResult/系統行跳過）。user 文本去 wrapper。 */
export function lineToMessage(o: any): MirrorMessage | null {
  if (!o || o.type !== "message" || !o.message) return null;
  const m = o.message;
  const role = m.role === "user" ? "user" : m.role === "assistant" ? "agent" : null;
  if (!role) return null;
  const raw = (Array.isArray(m.content) ? m.content : [])
    .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("");
  const text = role === "user" ? cleanUserText(raw) : raw;
  if (!text.trim()) return null;
  return { role, text, createdAt: typeof m.timestamp === "number" ? m.timestamp : o.timestamp };
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

/** 從 offset 起讀新內容, 按整行解析（剩半行留到下次）。返回消息 + 新 offset。 */
export function readNewMessages(file: string, offset: number): { messages: MirrorMessage[]; newOffset: number } {
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
  const messages: MirrorMessage[] = [];
  for (const line of buf.subarray(0, lastNl).toString("utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const msg = lineToMessage(JSON.parse(s));
      if (msg) messages.push(msg);
    } catch {
      /* 壞行跳過 */
    }
  }
  return { messages, newOffset: offset + lastNl + 1 };
}

interface State {
  offsets: Record<string, number>;
}

export class Mirror {
  private state: State;
  private timer: ReturnType<typeof setInterval> | null = null;
  private batchId = 0;
  private readonly rewind: Array<{ id: number; prev: Record<string, number> }> = [];
  /** drive 驅動中的 key：live 路徑獨佔投遞, 鏡像只快進水位線、不發（防雙投, Hermes 的教訓）。 */
  private readonly drivenKeys = new Set<string>();
  /** 健康：最近一次 poll 完成時刻（watchdog 用）。 */
  lastPollAt = Date.now();
  /** 健康：最近一次 poll 錯誤（成功清空）。 */
  lastError: string | null = null;
  private polling = false;

  setDriven(key: string): void {
    this.drivenKeys.add(key);
  }

  /** 回合結束後把該 key 的水位線快進到文件末（live 已投遞的內容不再鏡像）。 */
  fastForward(key: string): void {
    // 下一輪 poll 對 driven key 本就會快進；這裡主動立即快進一次, 縮小競態窗口。
    void this.advanceToEnd(key);
  }

  private async advanceToEnd(key: string): Promise<void> {
    try {
      const list = await this.gw.sessionsList();
      const s = (list?.sessions ?? []).find((x: any) => x.key === key);
      if (!s?.sessionId) return;
      const file = join(sessionsDir(), `${s.sessionId}.jsonl`);
      if (!existsSync(file)) return;
      this.state.offsets[key] = statSync(file).size;
      this.save();
    } catch {
      /* 下輪 poll 兜底 */
    }
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

  private async pollOnce(): Promise<void> {
    if (!this.linkb.isReady) return;
    let list: any;
    try {
      list = await this.gw.sessionsList();
    } catch {
      return; // gateway 暫時不可達, 下輪再試
    }
    const sessions: any[] = Array.isArray(list?.sessions) ? list.sessions : [];
    const dir = sessionsDir();
    const batch: any[] = [];
    const prev: Record<string, number> = {};
    for (const s of sessions) {
      const key: string | undefined = s.key;
      const sessionId: string | undefined = s.sessionId;
      if (!key || !sessionId || isCronSession(key)) continue; // cron 不鏡像（已在目標聊天裡）
      if (key.startsWith(MACCHIATO_PREFIX) || this.drivenKeys.has(key)) {
        // drive 的會話：live 路徑已投遞 → 只快進水位線、不發（防雙投）
        const f = join(dir, `${sessionId}.jsonl`);
        if (existsSync(f)) this.state.offsets[key] = statSync(f).size;
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
      const { messages, newOffset } = readNewMessages(file, off);
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
              enc: this.e2e!.encryptContent(key, { text: mm.text }),
            })),
          });
        } else {
          batch.push({
            hermesSessionId: key,
            title: deriveTitle(s),
            source: deriveSource(s),
            messages,
          });
        }
      }
      this.state.offsets[key] = newOffset;
    }
    if (batch.length) {
      this.batchId += 1;
      this.rewind.push({ id: this.batchId, prev });
      if (this.rewind.length > REWIND_KEEP) this.rewind.shift();
      this.linkb.send({
        t: "mirror_append",
        agentLinkId: this.linkb.agentLinkId,
        sessions: batch,
        batchId: this.batchId,
      });
    }
    this.save();
  }

  private load(): State {
    try {
      return JSON.parse(readFileSync(statePath(), "utf8")) as State;
    } catch {
      return { offsets: {} };
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
