/**
 * Claude Code transcript（~/.claude/projects/<cwd-slug>/<sessionId>.jsonl）解析。
 * 純函數層：發現會話文件、按字節水位線讀新行、把行折疊成 Macchiato 消息。
 *
 * 行形狀（2026-07-05 對 CLI 2.1.201 的本機真實 transcript 實證；官方標注「內部格式」，
 * 故全程防禦性解析——認不出的行/塊一律跳過，絕不拋）：
 *  - user：message.content = 字符串 或 [{type:"text"|"image"|"tool_result",...}]；
 *    isMeta=true / isSidechain=true / 命令包裝（<command-name>… / Caveat:）不是真人消息。
 *    isCompactSummary=true = compact 後注入的續接摘要 → 折成 system 消息（客戶端折疊展示）。
 *    tool_result 行回填到對應 tool_use（content[0].tool_use_id）。
 *  - assistant：同一條 API 消息拆多行（每行一個 content 塊：thinking / text / tool_use），
 *    以 message.id 分組折疊成一條 agent 消息。stop_reason:"tool_use" 且結果未到 = in-flight。
 *  - custom-title：{customTitle, sessionId}，最後一條為準（用戶/AI 改名都寫這裡）。
 *  - 其它（file-history-snapshot / mode / summary…）跳過。
 * 每行頂層 uuid 穩定唯一 → 折疊消息的 srcId 取組內首行 uuid（§9 鏡像去重）。
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function projectsDir(): string {
  const cfg = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(cfg, "projects");
}

export interface CCTool {
  callId: string;
  name: string;
  args?: Record<string, unknown>;
  resultText?: string;
}

export interface CCMessage {
  role: "user" | "agent" | "system";
  text: string;
  reasoning?: string;
  tools?: CCTool[];
  createdAt?: number; // epoch ms
  srcId: string; // 組內首行 uuid（§9 去重）
  /** #318 assistant 組的 API message.id(= SDK 事件的 message.id;live×mirror 去重共同身份)。
   * user/system 消息無此 id。 */
  msgId?: string;
}

/** 一次增量讀出的「行 + 它的起始字節偏移」。 */
interface Entry {
  obj: Record<string, any>;
  startByte: number;
}

/** 從 offset 起按整行讀（半行留下輪）。壞 JSON 行跳過但佔偏移。 */
export function readEntries(file: string, offset: number): { entries: Entry[]; endOffset: number } {
  const size = statSync(file).size;
  if (size <= offset) return { entries: [], endOffset: offset };
  const buf = Buffer.allocUnsafe(size - offset);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { entries: [], endOffset: offset };
  const entries: Entry[] = [];
  let pos = 0;
  const chunk = buf.subarray(0, lastNl + 1);
  while (pos < chunk.length) {
    let nl = chunk.indexOf(0x0a, pos);
    if (nl < 0) nl = chunk.length;
    const lineBuf = chunk.subarray(pos, nl);
    const startByte = offset + pos;
    pos = nl + 1;
    const s = lineBuf.toString("utf8").trim();
    if (!s) continue;
    try {
      entries.push({ obj: JSON.parse(s), startByte });
    } catch {
      /* 壞行跳過（水位線照常推進） */
    }
  }
  return { entries, endOffset: offset + lastNl + 1 };
}

/** 命令包裝 / 系統注入的 user 行——不是真人說話。 */
const NON_HUMAN_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<local-command-stdout>",
  "<local-command-caveat>",
  "<system-reminder>",
  "<task-notification>",
  "Caveat: The messages below",
  "[Request interrupted",
];

function isHumanUserText(t: string): boolean {
  const s = t.trim();
  if (!s) return false;
  return !NON_HUMAN_PREFIXES.some((p) => s.startsWith(p));
}

function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("");
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  return textBlocks(content);
}

/** in-flight 停滯強制結算閾值（agent 死於工具調用中途 → 別讓該會話鏡像永久卡死）。 */
const STALE_TURN_MS = Number(process.env.MACCHIATO_CC_STALE_TURN_MS) || 30 * 60_000;

export interface FoldResult {
  messages: CCMessage[];
  /** 水位線可安全推進到的字節（尾部 in-flight assistant 組不消費，下輪自愈）。 */
  consumedUpTo: number;
  /** 流中出現的最新 custom-title（無則 undefined）。 */
  title?: string;
}

/**
 * 把一批行折疊成 Macchiato 消息。
 * endOffset = readEntries 的返回（全消費時的水位線）。
 */
export function foldEntries(
  entries: Entry[],
  endOffset: number,
  now = Date.now(),
  maxMessages = Number.POSITIVE_INFINITY,
): FoldResult {
  const messages: CCMessage[] = [];
  let title: string | undefined;

  // assistant 組（連續行按 message.id 聚合）
  interface Group {
    id: string;
    srcId: string;
    startByte: number;
    text: string;
    reasoning: string;
    tools: CCTool[];
    ts?: number;
    /** 尚未收到 tool_result 的 tool_use id 集合。 */
    awaiting: Set<string>;
  }
  let group: Group | null = null;
  const toolIndex = new Map<string, CCTool>(); // tool_use id → CCTool（結果回填）

  const flush = (): void => {
    if (!group) return;
    const g = group;
    group = null;
    if (!g.text.trim() && !g.reasoning.trim() && g.tools.length === 0) return;
    const m: CCMessage = { role: "agent", text: g.text, srcId: g.srcId };
    if (g.id) m.msgId = g.id; // #318 API message.id(live×mirror 去重)
    if (g.reasoning.trim()) m.reasoning = g.reasoning;
    if (g.tools.length) m.tools = g.tools;
    if (g.ts) m.createdAt = g.ts;
    messages.push(m);
  };

  for (const { obj: d, startByte } of entries) {
    const t = d.type;
    if (t === "custom-title") {
      if (typeof d.customTitle === "string" && d.customTitle.trim()) title = d.customTitle.trim();
      continue;
    }
    if (d.isSidechain) continue; // 子 agent 內部流，不入鏡像
    const msg = d.message ?? {};

    if (t === "user") {
      const content = msg.content;
      // tool_result 行：回填工具結果（歸屬之前的 assistant 組/已 flush 的工具）
      if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) {
        for (const b of content) {
          if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
          const tool = toolIndex.get(b.tool_use_id);
          if (tool) tool.resultText = toolResultText(b.content).slice(0, 20_000);
          group?.awaiting.delete(b.tool_use_id);
        }
        continue;
      }
      // 真人消息 → 先 flush 掛起的 assistant 組
      if (d.isMeta) continue;
      const text = textBlocks(content);
      // compact 續接摘要：CC 壓縮上下文後注入的 user 行（isCompactSummary），非真人說話 →
      // 鏡像成 system 行（客戶端折疊展示，不落用戶氣泡、不參與標題 fallback）。
      if (d.isCompactSummary) {
        if (!text.trim()) continue;
        flush();
        if (messages.length >= maxMessages) return { messages, consumedUpTo: startByte, title };
        messages.push({
          role: "system",
          text: text.trim(),
          srcId: String(d.uuid ?? `u-${startByte}`),
          ...(d.timestamp ? { createdAt: Date.parse(d.timestamp) } : {}),
        });
        continue;
      }
      if (!isHumanUserText(text)) continue;
      flush();
      // 分批：達單批上限，在此消息邊界截斷（consumedUpTo=本行起始，下批從這裡續）
      if (messages.length >= maxMessages) return { messages, consumedUpTo: startByte, title };
      messages.push({
        role: "user",
        text: text.trim(),
        srcId: String(d.uuid ?? `u-${startByte}`),
        ...(d.timestamp ? { createdAt: Date.parse(d.timestamp) } : {}),
      });
      continue;
    }

    if (t === "assistant") {
      const mid = String(msg.id ?? d.requestId ?? d.uuid ?? "");
      if (!group || group.id !== mid) {
        flush();
        // 分批：達單批上限，在此消息邊界截斷（下批從本 assistant 組起始續）
        if (messages.length >= maxMessages) return { messages, consumedUpTo: startByte, title };
        group = {
          id: mid,
          srcId: String(d.uuid ?? `a-${startByte}`),
          startByte,
          text: "",
          reasoning: "",
          tools: [],
          ts: d.timestamp ? Date.parse(d.timestamp) : undefined,
          awaiting: new Set(),
        };
      }
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && typeof b.text === "string") group.text += b.text;
        else if (b.type === "thinking" && typeof b.thinking === "string") group.reasoning += b.thinking;
        else if (b.type === "tool_use" && typeof b.id === "string") {
          const tool: CCTool = { callId: b.id, name: String(b.name ?? "tool"), args: b.input ?? undefined };
          group.tools.push(tool);
          toolIndex.set(b.id, tool);
          group.awaiting.add(b.id);
        }
        // 其它塊類型（fallback / image …）跳過
      }
      continue;
    }
    // 其它行類型跳過
  }

  // 尾部 in-flight：最後的 assistant 組還有工具沒結果 → 不消費（除非停滯超閾值強制結算）
  if (group !== null) {
    const g: Group = group;
    if (g.awaiting.size > 0) {
      const stale = g.ts !== undefined && now - g.ts > STALE_TURN_MS;
      if (!stale) return { messages, consumedUpTo: g.startByte, title };
    }
    flush();
  }
  return { messages, consumedUpTo: endOffset, title };
}

/** 首段掃標題：文件頭 64KB 內第一條真人 user 消息（新會話 baseline 時用；custom-title 後續增量流會帶到）。 */
export function scanInitialTitle(file: string): string | undefined {
  try {
    const fd = openSync(file, "r");
    const buf = Buffer.allocUnsafe(Math.min(statSync(file).size, 64 * 1024));
    try {
      readSync(fd, buf, 0, buf.length, 0);
    } finally {
      closeSync(fd);
    }
    let title: string | undefined;
    for (const line of buf.toString("utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let d: any;
      try {
        d = JSON.parse(s);
      } catch {
        continue;
      }
      if (d.type === "custom-title" && typeof d.customTitle === "string") return d.customTitle.trim();
      if (!title && d.type === "user" && !d.isMeta && !d.isSidechain && !d.isCompactSummary) {
        const text = textBlocks(d.message?.content).trim();
        if (isHumanUserText(text)) title = text.slice(0, 60);
      }
    }
    return title;
  } catch {
    return undefined;
  }
}
