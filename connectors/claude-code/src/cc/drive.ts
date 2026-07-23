/**
 * Drive：Macchiato → Claude Code 的雙向橋（經官方 Agent SDK）。
 *
 * #118 起為 streaming-input 架構：每個活躍會話一條**長活通道**（`query({prompt: PushStream})`），
 * 後續 prompt 直接 push（不再每回合新起 query/CLI 進程）。要點（全部有 #116 探針背書）：
 *   - 閒置回收：回合結束後 MACCHIATO_CC_IDLE_S（默認 600s）無活動 → close() 回收 CLI（~257MB RSS/會話）；
 *     下個 prompt 用 resume 重建，上下文零丟失。
 *   - 送達確認：push 後 CLI 未及處理即死（毫秒級窗口）→ 自動重投一次（新通道 resume）；
 *     已見事件的回合崩潰 → 定稿 error（user 消息已落 transcript，不重投防雙投）。
 *   - interrupt() 不殺通道（探針 g）：result(error_during_execution) 到、同通道下一回合照常。
 *   - 每回合一個 system/init（streaming 模式特性），據此 setDriven/存映射。
 *
 * 下行（server → 連接器, t:"tui" 幀）：
 *   prompt.submit     → 通道 push 一回合；回合進行中 → steer(#75:打斷當前回合+新消息接管)
 *   session.interrupt → channel.q.interrupt()
 *   session.create    → 登記（首次 prompt 才真建 CC 會話, init 事件回 session_id）；cwd 變更 → 閒置通道重建
 *   approval.respond  → 解掛 canUseTool（request_id 精準配對,缺省 FIFO）
 * 上行（SDK 流式事件 → server tui EVENT）：
 *   stream_event content_block_delta text_delta     → message.delta（token 級）
 *   stream_event content_block_delta thinking_delta  → reasoning.delta
 *   stream_event content_block_start tool_use        → tool.start
 *   user 消息裡的 tool_result                         → tool.complete
 *   result                                            → message.complete{status,usage} + 鏡像快進（防雙投）
 *   canUseTool 回調                                   → approval.request{request_id}（掛起直到用戶批/拒）
 *   system compact_boundary/status/api_retry/permission_denied → review.summary 系統行（#102）
 *   其餘 SDKMessage（37 種 union 的長尾）              → 一次性 debug log（#102 兜底,防升級漂移無感知）
 *
 * 會話映射：鏡像來的 sid 本身就是 CC session uuid → 直接 resume；Macchiato 新建會話（ULID sid）
 * 首回合 init 拿到 CC session_id 後持久映射（~/.macchiato/claude-code-sessions.json，原子寫）——
 * 沒有這個映射，重啟後續聊就找不回上下文（Hermes stored_session_id 的同款教訓）。
 */
import {
  query,
  renameSession,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { imageBlockFor, materializeAttachment } from "./attachments";
import { claudeBinIsAbsolute, resolveClaudeBin } from "./claude-bin";
import type { CommandsReporter } from "./commands";
import { generateTitle } from "./titles";
import type { LinkBClient } from "../linkb/client";
import type { E2EKeyStore } from "../e2e/keys";
import {
  canonicalE2EApprovalDisplay,
  dispatchForE2EControl,
  e2eApprovalRequestDigest,
  E2EControlError,
  E2EControlVerifier,
  immutableE2EApprovalSnapshot,
  type E2EControlEnvelopeV1,
  type E2EControlKind,
} from "../e2e/control";
import { discoverSessions, type Mirror } from "./mirror";
import { foldEntries, readEntries } from "./transcripts";

const CC_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 必须与 iOS E2EControlCrypto.maxPayloadBytes 一致；设备会拒绝更大的解密 JSON。 */
const E2E_APPROVAL_PLAINTEXT_MAX_BYTES = 64 * 1024;

function sameLocalUUID(a: string, b: string): boolean {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  return CC_UUID_RE.test(lowerA) && CC_UUID_RE.test(lowerB) && lowerA === lowerB;
}

const AUTHENTICATED_E2E_CONTROL = Symbol("authenticated-e2e-control");
interface AuthenticatedControlTag {
  kind: E2EControlKind;
  msgId: string;
  envelope: E2EControlEnvelopeV1;
}
type TaggedControlFrame = Record<string, unknown> & {
  [AUTHENTICATED_E2E_CONTROL]?: AuthenticatedControlTag;
};
const E2E_SENSITIVE_METHODS = new Set([
  "command.invoke",
  "approval.respond",
  "clarify.respond",
  "secret.respond",
  "session.create",
  "session.interrupt",
  "task.stop",
  "session.e2e.disable",
  "session.delete",
  "session.rename",
  "session.archive",
  "session.retitle",
]);

function mapPath(): string {
  return process.env.MACCHIATO_CC_SESSIONS || join(homedir(), ".macchiato/claude-code-sessions.json");
}

interface PersistedDriveState {
  map: Record<string, string>;
  /** wire sid → 歷來由該會話產生過的所有 CC transcript uuid（含 map 的當前值）。 */
  aliases: Record<string, string[]>;
  cwds: Record<string, string>;
  permModes: Record<string, string>;
  models: Record<string, string>;
  efforts: Record<string, string>;
  pending: string[];
  identityStateTrusted: boolean;
  /**
   * aliases 是否能證明涵蓋所有歷史 fork。舊 schema 即使能從 current map 補一項，
   * 也無法證明過去沒有別的 uuid，故與 current-map trust 分開。
   */
  aliasHistoryTrusted: boolean;
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || typeof item !== "string") throw new Error(`${field} contains an invalid entry`);
    out[key] = item;
  }
  return out;
}

function stringArrayRecord(value: unknown, field: string): Record<string, string[]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const out: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      !key ||
      !Array.isArray(item) ||
      item.some((entry) => typeof entry !== "string" || !entry)
    ) {
      throw new Error(`${field} contains an invalid entry`);
    }
    const localSids = item as string[];
    if (new Set(localSids).size !== localSids.length) {
      throw new Error(`${field} contains duplicate local session ids`);
    }
    out[key] = [...localSids];
  }
  return out;
}

/**
 * v2 舊檔沒有 aliases；把 current map 補進已知 alias 只為維持 live/reverse lookup。
 * 這不代表歷史完整——是否可放行 import/未知 mirror 由 aliasHistoryTrusted 另行決定。
 */
function withCurrentAliases(
  map: Record<string, string>,
  persisted: Record<string, string[]> = {},
): Record<string, string[]> {
  const aliases = Object.fromEntries(
    Object.entries(persisted)
      .filter(([, localSids]) => localSids.length > 0)
      .map(([wireSid, localSids]) => [wireSid, [...localSids]]),
  );
  for (const [wireSid, localSid] of Object.entries(map)) {
    const localSids = (aliases[wireSid] ??= []);
    if (!localSids.includes(localSid)) localSids.push(localSid);
  }
  return aliases;
}

function parseDriveState(raw: string, identityStateTrusted: boolean): PersistedDriveState {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("state root must be an object");
  }
  if (parsed.v === 2) {
    const map = stringRecord(parsed.map, "map");
    if (
      parsed.aliasHistoryTrusted !== undefined &&
      typeof parsed.aliasHistoryTrusted !== "boolean"
    ) {
      throw new Error("aliasHistoryTrusted must be a boolean");
    }
    const pending = parsed.pending ?? [];
    if (!Array.isArray(pending) || pending.some((sid) => typeof sid !== "string" || !sid)) {
      throw new Error("pending must contain non-empty strings");
    }
    const declaredAliasHistoryTrusted = parsed.aliasHistoryTrusted === true;
    const persistedAliases =
      parsed.aliases === undefined ? {} : stringArrayRecord(parsed.aliases, "aliases");
    if (declaredAliasHistoryTrusted) {
      if (parsed.aliases === undefined) {
        throw new Error("trusted alias history requires aliases");
      }
      for (const [wireSid, localSids] of Object.entries(persistedAliases)) {
        if (!localSids.length) {
          throw new Error(`trusted aliases for ${wireSid} must not be empty`);
        }
      }
      for (const [wireSid, currentLocalSid] of Object.entries(map)) {
        if (!persistedAliases[wireSid]?.includes(currentLocalSid)) {
          throw new Error(`trusted aliases for ${wireSid} omit current map value`);
        }
      }
    }
    return {
      // map 是 local↔wire E2E 安全邊界；缺字段不能再被 `?? {}` 洗成可信空映射。
      map,
      aliases: declaredAliasHistoryTrusted
        ? persistedAliases
        : withCurrentAliases(map, persistedAliases),
      cwds: stringRecord(parsed.cwds ?? {}, "cwds"),
      permModes: stringRecord(parsed.permModes ?? {}, "permModes"),
      models: stringRecord(parsed.models ?? {}, "models"),
      efforts: stringRecord(parsed.efforts ?? {}, "efforts"),
      pending: pending as string[],
      identityStateTrusted,
      aliasHistoryTrusted:
        identityStateTrusted &&
        declaredAliasHistoryTrusted &&
        parsed.aliases !== undefined,
    };
  }
  // v1 是平面 wire sid → CC uuid；字段值必須全為 string 才可恢復。
  const map = stringRecord(parsed, "legacy map");
  return {
    map,
    aliases: withCurrentAliases(map),
    cwds: {},
    permModes: {},
    models: {},
    efforts: {},
    pending: [],
    identityStateTrusted,
    aliasHistoryTrusted: false,
  };
}

export function workDir(): string {
  return process.env.MACCHIATO_CC_WORKDIR || homedir();
}

/** #118 閒置回收:回合結束後這麼久無新 prompt → close 通道回收 CLI 進程(resume 重建零丟失)。 */
function idleMs(): number {
  const s = Number(process.env.MACCHIATO_CC_IDLE_S || "600");
  return (Number.isFinite(s) && s > 0 ? s : 600) * 1000;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** SDK PermissionMode 合法值(對齊 @anthropic-ai/claude-agent-sdk)。 */
const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const;
type PermMode = (typeof PERMISSION_MODES)[number];

/** MACCHIATO_CC_PERMISSION_MODE → 校驗過的 permissionMode;未設/非法 → undefined(走 canUseTool 審批)。 */
export function permissionMode(): PermMode | undefined {
  const m = process.env.MACCHIATO_CC_PERMISSION_MODE;
  if (m && (PERMISSION_MODES as readonly string[]).includes(m)) return m as PermMode;
  if (m) console.error(`[drive] 忽略非法 MACCHIATO_CC_PERMISSION_MODE=${m}（合法:${PERMISSION_MODES.join("/")})`);
  return undefined;
}

/**
 * #255 bypass(bypassPermissions)= server 一幀即在用戶機器上**繞過全部審批任意執行**的高危檔。
 * 必須本地顯式開放才認:env `MACCHIATO_CC_ALLOW_BYPASS` 真值,或進程級默認本就是 bypassPermissions
 * (操作者已在自己機器 opt-in)。否則 server 下發的 bypass 降級為 ask(每工具審批)——對齊 projects.ts
 * 「本地硬校驗、server 攻破也指不動」紀律。cwd 不做白名單:那是 #227 自由文件夾特性,且 bypass
 * 門控後 ask/auto 檔的每個操作都經審批、cwd 可見,任意 cwd 不再構成盲執行。
 */
export function bypassAllowed(): boolean {
  const v = process.env.MACCHIATO_CC_ALLOW_BYPASS;
  if (v && /^(1|true|yes|on)$/i.test(v.trim())) return true;
  return permissionMode() === "bypassPermissions";
}

/** #253 回合看門狗:回合內連續**無任何 SDK 事件**達此毫秒數 → 判定卡死、強制收尾。
 * 活動式(每個事件續期)故不誤殺長回合;後台任務在跑時也豁免。默認 30min(對齊鏡像
 * transcripts.ts STALE_TURN_MS);env MACCHIATO_CC_TURN_STALL_MS 可調(0=關)。 */
function turnStallMs(): number {
  const v = Number(process.env.MACCHIATO_CC_TURN_STALL_MS);
  if (Number.isFinite(v) && v >= 0) return v;
  return 30 * 60_000;
}

/** #98/#205 UI 五檔(協議 PermissionMode)。 */
const UI_MODES = ["ask", "acceptEdits", "auto", "plan", "bypass"] as const;
type UiMode = (typeof UI_MODES)[number];
/** 文件編輯類工具——acceptEdits 檔在 canUseTool 內自動批(#116:SDK acceptEdits 被 canUseTool 覆蓋,故自實現)。 */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "ApplyPatch"]);

/** #279 E2E prompt 解密失敗的用戶可見回執(僅提示語,零內容洩漏;四連接器同文案)。 */
const E2E_DECRYPT_FAIL_WARNING = "無法解密這條消息(設備與連接器的加密密鑰可能失步)——請重試,或重新關閉再開啟本會話的端到端加密。";
/**
 * #98/#205 UI 五檔 → SDK permissionMode + canUseTool 策略(#116/#205 探針背書)。
 * - ask       → default,每工具問
 * - acceptEdits → default,編輯類自動批、其餘問(不用 SDK acceptEdits:被 canUseTool 覆蓋)
 * - auto      → auto,classifier 自動批安全操作(#205 探針:classifier 先行、批准的不進
 *               canUseTool——與 acceptEdits 被覆蓋不同;拿不準的仍落 canUseTool 彈審批卡)
 * - plan      → plan,ExitPlanMode 經審批橋(#99)
 * - bypass    → bypassPermissions,不調 canUseTool
 */
function mapUiMode(ui: UiMode): { sdk: PermMode | undefined; editAuto: boolean } {
  switch (ui) {
    case "ask":
      return { sdk: "default", editAuto: false };
    case "acceptEdits":
      return { sdk: "default", editAuto: true };
    case "auto":
      return { sdk: "auto", editAuto: false };
    case "plan":
      return { sdk: "plan", editAuto: false };
    case "bypass":
      return { sdk: "bypassPermissions", editAuto: false };
  }
}

/** #118 可推送 async iterable —— streaming-input 的 prompt 載體(#116 探針同款)。 */
class PushStream<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private notify: (() => void) | undefined;
  private closed = false;
  push(v: T): void {
    this.queue.push(v);
    this.notify?.();
  }
  close(): void {
    this.closed = true;
    this.notify?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => (this.notify = r));
      this.notify = undefined;
    }
  }
}

type ClaudeApprovalExecutionSnapshot = {
  v: 1;
  connector: "claude-code";
  sessionId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
};

interface PendingApproval {
  resolve: (allow: boolean, always: boolean) => void;
  toolName: string;
  /** #102 SDK 給的 toolUseID(隨 approval.request 上行;server 支持後 respond 回帶精準配對)。 */
  requestId?: string;
  /** #370 E2E 审批响应还必须精确回带此摘要。 */
  requestDigest?: string;
  /** digest、加密卡片与最终 updatedInput 共用的 immutable 完整执行请求。 */
  executionSnapshot?: ClaudeApprovalExecutionSnapshot;
  /** #238 SDK 給的窄規則建議——「總是允許」時存檔(alwaysRules)供通道重建回灌。 */
  suggestions?: PermissionUpdate[];
}

/** #238 PermissionUpdate(addRules/allow)→ settings.permissions.allow 規則串;無可用建議 → 工具級兜底。 */
export function ruleStringsFor(suggestions: PermissionUpdate[] | undefined, toolName: string): string[] {
  const out: string[] = [];
  for (const s of suggestions ?? []) {
    if (s.type !== "addRules" || s.behavior !== "allow") continue;
    for (const r of s.rules ?? []) {
      if (!r?.toolName) continue;
      out.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
    }
  }
  if (!out.length) out.push(toolName);
  return out;
}

/** #109 AskUserQuestion 的單題掛起（clarify.respond 按 request_id 回填;empty answer = 跳過）。 */
interface PendingClarify {
  sid: string;
  requestDigest?: string;
  /** 記一題答案（null = 跳過）;組內全部到齊時解掛 canUseTool。 */
  record: (answer: string | null) => void;
}

/** 一回合的 prompt 內容:純文本,或 #118 原生塊數組(text + image content blocks)。 */
type TurnContent = string | unknown[];

/** TurnContent → 首段文本(標題生成/日誌用)。 */
function contentText(c: TurnContent): string {
  if (typeof c === "string") return c;
  const t = c.find((b: any) => b?.type === "text") as { text?: string } | undefined;
  return t?.text ?? "";
}

/** #118 一個進行中回合的狀態(原 runTurn 的局部變量,搬進通道供 consume 循環跨消息使用)。 */
interface TurnCtx {
  content: TurnContent;
  /** tool_use id → {name, argsText}(tool.complete 回填用)。 */
  tools: Map<string, { name: string; argsText: string }>;
  started: boolean;
  completed: boolean;
  /** 本回合已見任何 SDK 事件 —— 送達確認(#116 b:未見即死 → 重投一次)。 */
  seen: boolean;
  /** 重投已用過(防循環)。 */
  retried: boolean;
  acc: string;
  lastError?: string; // #102 assistant.error(auth/billing/rate_limit…)→ 失敗行帶上
  /** #318 本回合 live 投遞覆蓋的 API message.id 集(mirror 據此吞回合末晚落盤的 transcript 殘片,
   * 防 live×mirror 雙投)。message.id 是 SDK 事件與 transcript 行的共同穩定身份。 */
  seenMsgIds: Set<string>;
  isE2E: boolean;
  isFirstMacchiatoTurn: boolean;
  /** #141 output tokens 兜底本地累加:outputBase=已完成子消息之和,outputLive=當前子消息 message_delta 累計。
   *  SDK 運行時 usage 可用時改以其 session 累計為權威(含 subagent),見下 usageBaseline/sdkOutput。
   *  lastUsageEmitAt 節流 turn.usage 上報。 */
  outputBase: number;
  outputLive: number;
  lastUsageEmitAt: number;
  /** #141b SDK 運行時 usage(experimental):usageBaseline=回合起始的 session 累計 output(算本回合增量用;
   *  null=接口不可用/未取到 → 全程退回本地累加)。sdkOutput=最近一次輪詢到的 session 累計 output。
   *  usageInFlight/lastSdkPollAt:防並發 + 節流輪詢。 */
  usageBaseline: number | null;
  sdkOutput: number | null;
  usageInFlight: boolean;
  lastSdkPollAt: number;
  /** #253 回合看門狗:最近一次 SDK 事件的時間戳(活動式判卡——續期靠它,而非硬 deadline)。 */
  lastActivityAt: number;
}

/** #118 一條長活通道(每活躍會話一條;閒置回收,resume 重建)。 */
interface Channel {
  sid: string;
  /** 通道創建時的工作目錄(#105 變更 → 閒置/回合末重建通道生效)。 */
  cwd: string;
  /** #98 通道創建時的權限模式(UI 檔或 env 兜底標記;變更 → 同 cwd 重建通道)。 */
  permKey: string;
  /** #143 通道創建時的 model(per-session 選擇或 env 兜底;變更 → 重建通道)。 */
  modelKey: string;
  effortKey: string; // #231
  input: PushStream<unknown>;
  q: Query;
  turn?: TurnCtx;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** #253 在途回合的卡死看門狗(無事件靜默超時 → 強制收尾 + 回收通道)。 */
  watchdog?: ReturnType<typeof setTimeout>;
  /** close() 已叫(閒置回收/cwd 變更/dispose)——迭代器自然結束不當 crash。 */
  closing: boolean;
}

export class Drive {
  /** #10:累計計數(進程生命週期),健康上報帶出。 */
  readonly counters: Record<string, number> = { driveErrors: 0, turnErrors: 0 };
  /** #310 認證失效持續態:auth 類回合失敗置 true(health 上報 authOk=false),成功回合恢復。 */
  authFailed = false;
  /** serverSid → CC session uuid（跨重啟持久）。 */
  private map: Record<string, string>;
  /**
   * serverSid → 所有歷史 CC session uuid。CLI resume/fork 可能在 init 回一個新 uuid；
   * 舊、新 transcript 都仍屬同一 wire 會話，尤其 E2E 下不可讓任一 alias 回落成明文。
   */
  private aliases: Record<string, string[]>;
  /** #105 serverSid → 會話工作目錄（session.create.cwd 下發；跨重啟持久，與 map 同文件 v2 存）。 */
  private cwds: Record<string, string>;
  /** #98 serverSid → UI 權限檔（session.create.permissionMode 下發；持久，同文件存）。 */
  private permModes: Record<string, string>;
  /** #143 serverSid → 會話 model（session.create.model 下發；持久，同文件存）。 */
  private models: Record<string, string>;
  /** #231 serverSid → reasoning effort(session.create.effort;持久,同文件存)。 */
  private efforts: Record<string, string>;
  /** 主身份快照是否完整可信；只從舊 .bak/空 fallback 恢復時不得放行 E2E plaintext 路徑。 */
  private identityStateTrusted: boolean;
  /** 是否已知 aliases 涵蓋所有歷史 fork；舊 v2/legacy/backup 一律 false。 */
  private aliasHistoryTrusted: boolean;
  /** identity rotation 落盤失敗後即毒化；當前/後續 E2E live 不得繼續猜身份。 */
  private identityPersistencePoisoned = false;
  /**
   * #200 一期(可見化):**在途回合**的 sid 集(持久)。回合起加、止刪;進程死在回合中途 →
   * 該 sid 留在盤上 → 下次啟動撈出、Link B ready 後回一條 system 提示「連接器重啟了,這條沒跑完,
   * 請重發」,消滅「發消息無響應無報錯」的靜默失敗(設備重啟同理)。不做自動 resume(避雙投)。
   */
  private pending: Set<string>;
  /** #200 上個進程死時遺留的在途回合(構造時從盤載入、當即清盤;flushAbandoned 在 ready 後告知)。 */
  private abandonedTurns: string[] = [];
  /** #118 sid → 長活通道。 */
  private readonly channels = new Map<string, Channel>();
  /** sid → 排隊的後續 prompt（回合進行中收到的;#118 起可含原生塊數組）。 */
  private readonly queued = new Map<string, TurnContent[]>();
  /** sid → 待批審批（#102 起 respond 帶 request_id 精準配對;缺省回退 FIFO 兼容舊 server）。 */
  private readonly approvals = new Map<string, PendingApproval[]>();
  /** #109 request_id → 待答的 AskUserQuestion 單題（多題共享一個 group,收齊才解掛 canUseTool）。 */
  private readonly clarifies = new Map<string, PendingClarify>();
  /** #102 sid → 本回合被 session.interrupt 中斷(result 定性 interrupted 而非 error)。 */
  private readonly interruptedSids = new Set<string>();
  /** #102 未處理 SDK 消息類型一次性日誌去重(`type/subtype`)——37 種 SDKMessage 只處理一小撮,靜默丟=升級漂移無感知。 */
  private readonly loggedUnknown = new Set<string>();
  /** #238 sid → 「總是允許」累積的**窄規則**串(settings 格式,如 "Bash(git status:*)")。
   * 只在通道重建時經 settings.permissions.allow 回灌;活通道內由 updatedPermissions 即時生效。
   * 絕不按工具名短路——那會把 Bash(git status) 放大成本會話所有 Bash(舊實現的 p1 漏洞)。 */
  private readonly alwaysRules = new Map<string, string[]>();
  /** §19 E2E：回合內暫存的（已解密）用戶消息，回合結束隨加密批投遞。 */
  private readonly pendingUser = new Map<string, string[]>();
  private readonly e2eControl?: E2EControlVerifier;

  constructor(
    private readonly linkb: LinkBClient,
    private readonly mirror?: Mirror,
    private readonly e2e?: E2EKeyStore,
    /** #199 命令上報器:live 通道的 commands_changed 經 drive 轉給它(整份替換)。 */
    private readonly commands?: CommandsReporter,
    /** #227 回合末惰性版本化鉤子(掃備案目錄的 AGENTS.md)。 */
    private readonly projects?: { checkTurnEnd(): void },
    e2eControl?: E2EControlVerifier,
  ) {
    const state = this.loadState();
    this.map = state.map;
    this.aliases = state.aliases;
    this.cwds = state.cwds;
    this.permModes = state.permModes;
    this.models = state.models;
    this.efforts = state.efforts;
    this.identityStateTrusted = state.identityStateTrusted;
    this.aliasHistoryTrusted = state.aliasHistoryTrusted;
    this.e2eControl = e2eControl ?? (e2e ? new E2EControlVerifier(e2e) : undefined);
    // 影子兜底:啟動時把既有 ULID→CLI 映射的 CLI uuid 全灌給鏡像(跨重啟持久),鏡像據此永不給
    // 這些「被驅動過」的 CLI 會話單獨建會話(防重啟後污染態丟失又復發)。
    for (const localSids of Object.values(this.aliases)) {
      for (const localSid of localSids) this.mirror?.markDrivenUuid(localSid);
    }
    // #200 上個進程死時盤上還留著的在途回合 = 被殺掉的回合。撈出待 flush(ready 後告知),當即清盤
    // (新回合從空集重記,不與舊的混)。
    this.abandonedTurns = state.pending;
    this.pending = new Set();
    if (state.pending.length) {
      // 進程可能死在 input.push 之後、SDK init/alias save 之前；本地已可能產生一個未知 fork。
      // 清 crash marker 時必須同步撤銷 alias 完整性，不能讓舊 trusted=true 穿過重啟。
      this.aliasHistoryTrusted = false;
      this.saveMap();
    }
    // task.sync:每次 Link B ready(含重連)全量上報仍活着的後台任務清單。連接器進程重啟後清單
    // 為空 → server 秒級收殮該 link 遺留的 running task 塊(進程死=任務死),不必等超齡殭屍清掃。
    // 舊 server 對未知事件 default 忽略,無害。時序:client 先 flushPending(斷線期間緩衝的
    // late task.end 先落地)再觸發 readyHandlers,sync 不會搶在 end 之前誤殮。
    this.linkb.onReady(() => this.pushTaskSync());
  }

  /** 全量上報「仍活着的後台任務」(鏈路級,session_id 佔位;見構造器註釋)。 */
  private pushTaskSync(): void {
    const tasks: Array<{ session_id: string; task_id: string }> = [];
    for (const [sid, set] of this.sessionTasks) for (const task_id of set) tasks.push({ session_id: sid, task_id });
    this.emit("-", "task.sync", { tasks });
  }

  /**
   * #200 一期:Link B ready 後,對「上個進程死時被殺的在途回合」回一條 system 提示,把靜默無響應變
   * 成明確可操作(重發)。非 E2E 才發明文提示(E2E 不洩明文;其會話重發即可)。冪等——清空後不再發。
   */
  flushAbandonedTurns(): void {
    const sids = this.abandonedTurns;
    this.abandonedTurns = [];
    for (const sid of sids) {
      if (this.e2e?.isE2E(sid)) continue;
      this.emit(sid, "review.summary", {
        summary: "⚠️ 連接器剛重啟,上一條消息可能沒跑完——請重發一次。",
      });
    }
  }

  /**
   * #75/#199 投遞一回合內容(prompt.submit 與 command.invoke 共用):
   * 回合進行中 = steer(硬轉向,2026-07-11 用戶拍板默認行為)——打斷當前回合(定稿 interrupted,
   * 已生成部分保留)+ 新內容進隊由 finishTurn 續投(同通道帶完整上下文)。SDK 無「邊生成邊融合」
   * (探測結論 3),打斷+接管是唯一真 steer;與 OpenClaw 在 Macchiato 的 steer 行為對齊。
   * 閒置 = 直接開新回合。
   */
  private async dispatchContent(
    sid: string,
    content: TurnContent,
    requireDelivery = false,
  ): Promise<void> {
    const busy = this.channels.get(sid);
    if (busy?.turn) {
      const q = this.queued.get(sid) ?? [];
      q.push(content);
      this.queued.set(sid, q);
      if (!busy.turn.completed) {
        this.interruptedSids.add(sid);
        try {
          await busy.q.interrupt();
        } catch {
          /* 回合恰好剛結束 → interrupt 空打,排隊消息由 finishTurn 正常續投 */
        }
        // ⚠️ 回歸契約:scripts/regression/run-cc-regression.mjs 斷言「Steer:打斷當前回合」,改動需同步
        console.log(`· Steer:打斷當前回合,新消息接管 → ${sid}`);
      }
      return;
    }
    this.startTurn(sid, content, { requireDelivery });
  }

  /** #98 該會話當前 SDK 權限模式 + 編輯自動批策略。UI 檔優先,回退 env(逃生門)。permKey=通道重建判據。 */
  private resolvePerm(sid: string): { sdk: PermMode | undefined; editAuto: boolean; permKey: string } {
    const ui = this.permModes[sid];
    if (ui && (UI_MODES as readonly string[]).includes(ui)) {
      // #255:未本地開放 bypass → 降級 ask,server 攻破也繞不過審批(permKey 帶標記以正確重建通道)。
      if (ui === "bypass" && !bypassAllowed()) {
        return { sdk: "default", editAuto: false, permKey: "ui:bypass!denied" };
      }
      const m = mapUiMode(ui as UiMode);
      return { ...m, permKey: `ui:${ui}` };
    }
    const env = permissionMode();
    return { sdk: env, editAuto: false, permKey: `env:${env ?? "ask"}` };
  }

  /**
   * #143 該會話當前 model:per-session 選擇優先,回退 env `MACCHIATO_CC_MODEL`(逃生門),
   * 都無 → undefined(不傳 model,用 CLI 配置默認)。絕不 hardcode(鐵律)——列表由 web 端提供,
   * 連接器只透傳用戶所選。返回 undefined 時通道 modelKey="default"。
   */
  private resolveModel(sid: string): string | undefined {
    const ui = this.models[sid];
    if (ui) return ui;
    const env = process.env.MACCHIATO_CC_MODEL;
    return env || undefined;
  }

  /** #231 該會話 reasoning effort:per-session 優先,回退 env MACCHIATO_CC_EFFORT;都無 → undefined(模型默認)。 */
  private resolveEffort(sid: string): string | undefined {
    return this.efforts[sid] || process.env.MACCHIATO_CC_EFFORT || undefined;
  }

  /** #266 sid → 內容型幀(prompt.submit/command.invoke)的串行鏈。附件下載(await materialize)慢時,
   * 後到的純文本此前會超車 startTurn、附件幀反被 steer 打斷 → 順序反轉。串行保序。 */
  private readonly frameChain = new Map<string, Promise<void>>();

  wire(): void {
    this.linkb.onFrame((m) => this.routeFrame(m));
  }

  /** #266 內容型幀 per-sid 串行(保序);其餘(interrupt/approval/session.* 等)即時,不被慢下載堵住。 */
  private routeFrame(msg: Record<string, unknown>): void {
    const frame = (msg.frame ?? {}) as { method?: string; params?: Record<string, unknown> };
    const method = frame.method;
    const sid = (msg.sessionId ?? frame.params?.session_id) as string | undefined;
    if (sid && (method === "prompt.submit" || method === "command.invoke")) {
      const prev = this.frameChain.get(sid) ?? Promise.resolve();
      const next = prev.then(() => this.onServerFrame(msg)).catch((e) => console.error(`[frame ${method} ${sid}] ${(e as Error).message}`));
      this.frameChain.set(sid, next);
      void next.finally(() => {
        if (this.frameChain.get(sid) === next) this.frameChain.delete(sid);
      });
    } else {
      void this.onServerFrame(msg);
    }
  }

  /** #118 關停:回收全部通道(CLI 進程),供 index.ts shutdown 調用。 */
  dispose(): void {
    for (const ch of [...this.channels.values()]) this.closeChannel(ch);
  }

  private emit(sid: string, type: string, payload: Record<string, unknown>): void {
    this.linkb.send({
      t: "tui",
      agentLinkId: this.linkb.agentLinkId,
      sessionId: sid,
      frame: { jsonrpc: "2.0", method: "event", params: { type, session_id: sid, payload } },
    });
  }

  private ccSidFor(sid: string): string | undefined {
    if (this.identityPersistencePoisoned && this.e2e?.isE2E(sid)) {
      throw new Error(`Claude Code E2E identity persistence is poisoned for ${sid}`);
    }
    // 鏡像會話通常 sid 即 CC uuid；但 SDK resume/fork 也可能換 uuid，此後跟隨持久 current map。
    return this.map[sid] ?? (CC_UUID_RE.test(sid) ? sid : undefined);
  }

  /** E2E backfill 的本地 transcript 身份；wire sid 仍由呼叫方原樣保留。 */
  localSessionIdFor(sid: string): string | undefined {
    return this.ccSidFor(sid);
  }

  /** Mirror / push 等本地 UUID 路徑使用的反向 wire identity。 */
  e2eWireSessionIdFor(localSid: string): string | undefined {
    if (!this.e2e) return undefined;
    for (const wireSid of new Set([...Object.keys(this.aliases), ...Object.keys(this.map)])) {
      if (this.localSessionIdsForWire(wireSid).includes(localSid) && this.e2e.isE2E(wireSid)) {
        return wireSid;
      }
    }
    return undefined;
  }

  private localSessionIdsForWire(wireSid: string): string[] {
    return [...new Set([...(this.aliases[wireSid] ?? []), ...(this.map[wireSid] ? [this.map[wireSid]] : [])])];
  }

  private rememberLocalSessionId(wireSid: string, localSid: string): boolean {
    const localSids = (this.aliases[wireSid] ??= []);
    if (localSids.includes(localSid)) return false;
    localSids.push(localSid);
    return true;
  }

  private protectedWireSids(): string[] {
    const fn = (this.e2e as (E2EKeyStore & { protectedSessionIds?: () => string[] }) | undefined)
      ?.protectedSessionIds;
    return typeof fn === "function" ? fn.call(this.e2e) : [];
  }

  /**
   * CC resume/fork 会让一个 wire sid 对应多个本地 transcript UUID。任一本地 UUID 都不能
   * 被 server 重新包装成未保护 sid，否则 prompt/control 会直达同一 transcript。
   */
  private protectedInboundAliasOwner(sid: string): string | undefined {
    return this.protectedWireSids().find((wireSid) => {
      if (wireSid === sid) return false;
      if (sameLocalUUID(wireSid, sid)) return true;
      return this.localSessionIdsForWire(wireSid).some(
        (localSid) => localSid === sid || sameLocalUUID(localSid, sid),
      );
    });
  }

  private hasAuthoritativeServerSnapshot(): boolean {
    if (!this.e2e) return true;
    const fn = (this.e2e as E2EKeyStore & {
      hasServerStateSnapshot?: () => boolean;
    }).hasServerStateSnapshot;
    return typeof fn === "function" && fn.call(this.e2e);
  }

  private fatalIdentityPersistence(message: string): never {
    this.identityPersistencePoisoned = true;
    this.dispose();
    // 真 LinkBClient 具備兩者；測試/窄 mock 可省略。交 supervisor 重啟，不能留一個
    // 身份盤已不確定但仍接受後續 prompt 的半活 connector。
    this.linkb.close?.();
    this.linkb.onFatal?.();
    throw new Error(`fatal: ${message}`);
  }

  /** 壞/缺 wire↔CC UUID 身份快照時整體拒絕 ready，不能讓 live/mirror/import 猜成明文。 */
  assertE2EIdentitySafe(): void {
    const protectedWireSids = this.protectedWireSids();
    if (this.identityPersistencePoisoned && protectedWireSids.length) {
      throw new Error(
        "Claude Code E2E identity persistence is poisoned; refusing all protected identity paths",
      );
    }
    const requiringMap = protectedWireSids.filter(
      (sid) =>
        !CC_UUID_RE.test(sid) ||
        this.map[sid] !== undefined ||
        (this.aliases[sid]?.length ?? 0) > 0,
    );
    if (!requiringMap.length) return;
    const missing = requiringMap.filter((sid) => {
      const current = this.map[sid];
      const localSids = this.localSessionIdsForWire(sid);
      return (
        !CC_UUID_RE.test(current ?? "") ||
        !localSids.includes(current) ||
        localSids.some((localSid) => !CC_UUID_RE.test(localSid))
      );
    });
    if (!this.identityStateTrusted || missing.length) {
      throw new Error(
        `Claude Code E2E identity map unavailable/incomplete (trusted=${this.identityStateTrusted}, ` +
          `poisoned=${this.identityPersistencePoisoned}, ` +
          `missing=${missing.slice(0, 3).join(",") || "unknown"}); refusing plaintext fallback`,
      );
    }
  }

  /** 防禦縱深：整體 ready 閘之外，Mirror 每次明文 local UUID 發送前也即時詢問。 */
  plaintextLocalMirrorAllowed(localSid: string): boolean {
    const protectedIds = this.protectedWireSids();
    if (!protectedIds.length) return true;
    if (!this.aliasHistoryTrusted) return false;
    try {
      this.assertE2EIdentitySafe();
    } catch {
      return false;
    }
    // 有任一 protected 會話時，完全未知 UUID 可能是 crash-before-alias-save 的 E2E fork，
    // 不得當作新 plaintext terminal session。只有持久 alias 明確指向非 E2E wire 才可明文。
    for (const wireSid of new Set([...Object.keys(this.aliases), ...Object.keys(this.map)])) {
      if (!this.localSessionIdsForWire(wireSid).includes(localSid)) continue;
      return !this.e2e?.isE2E(wireSid);
    }
    return false;
  }

  /**
   * history import 枚舉的是本地 CC uuid，E2E store 則以 server wire sid 為 key。
   * 每次導入前拍一份反向映射；同一 local uuid 只要任一關聯 wire sid 為 E2E，就必須整條過濾。
   */
  localSessionE2EStatus(): { isE2E(localSid: string): boolean } {
    const e2e = this.e2e;
    if (!e2e) return { isE2E: () => false };
    if (this.protectedWireSids().length && !this.aliasHistoryTrusted) {
      return { isE2E: () => true };
    }
    try {
      this.assertE2EIdentitySafe();
    } catch {
      return { isE2E: () => true };
    }
    const protectedLocal = new Set<string>();
    const knownPlainLocal = new Set<string>();
    for (const wireSid of new Set([...Object.keys(this.aliases), ...Object.keys(this.map)])) {
      const target = e2e.isE2E(wireSid) ? protectedLocal : knownPlainLocal;
      for (const localSid of this.localSessionIdsForWire(wireSid)) target.add(localSid);
    }
    return {
      isE2E: (localSid: string) => {
        if (protectedLocal.has(localSid) || e2e.isE2E(localSid)) return true;
        if (knownPlainLocal.has(localSid)) return false;
        // 與 mirror 同一 fail-closed 分類：protected>0 時未知 local 一律視為受保護。
        return this.protectedWireSids().length > 0;
      },
    };
  }

  /** sid → 該會話進行中的後台 task_id 集合(task.stop 短 id 前綴還原兜底 + 展示去重)。 */
  private readonly sessionTasks = new Map<string, Set<string>>();
  /** task_id → 上次 progress 上報時刻(節流)。 */
  private readonly taskProgressAt = new Map<string, number>();
  /** #384 task_id → 後台任務 output 文件路徑(從啟動回執解析;task_notification 讀真輸出作 report)。 */
  private readonly taskOutputFiles = new Map<string, string>();
  /** #384 report 上限:與 server TASK_REPORT_CAP 對齊(超長取尾——結局比開頭有用)。 */
  private static readonly TASK_REPORT_CAP = 30_000;

  /**
   * #384 從後台任務啟動回執解析 output 文件路徑:
   * 「Command running in background with ID: <id>. Output is being written to: <path>.」
   * 這是「細節丟失只剩 task 編號」的修復根基——真輸出只存在於連接器主機的這個文件裡。
   */
  private captureTaskOutputFile(resultText: string): void {
    const m = resultText.match(/Command running in background with ID:\s*(\S+?)\.?\s[\s\S]*?Output is being written to:\s*(\S+?)\.?(?:\s|$)/);
    if (!m) return;
    this.taskOutputFiles.set(m[1]!, m[2]!);
    while (this.taskOutputFiles.size > 128) this.taskOutputFiles.delete(this.taskOutputFiles.keys().next().value!); // 防洩漏
  }

  /** #384 讀後台任務真輸出(文件尾,cap 30k)。讀不到(已清理/權限)→ undefined,report 缺席即回退舊行為。 */
  private readTaskReport(taskId: string): string | undefined {
    const file = this.taskOutputFiles.get(taskId);
    if (!file) return undefined;
    this.taskOutputFiles.delete(taskId);
    try {
      const text = readFileSync(file, "utf8");
      if (!text.trim()) return undefined;
      return text.length > Drive.TASK_REPORT_CAP ? `…(前略 ${text.length - Drive.TASK_REPORT_CAP} 字)\n${text.slice(-Drive.TASK_REPORT_CAP)}` : text;
    } catch {
      return undefined;
    }
  }
  /** #104 進度改原地更新(不再刷屏),節流可比文本行時代(15s)更密。 */
  private static readonly PROGRESS_THROTTLE_MS = 5_000;

  private hasRunningTasks(sid: string): boolean {
    return (this.sessionTasks.get(sid)?.size ?? 0) > 0;
  }

  /**
   * #253 回合看門狗:回合在途但連續無任何 SDK 事件達 turnStallMs → 判定卡死。CLI 掛住(有事件無
   * result)或 startContinuationTurn 合成回合無後續時,回合永久在途——通道不回收(CLI 進程滯留)、
   * sid 卡 #200 pending(重啟誤發「請重發」)。鏡像側有 STALE_TURN_MS 兜底,drive 側此前沒有。
   * 活動式(每事件續期,見 handleMessage)故不誤殺長回合;後台任務在跑時豁免(hasRunningTasks)。
   */
  private armTurnWatchdog(ch: Channel): void {
    this.clearTurnWatchdog(ch);
    const stall = turnStallMs();
    if (!stall || !ch.turn) return; // 0=關
    const due = ch.turn.lastActivityAt + stall - Date.now();
    ch.watchdog = setTimeout(() => {
      ch.watchdog = undefined;
      const turn = ch.turn;
      if (!turn || turn.completed || ch.closing) return;
      // 後台任務在跑 / 期間有活動(lastActivityAt 被續期)→ 沒卡,重排
      if (this.hasRunningTasks(ch.sid) || Date.now() - turn.lastActivityAt < stall) {
        this.armTurnWatchdog(ch);
        return;
      }
      this.forceFinalizeStuck(ch, stall);
    }, Math.max(due, 25)); // 地板 25ms 只防邊界重排的 0/負值忙轉,不影響 stall 精度
    ch.watchdog.unref?.();
  }

  private clearTurnWatchdog(ch: Channel): void {
    if (ch.watchdog) {
      clearTimeout(ch.watchdog);
      ch.watchdog = undefined;
    }
  }

  /** #253 卡死回合強制收尾:定稿 error + 提示重試、解掛審批、回收卡死的 CLI 通道(下個 prompt 建新 resume)。 */
  private forceFinalizeStuck(ch: Channel, stall: number): void {
    const sid = ch.sid;
    const turn = ch.turn;
    if (!turn) return;
    console.error(`[turn watchdog] ${sid} 回合 ${Math.round(stall / 1000)}s 無任何事件 → 判定卡死,強制收尾 + 回收通道`);
    turn.completed = true;
    if (!turn.isE2E) {
      this.startMsg(sid, turn);
      this.emit(sid, "message.complete", { text: turn.acc || "", status: "error", usage: {} });
      this.emit(sid, "review.summary", { summary: "⚠️ 回合長時間無響應,已判定卡死並收尾——請重試。" });
    }
    for (const p of this.approvals.get(sid) ?? []) p.resolve(false, false);
    this.approvals.delete(sid);
    ch.turn = undefined;
    this.pending.delete(sid); // #200 出在途集(否則重啟誤發「請重發」)
    this.saveMap();
    this.closeChannel(ch); // 卡死的 CLI 通道回收;onChannelEnd 見 turn 已 undefined 不重複定稿
  }

  /** #212 任務在跑時通道不算閒置；最後一個任務結束後才重新開始完整 idle 窗。 */
  private scheduleIdleClose(ch: Channel): void {
    if (ch.idleTimer) {
      clearTimeout(ch.idleTimer);
      ch.idleTimer = undefined;
    }
    if (ch.closing || ch.turn || this.channels.get(ch.sid) !== ch || this.hasRunningTasks(ch.sid)) return;
    ch.idleTimer = setTimeout(() => {
      ch.idleTimer = undefined;
      // task_started 可能和 timer callback 同一個 event-loop tick 到達；關前再查一次。
      if (ch.closing || ch.turn || this.channels.get(ch.sid) !== ch || this.hasRunningTasks(ch.sid)) return;
      this.closeChannel(ch);
    }, idleMs());
    ch.idleTimer.unref?.();
  }

  /**
   * #97→#104 後台任務:task_started/progress/notification → 結構化 task.start/update/end
   * (server 落一等 task 塊、原地更新;舊 server 的 switch default 忽略,無害)。
   * subagent 與後台 bash 統一;task_id 全量上報(task.stop 不再靠短 id 還原)。
   * #118 註:task 事件可在回合 result 之後才到(後台任務跑完前通道仍活)——會話級處理,不依賴 turn。
   */
  private handleTaskEvent(sid: string, m: Record<string, any>, visible: boolean): void {
    const taskId: string = String(m.task_id ?? "");
    if (!taskId || m.ambient === true) return; // ambient/housekeeping 任務隱藏
    if (m.subtype === "task_started") {
      const set = this.sessionTasks.get(sid) ?? new Set();
      set.add(taskId);
      this.sessionTasks.set(sid, set);
      // task_started 可晚於主回合 result；立即撤掉已掛的 idle timer，別等 callback 才發現。
      const ch = this.channels.get(sid);
      if (ch?.idleTimer) {
        clearTimeout(ch.idleTimer);
        ch.idleTimer = undefined;
      }
      if (visible) {
        this.emit(sid, "task.start", {
          task_id: taskId,
          kind: m.subagent_type ? "subagent" : "background",
          ...(m.subagent_type ? { subagent_type: String(m.subagent_type) } : {}),
          desc: String(m.description ?? "task").slice(0, 200),
          // #138:發起任務的 Task 工具調用 id——server 據此把工具塊原地升格為 task 塊。
          ...(m.tool_use_id ? { tool_use_id: String(m.tool_use_id) } : {}),
          // #222:子代理指令全文——Details 對齊鏡像側(描述+prompt+報告)。
          ...(m.prompt ? { prompt: String(m.prompt).slice(0, 8000) } : {}),
        });
      }
    } else if (m.subtype === "task_progress") {
      if (!visible) return;
      const now = Date.now();
      if (now - (this.taskProgressAt.get(taskId) ?? 0) < Drive.PROGRESS_THROTTLE_MS) return; // 節流
      this.taskProgressAt.set(taskId, now);
      // #222:步數/token 也是進度——沒有新工具名照樣上報(節流已擋頻率)。
      const usage = (m.usage ?? {}) as Record<string, unknown>;
      const update = {
        ...(m.last_tool_name ? { last_activity: String(m.last_tool_name) } : {}),
        ...(typeof usage.tool_uses === "number" ? { tool_uses: usage.tool_uses } : {}),
        ...(typeof usage.total_tokens === "number" ? { total_tokens: usage.total_tokens } : {}),
      };
      if (Object.keys(update).length === 0) return; // 真沒新信息才不發
      this.emit(sid, "task.update", { task_id: taskId, ...update });
    } else if (m.subtype === "task_notification") {
      const set = this.sessionTasks.get(sid);
      set?.delete(taskId);
      if (set?.size === 0) this.sessionTasks.delete(sid);
      this.taskProgressAt.delete(taskId);
      const status = m.status === "completed" ? "completed" : m.status === "stopped" ? "stopped" : "error";
      // notification 的 desc 不回退 summary(否則兩者相同時 summary 被誤判重複而丟——
      // 後台 bash 常只帶 summary 不帶 description)。desc 供 server 錯過 start 時兜底建行。
      const desc = String(m.description ?? "").slice(0, 200);
      const summary = String(m.summary ?? "").slice(0, 500);
      // #222:終態統計(task_notification.usage)。
      const usage = (m.usage ?? {}) as Record<string, unknown>;
      if (visible) {
        // #384 後台任務:讀 output 文件真輸出隨 task.end 上送(server 回填原工具塊,
        // 覆蓋「Command running in background…」啟動回執)。subagent 無 output 文件,report 缺席。
        const report = this.readTaskReport(taskId);
        this.emit(sid, "task.end", {
          task_id: taskId,
          status,
          ...(summary && summary !== desc ? { summary } : {}),
          ...(desc ? { desc } : {}),
          ...(report ? { report } : {}),
          ...(typeof usage.tool_uses === "number" ? { tool_uses: usage.tool_uses } : {}),
          ...(typeof usage.total_tokens === "number" ? { total_tokens: usage.total_tokens } : {}),
        });
      }
      // 多任務只在最後一個歸零後計時；若 SDK 隨即自發續寫，init 會再清掉這個 timer。
      const ch = this.channels.get(sid);
      if (ch && !ch.turn && !this.hasRunningTasks(sid)) this.scheduleIdleClose(ch);
    }
    // task_updated / task_summary:v1 不單獨展示(進度靠 task_progress,完成靠 notification)。
  }

  private sendE2EControlResult(
    rawEnvelope: unknown,
    wireSid: string,
    ok: boolean,
    error?: "control_rejected" | "side_effect_failed",
  ): void {
    if (rawEnvelope === null || typeof rawEnvelope !== "object" || Array.isArray(rawEnvelope)) return;
    const envelope = rawEnvelope as Partial<E2EControlEnvelopeV1>;
    if (typeof envelope.sessionId !== "string" || !envelope.sessionId) return;
    if (typeof envelope.msgId !== "string" || !envelope.msgId) return;
    this.linkb.send({
      t: "e2e_control_result",
      agentLinkId: this.linkb.agentLinkId,
      sessionId: envelope.sessionId,
      hermesSessionId: wireSid,
      msgId: envelope.msgId,
      ok,
      ...(error ? { error } : {}),
    });
  }

  private async onE2EControl(wireSid: string, rawEnvelope: unknown): Promise<void> {
    let dispatchStarted = false;
    try {
      if (!this.e2eControl) throw new E2EControlError("E2E control verifier unavailable");
      const verified = this.e2eControl.verifyAndConsume(rawEnvelope, wireSid);
      if (verified.kind === "secret.respond") {
        throw new E2EControlError("secret.respond is not supported by Claude Code");
      }
      const dispatch = dispatchForE2EControl(verified.kind, verified.payload);
      if (verified.kind === "command.invoke" && typeof dispatch.params.argsEnc === "string") {
        if (!this.e2e) throw new E2EControlError("E2E command decryptor unavailable");
        try {
          dispatch.params.args = this.e2e.decryptText(wireSid, dispatch.params.argsEnc);
          delete dispatch.params.argsEnc;
        } catch (error) {
          throw new E2EControlError("failed to decrypt authenticated command args", {
            cause: error,
          });
        }
      }
      const tagged: TaggedControlFrame = {
        t: "tui",
        sessionId: wireSid,
        frame: {
          jsonrpc: "2.0",
          method: dispatch.method,
          params: { session_id: wireSid, ...dispatch.params },
        },
        [AUTHENTICATED_E2E_CONTROL]: {
          kind: verified.kind,
          msgId: verified.envelope.msgId,
          envelope: verified.envelope,
        },
      };
      dispatchStarted = true;
      await this.onServerFrame(tagged);
      this.sendE2EControlResult(verified.envelope, wireSid, true);
    } catch (error) {
      console.error(`[E2E control rejected ${wireSid}]`, error instanceof Error ? error.message : String(error));
      this.sendE2EControlResult(
        rawEnvelope,
        wireSid,
        false,
        dispatchStarted ? "side_effect_failed" : "control_rejected",
      );
    }
  }

  async onServerFrame(msg: Record<string, unknown>): Promise<void> {
    if (msg.t !== "tui" || !msg.frame) return;
    const frame = msg.frame as { method?: string; params?: Record<string, unknown> };
    const params = frame.params ?? {};
    const outerSid = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
    const paramsSid = typeof params.session_id === "string" ? params.session_id : undefined;
    if (
      (msg.sessionId !== undefined && !outerSid) ||
      (params.session_id !== undefined && !paramsSid) ||
      (outerSid && paramsSid && outerSid !== paramsSid)
    ) {
      console.error(
        `[drive rejected] Link B outer/params session mismatch: ${String(msg.sessionId)} != ${String(params.session_id)}`,
      );
      return;
    }
    const sid = outerSid ?? paramsSid;
    if (!sid || !frame.method) return;
    let aliasOwner: string | undefined;
    try {
      aliasOwner = this.protectedInboundAliasOwner(sid);
    } catch (error) {
      console.error(
        `[E2E inbound quarantined ${sid}] ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (aliasOwner) {
      console.error(`[E2E local alias rejected ${sid}] canonical wire session is ${aliasOwner}`);
      return;
    }
    const authenticated = (msg as TaggedControlFrame)[AUTHENTICATED_E2E_CONTROL];
    if (frame.method === "e2e.control") {
      if (authenticated || !outerSid || !paramsSid) return;
      await this.onE2EControl(sid, params.envelope);
      return;
    }
    try {
      if (
        this.e2e?.isE2E(sid) &&
        E2E_SENSITIVE_METHODS.has(frame.method) &&
        authenticated === undefined
      ) {
        console.error(`[E2E legacy control rejected ${sid}] ${frame.method}`);
        return;
      }
      switch (frame.method) {
        case "prompt.submit": {
          let text = String(params.text ?? "").trim();
          // #73 語音優雅降級:Claude Code 無 STT。audio 附件立即回「未能轉錄」——否則 server 的
          // 「轉錄中…」占位永久卡住(2026-07-06 實測)。雲端 STT(BYOK)見 #89,屆時 server 側路由。
          const atts = Array.isArray(params.attachments) ? (params.attachments as Record<string, unknown>[]) : [];
          // E2E 附件没有端到端密文/完整性协议；在任何 STT、网络或落盘副作用前拒绝整帧。
          if (atts.length && this.e2e?.isE2E(sid)) {
            console.error(`[E2E prompt rejected ${sid}] attachments are not supported`);
            return;
          }
          const filePaths: string[] = [];
          const imageBlocks: unknown[] = [];
          for (const a of atts) {
            if (a?.kind === "audio" && a.id) {
              this.linkb.send({
                t: "voice_transcript",
                agentLinkId: this.linkb.agentLinkId,
                sessionId: sid,
                attachmentId: a.id,
                text: "",
                error: "stt_unavailable",
              });
              console.log(`· voice attachment ${a.id} → stt_unavailable (Claude Code has no STT)`);
            } else if (a?.url) {
              // #72 附件入站:下載落盤(SSRF 防護見 attachments.ts)。#118:小圖直接進 content
              // (原生 image block,視覺直達);超限/非圖/E2E → 路徑注入 prompt 供 Read 工具讀。
              try {
                const p = await materializeAttachment(a);
                const blk = this.e2e?.isE2E(sid) ? null : imageBlockFor(p, String(a.mime ?? ""));
                if (blk) imageBlocks.push(blk);
                else filePaths.push(p);
              } catch (e) {
                console.error(`[attachment ${String(a.id)} download failed] ${(e as Error).message}`);
              }
            }
          }
          // #237:E2E 先解密正文、再拼附件註記——順序反了會把明文註記餵進 GCM 驗證,
          // 整條 prompt(含附件)被靜默丟棄。附件-only(text 空)不走解密,註記本身即正文。
          if (this.e2e?.isE2E(sid) && text) {
            try {
              text = this.e2e.decryptText(sid, text).trim();
            } catch (e) {
              console.error(`[E2E prompt decrypt failed for ${sid}] ${(e as Error).message}`);
              // #279:靜默丟=用戶氣泡「已發送」卻永無回應。回 error 終態回合(僅提示語,
              // 零內容洩漏),用戶可見可重試;不把亂碼交給 agent 的語義不變。
              this.emit(sid, "message.start", {});
              this.emit(sid, "message.complete", { text: "", status: "error", warning: E2E_DECRYPT_FAIL_WARNING });
              return;
            }
          }
          if (filePaths.length) {
            const note = `[The user attached ${filePaths.length} file(s), read them with the Read tool: ${filePaths.join(", ")}]`;
            text = text ? `${text}\n\n${note}` : note;
          }
          if (!text && !imageBlocks.length) return;
          if (this.e2e?.isE2E(sid)) {
            if (!text) return;
            const arr = this.pendingUser.get(sid) ?? [];
            arr.push(text);
            this.pendingUser.set(sid, arr);
          }
          // #118 原生圖片:有圖 → content 塊數組(text 塊 + image 塊);純文本照舊字符串。
          const content: TurnContent = imageBlocks.length
            ? [...(text ? [{ type: "text", text }] : []), ...imageBlocks]
            : text;
          await this.dispatchContent(sid, content);
          return;
        }
        case "command.invoke": {
          // #199 命令/技能調用(composer / 菜單選中):拼 `/name args` 推進 input 流,CLI 原生
          // 攔截展開(skill 展開成 prompt 走正常模型回合;內建本地命令回合成 result,定稿照舊)。
          // E2E:invoke 幀本就明文(既定設計),命令文本記入 pendingUser 供回合末密文回灌。
          const name = String(params.command ?? "")
            .trim()
            .replace(/^\//, "");
          if (!name) return;
          const args = String(params.args ?? "").trim();
          const text = `/${name}${args ? ` ${args}` : ""}`;
          if (this.e2e?.isE2E(sid)) {
            const arr = this.pendingUser.get(sid) ?? [];
            arr.push(text);
            this.pendingUser.set(sid, arr);
          }
          const logText =
            authenticated && args ? `/${name} [encrypted args]` : text;
          console.log(`· command.invoke ${logText} → ${sid}`);
          await this.dispatchContent(sid, text, authenticated !== undefined);
          return;
        }
        case "session.interrupt": {
          const ch = this.channels.get(sid);
          if (!ch?.turn || ch.turn.completed) {
            if (authenticated) throw new E2EControlError("no active turn to interrupt");
            return;
          }
          this.interruptedSids.add(sid); // #102 隨後的 result(error) 定性為 interrupted
          await ch.q.interrupt(); // #116 g:interrupt 不殺通道,下一回合同通道照常
          // ⚠️ 回歸契約:scripts/regression/run-cc-regression.mjs 斷言「Interrupted turn for」,改動需同步
          console.log(`· Interrupted turn for ${sid}`);
          return;
        }
        case "session.e2e.disable": {
          if (authenticated?.kind !== "session.e2e.disable") {
            throw new E2EControlError("session.e2e.disable requires authenticated control");
          }
          if (!this.e2e || !this.mirror) {
            throw new E2EControlError("E2E disable dependencies unavailable");
          }
          this.assertE2EIdentitySafe();
          this.e2e.markServerE2E(sid, "disable");
          this.e2e.beginDisable(sid, authenticated.envelope);
          await this.mirror.backfillE2E(sid, this.localSessionIdFor(sid), "disable");
          return;
        }
        case "session.create": {
          const partial = authenticated !== undefined;
          // #105 upsert：登記/更新會話工作目錄（CC 會話本體仍由首次 prompt 的 init 建立）。
          // 草稿期改 cwd = server 重發本方法；不帶 cwd = 清回連接器默認。
          const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
          if (!partial || Object.hasOwn(params, "cwd")) {
            if (this.persistSessionSetting(this.cwds, sid, cwd, authenticated, "cwd")) {
              console.log(`· session.create ${sid} cwd=${cwd || "(default)"}`);
            }
          }
          // #98 權限檔(upsert;隨時可改,不像 cwd)。空/非法 = 清回 env 默認。
          const pm = typeof params.permissionMode === "string" ? params.permissionMode.trim() : "";
          const validPm = (UI_MODES as readonly string[]).includes(pm) ? pm : "";
          if ((!partial || Object.hasOwn(params, "permissionMode")) && validPm === "bypass" && !bypassAllowed()) {
            // #255 高危檔本地未開放:記下用戶意圖(降級在 resolvePerm 生效),操作者可設 env 開放。
            console.error(
              `[drive] ${sid} 請求 bypass 但本地未開放 → 降級 ask;要允許請設 MACCHIATO_CC_ALLOW_BYPASS=1`,
            );
          }
          if (!partial || Object.hasOwn(params, "permissionMode")) {
            if (
              this.persistSessionSetting(
                this.permModes,
                sid,
                validPm,
                authenticated,
                "permissionMode",
              )
            ) {
              console.log(`· session.create ${sid} permissionMode=${validPm || "(env default)"}`);
            }
          }
          // #143 model(upsert;隨時可改)。空 = 清回連接器默認(env / CLI 配置)。自由字符串——
          // 不校驗枚舉(支持別名 opus/sonnet/haiku 或完整 id),連接器只透傳。
          const md = typeof params.model === "string" ? params.model.trim() : "";
          if (!partial || Object.hasOwn(params, "model")) {
            if (this.persistSessionSetting(this.models, sid, md, authenticated, "model")) {
              console.log(`· session.create ${sid} model=${md || "(default)"}`);
            }
          }
          // #231 effort(upsert;隨時可改)。空 = 清回模型默認。自由字符串,連接器只透傳。
          const ef = typeof params.effort === "string" ? params.effort.trim() : "";
          if (!partial || Object.hasOwn(params, "effort")) {
            if (this.persistSessionSetting(this.efforts, sid, ef, authenticated, "effort")) {
              console.log(`· session.create ${sid} effort=${ef || "(default)"}`);
            }
          }
          // #98/#118/#143 cwd/權限/model 是通道創建參數:閒置通道立即重建生效;回合進行中的留給回合末。
          const ch = this.channels.get(sid);
          if (
            ch &&
            !ch.turn &&
            (ch.cwd !== this.cwdFor(sid) ||
              ch.permKey !== this.resolvePerm(sid).permKey ||
              ch.modelKey !== (this.resolveModel(sid) ?? "default") ||
              ch.effortKey !== (this.resolveEffort(sid) ?? "default"))
          ) {
            this.closeChannel(ch);
          }
          // 急校驗：壞目錄立刻回一行 system 提示（system 行不鎖 cwd，草稿仍可改），
          // 別等首條 prompt 才炸。E2E 跳過（不發明文行；startTurn 走加密回覆兜底）。
          if (cwd && !this.e2e?.isE2E(sid)) {
            const resolved = this.cwdFor(sid);
            if (!isDir(resolved)) {
              this.emit(sid, "review.summary", {
                summary: `⚠️ 工作目錄不存在或不是目錄：${resolved}（連接器主機上）`,
              });
            }
          }
          return;
        }
        case "session.archive":
          return; // #75:CC 無歸檔概念,顯式忽略(不落 default 靜默)
        case "session.delete": {
          // #161 墓碑:app 刪會話 → 鏡像永不再撈;不刪 CLI transcript(app 是遙控器,
          // 不該能燒掉主機的歷史)。server 側行已刪,這裡防「刪了又冒回來」。
          const cc = this.ccSidFor(sid) ?? (CC_UUID_RE.test(sid) ? sid : undefined);
          if (cc) this.mirror?.tombstone(cc);
          return;
        }
        case "session.rename": {
          // #161 手動改名回寫:app 改標題 → 寫回 CLI transcript(custom-title),終端側同名。
          const title = typeof params.title === "string" ? params.title.trim() : "";
          const cc = this.ccSidFor(sid);
          if (title && cc) void renameSession(cc, title).catch(() => {});
          return;
        }
        case "session.retitle": {
          // #94 後續:UI 發起「AI 重新命名」。讀該會話 transcript → 生成 → emit session.title。
          void this.retitleFromTranscript(sid);
          return;
        }
        case "task.stop": {
          // #97 停後台任務:channel.q.stopTask(taskId)。#118:通道長活,回合結束後後台任務仍可停。
          // 客戶端從展示行只拿得到 8 位短 id → 先在本會話進行中任務裡按前綴還原全 id。
          let taskId = String(params.taskId ?? "");
          const running = this.sessionTasks.get(sid);
          if (taskId && running && !running.has(taskId)) {
            const full = [...running].find((id) => id.startsWith(taskId));
            if (full) taskId = full;
          }
          if (authenticated && (!running || !running.has(taskId))) {
            throw new E2EControlError("no matching active task");
          }
          const cur = this.channels.get(sid)?.q;
          if (!cur || !taskId) {
            if (authenticated) throw new E2EControlError("no matching active task");
            return;
          }
          if (cur && taskId) {
            try {
              await (cur as unknown as { stopTask(id: string): Promise<void> }).stopTask(taskId);
              console.log(`· stopTask ${taskId} for ${sid}`);
            } catch (e) {
              console.error(`[task.stop ${taskId} failed] ${(e as Error).message}`);
              if (authenticated) throw e;
            }
          }
          return;
        }
        case "clarify.respond": {
          // #109:AskUserQuestion 單題答案(answer=所選 label;空串=跳過)。恆帶 request_id。
          const reqId = String(params.request_id ?? "");
          const pending = this.clarifies.get(reqId);
          if (!pending) {
            if (authenticated) throw new E2EControlError("no matching pending clarification");
            return;
          }
          if (authenticated && pending.sid !== sid) {
            throw new E2EControlError("clarification belongs to a different session");
          }
          if (
            authenticated &&
            (authenticated.kind !== "clarify.respond" ||
              !pending.requestDigest ||
              params.requestDigest !== pending.requestDigest)
          ) {
            throw new E2EControlError("clarification request id/digest mismatch");
          }
          let answer: string;
          if (authenticated) {
            const answerEnc = typeof params.answerEnc === "string" ? params.answerEnc : "";
            if (!this.e2e || !answerEnc) {
              throw new E2EControlError("authenticated clarification is missing ciphertext");
            }
            try {
              // answerEnc 是 K_S AES-GCM 密文；只有本地 connector 能解，server 永远看不到答案。
              answer = this.e2e.decryptText(sid, answerEnc);
            } catch (error) {
              throw new E2EControlError("failed to decrypt authenticated clarification", {
                cause: error,
              });
            }
          } else {
            answer = typeof params.answer === "string" ? params.answer : "";
          }
          this.clarifies.delete(reqId);
          pending.record(answer || null);
          return;
        }
        case "approval.respond": {
          const list = this.approvals.get(sid);
          if (!list?.length) {
            if (authenticated) throw new E2EControlError("no matching pending approval");
            return;
          }
          // #102:優先按 request_id 配對(server 開始回帶後端到端精準);缺省回退 FIFO(舊 server 兼容)。
          const reqId = typeof params.request_id === "string" ? params.request_id : "";
          const reqDigest = typeof params.requestDigest === "string" ? params.requestDigest : "";
          let pending: PendingApproval | undefined;
          if (authenticated) {
            if (authenticated.kind !== "approval.respond" || !reqId || !reqDigest) {
              throw new E2EControlError("authenticated approval is missing request identity");
            }
            const i = list.findIndex(
              (item) =>
                item.requestId === reqId &&
                item.requestDigest === reqDigest &&
                item.executionSnapshot !== undefined &&
                e2eApprovalRequestDigest(
                  this.e2e!.requireKey(sid),
                  item.executionSnapshot,
                ) === reqDigest,
            );
            if (i >= 0) pending = list.splice(i, 1)[0];
            if (!pending) throw new E2EControlError("approval request id/digest mismatch");
          } else {
            if (reqId) {
              const i = list.findIndex((p) => p.requestId === reqId);
              if (i >= 0) pending = list.splice(i, 1)[0];
            }
            pending ??= list.shift();
          }
          if (!pending) return;
          const choice = String(params.choice ?? "deny");
          const allow = choice === "allow" || choice === "always" || choice === "yes";
          const always = allow && (params.all === true || choice === "always");
          if (always) {
            // #238:記的是窄規則(suggestions 優先;無則工具級兜底),供通道重建回灌——
            // 不再維護工具名 Set(那會把單條命令的放行放大成整個工具)。
            const rules = ruleStringsFor(pending.suggestions, pending.toolName);
            const acc = this.alwaysRules.get(sid) ?? [];
            for (const r of rules) if (!acc.includes(r)) acc.push(r);
            this.alwaysRules.set(sid, acc);
          }
          pending.resolve(allow, always);
          return;
        }
        default:
          return;
      }
    } catch (e) {
      this.counters.driveErrors += 1; // #10
      console.error(`[drive ${frame.method} failed for ${sid}] ${(e as Error).message}`);
      if (authenticated) throw e;
    }
  }

  /** #105 會話工作目錄：per-session 下發值（~ 由此處展開）優先，回退 env/home 默認。 */
  private cwdFor(sid: string): string {
    const c = this.cwds[sid];
    if (!c) return workDir();
    if (c === "~") return homedir();
    return c.startsWith("~/") ? join(homedir(), c.slice(2)) : c;
  }

  /**
   * #118 起一回合:確保通道存在(閒置回收/cwd 變更後重建,resume 續上下文)→ 建 TurnCtx → push。
   * 同步執行(openChannel 到 turn 賦值之間無 await)——保證 consume 循環首條消息到達時 turn 已就緒。
   */
  private startTurn(
    sid: string,
    content: TurnContent,
    opts?: { retriedDelivery?: boolean; requireDelivery?: boolean },
  ): void {
    const isE2E = this.e2e?.isE2E(sid) ?? false;
    // #105 每回合校驗工作目錄(用戶手輸的可能有 typo,也可能事後被刪):不存在就回提示、不起回合——
    // CC 在壞 cwd 下的報錯難懂。提示走 system 行(review.summary),agent 沒有回覆過 → server 側
    // cwd 仍可改,用戶修正路徑後重發即可;E2E 走加密回覆(不發明文行)。
    const cwd = this.cwdFor(sid);
    if (!isDir(cwd)) {
      const errText = `⚠️ 工作目錄不存在或不是目錄：${cwd}（連接器主機上）。請修正會話目錄後重發。`;
      if (isE2E) this.sendE2ETurn(sid, errText);
      else this.emit(sid, "review.summary", { summary: errText });
      if (opts?.requireDelivery) throw new E2EControlError(errText);
      return;
    }
    let ch = this.channels.get(sid);
    // #98/#143 cwd/權限檔/model 變了 → 通道創建參數失效,重建(閒置通道立即,回合中的留到回合末)。
    if (
      ch &&
      (ch.closing ||
        ch.cwd !== cwd ||
        ch.permKey !== this.resolvePerm(sid).permKey ||
        ch.modelKey !== (this.resolveModel(sid) ?? "default") ||
        ch.effortKey !== (this.resolveEffort(sid) ?? "default"))
    ) {
      this.closeChannel(ch);
      ch = undefined;
    }
    const hadCc = !!this.ccSidFor(sid);
    if (!ch) ch = this.openChannel(sid, cwd);
    if (ch.idleTimer) {
      clearTimeout(ch.idleTimer);
      ch.idleTimer = undefined;
    }
    // #94：Macchiato 發起的會話(非 uuid)首回合(無映射)= 新對話 → **立即**用首條 user 文本生成
    // 標題(不等回合結束,越早越好——用戶剛發第一句、AI 還在想,標題就出來)。重啟安全(映射持久→
    // 有映射→不重生);E2E 跳過(明文洩漏);送達重投跳過(首投已生成緩存)。
    const isFirstMacchiatoTurn = !hadCc && !CC_UUID_RE.test(sid) && !isE2E;
    if (isFirstMacchiatoTurn && !opts?.retriedDelivery) void this.maybeTitle(sid, undefined, contentText(content));
    this.interruptedSids.delete(sid); // 新回合清舊標記
    ch.turn = {
      content,
      tools: new Map(),
      started: false,
      completed: false,
      seen: false,
      retried: !!opts?.retriedDelivery,
      acc: "",
      seenMsgIds: new Set(),
      isE2E,
      isFirstMacchiatoTurn,
      outputBase: 0,
      outputLive: 0,
      lastUsageEmitAt: 0,
      usageBaseline: null,
      sdkOutput: null,
      usageInFlight: false,
      lastSdkPollAt: 0,
      lastActivityAt: Date.now(), // #253
    };
    // #141b 回合起始快照 SDK session 累計 output 作基線(此刻本回合尚未產出 → 乾淨)。E2E 跳過。
    if (!isE2E) void this.snapshotUsageBaseline(ch, ch.turn);
    this.armTurnWatchdog(ch); // #253 起看門狗
    this.pending.add(sid); // #200 在途回合登記(進程死在此後 → 下次啟動提示重發)
    if (!this.saveMap() && isE2E) {
      // E2E 首回合若在 input.push 前連 pending 身份快照都落不了盤，CLI 一旦收件並換
      // session_id，重啟後就可能只剩「看似可信的舊 aliases」。因此不准交付 prompt。
      this.pending.delete(sid);
      this.clearTurnWatchdog(ch);
      ch.turn.completed = true;
      ch.turn = undefined;
      this.closeChannel(ch);
      this.fatalIdentityPersistence(
        `failed to persist Claude Code E2E turn identity before delivery (${sid})`,
      );
    }
    ch.input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "",
    });
  }

  /** #118 開通道:長活 query(streaming-input)+ 後台 consume 循環。 */
  private openChannel(sid: string, cwd: string): Channel {
    const resume = this.ccSidFor(sid);
    // 權限模式:MACCHIATO_CC_PERMISSION_MODE 設 bypassPermissions(全放行,不彈審批卡)/
    // acceptEdits 等 → 傳給 SDK(通道創建參數;#116:bypass 只能啟動時給,中途切換=重建通道)。
    // 提供 canUseTool 時 default/plan 的審批走它(#116 e/f:回調覆蓋 acceptEdits 自動批;bypass 不調)。
    // #98 per-session 權限:UI 檔映射(#116 探針)——ask/acceptEdits=default SDK 模式(編輯自動批在
    // canUseTool 內自實現)、plan=plan、bypass=bypassPermissions。回退 env 逃生門。
    const perm = this.resolvePerm(sid);
    const model = this.resolveModel(sid); // #143 per-session model(回退 env);undefined = CLI 默認
    const effort = this.resolveEffort(sid); // #231 per-session effort;undefined = 模型默認
    const input = new PushStream<unknown>();
    const q = query({
      prompt: input as AsyncIterable<never>,
      options: {
        cwd, // #105 per-session 工作目錄（cwdFor 已解析，回退連接器默認）
        ...(resume ? { resume } : {}),
        ...(claudeBinIsAbsolute() ? { pathToClaudeCodeExecutable: resolveClaudeBin() } : {}),
        ...(model ? { model } : {}), // #143 per-session model(空 = 不傳,用 CLI 配置默認)
        ...(effort ? { effort: effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}), // #231
        ...(perm.sdk ? { permissionMode: perm.sdk } : {}),
        // #238:通道重建時回灌「總是允許」的窄規則(活通道由 updatedPermissions 即時生效,
        // 但閒置回收後 SDK session 規則隨進程消亡——這裡是跨重建的持久層)。
        ...(this.alwaysRules.get(sid)?.length
          ? { settings: { permissions: { allow: [...this.alwaysRules.get(sid)!] } } }
          : {}),
        includePartialMessages: true,
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
          // #102 SDK 給的審批上下文:toolUseID(配對鍵)、suggestions(「總是允許」的原生規則,SDK 文檔
          // 明示應原樣回作 updatedPermissions)、title/description(現成的審批文案,優於自拼)。
          opts?: { toolUseID?: string; suggestions?: PermissionUpdate[]; title?: string; description?: string },
        ) => {
          // #109 AskUserQuestion 不是審批是提問:走 clarify 卡收答案,經 updatedInput.answers 回帶
          // (探針驗證:AskUserQuestionInput 頂層有可選 answers,填上即出「questions answered」tool_result)。
          if (toolName === "AskUserQuestion") return await this.requestAnswers(sid, input, opts?.toolUseID);
          // #238:「總是允許」不再在此按工具名短路——窄規則由 SDK 自行匹配(活通道經
          // updatedPermissions、重建通道經 settings.permissions.allow),命中就不會進 canUseTool。
          // #98 acceptEdits 檔:文件編輯類自動批(SDK acceptEdits 被 canUseTool 覆蓋,故此處自實現)。
          if (perm.editAuto && EDIT_TOOLS.has(toolName)) return { behavior: "allow" as const, updatedInput: input };
          return await this.requestApproval(sid, toolName, input, opts);
        },
      },
    });
    const ch: Channel = { sid, cwd, permKey: perm.permKey, modelKey: model ?? "default", effortKey: effort ?? "default", input, q, closing: false };
    this.channels.set(sid, ch);
    void this.consume(ch);
    return ch;
  }

  /** #118 通道消費循環:活到 close/crash;逐條路由;結束後統一收尾。 */
  private async consume(ch: Channel): Promise<void> {
    let err: Error | undefined;
    try {
      for await (const m of ch.q as AsyncIterable<any>) {
        this.handleMessage(ch, m);
      }
    } catch (e) {
      err = e as Error;
      this.counters.turnErrors += 1; // #10
    }
    this.onChannelEnd(ch, err);
  }

  /** 首個非 E2E 事件 → message.start(每回合一次)。 */
  private startMsg(sid: string, turn: TurnCtx): void {
    if (turn.started || turn.isE2E) return;
    turn.started = true;
    this.emit(sid, "message.start", {});
  }

  /**
   * #141 節流上報累計 output tokens。默認 ~700ms 一次防刷屏;`force=true`(子消息邊界)立即發一次
   * 確保跨步進位不丟。E2E 跳過(web 鎖住,且保守不外露任何回合信號)。
   * #141b 值以 SDK 運行時 usage 為權威(session 累計 − 回合基線,**含 subagent**);拿不到則退回本地累加。
   */
  private emitTurnUsage(ch: Channel, sid: string, turn: TurnCtx, force = false): void {
    if (turn.isE2E) return;
    const now = Date.now();
    if (!force && now - turn.lastUsageEmitAt < 700) return;
    turn.lastUsageEmitAt = now;
    this.emit(sid, "turn.usage", { output_tokens: this.turnOutput(turn) });
    this.pollSdkUsage(ch, sid, turn); // 異步刷新 SDK 聚合(含 subagent),回來再補發一版更準的
  }

  /**
   * #141b 本回合 output tokens：優先 SDK 聚合增量(sdkOutput − 基線,含 subagent),疊加當前在飛子消息
   * outputLive 保持平滑。`max(sdkΔ, outputBase)` 兜住「主 agent 子消息剛完成、SDK 輪詢尚未回」的空窗;
   * SDK 不可用(基線/輪詢為 null)時退回純本地累加 outputBase+outputLive(= 舊行為)。
   */
  private turnOutput(turn: TurnCtx): number {
    const sdkDelta =
      turn.usageBaseline !== null && turn.sdkOutput !== null ? Math.max(turn.sdkOutput - turn.usageBaseline, 0) : 0;
    return Math.max(sdkDelta, turn.outputBase) + turn.outputLive;
  }

  /** #141b 回合起始快照 session 累計 output 作基線;接口不可用則保持 null(整回合退回本地累加)。 */
  private async snapshotUsageBaseline(ch: Channel, turn: TurnCtx): Promise<void> {
    const total = await this.sdkOutputTotal(ch);
    if (total !== null && !turn.completed && turn.usageBaseline === null) turn.usageBaseline = total;
  }

  /** #141b 節流(1.2s)+ 防並發地輪詢 SDK 運行時 usage → 更新 sdkOutput 並補發一版 turn.usage。
   *  無基線(接口不可用/未取到)則不輪詢——沒有基線算不出本回合增量,純走本地累加。 */
  private pollSdkUsage(ch: Channel, sid: string, turn: TurnCtx): void {
    if (turn.usageBaseline === null || turn.usageInFlight || turn.completed) return;
    const now = Date.now();
    if (now - turn.lastSdkPollAt < 1200) return; // 實驗接口 + 可能取 rate_limit,節流緩一點
    turn.lastSdkPollAt = now;
    turn.usageInFlight = true;
    void (async () => {
      const total = await this.sdkOutputTotal(ch);
      turn.usageInFlight = false;
      if (total === null || turn.completed || turn.isE2E) return;
      turn.sdkOutput = total;
      this.emit(sid, "turn.usage", { output_tokens: this.turnOutput(turn) });
    })();
  }

  /**
   * #141b SDK 運行時 usage(experimental)→ session 累計 output_tokens(所有 model 求和,**含 subagent**)。
   * 接口實驗性(方法名帶 DO_NOT_RELY,可能改名/移除)→ 特性探測 + try/catch,任何失敗返回 null 走本地兜底。
   */
  private async sdkOutputTotal(ch: Channel): Promise<number | null> {
    try {
      const q = ch.q as unknown as {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<{
          session?: { model_usage?: Record<string, { outputTokens?: number }> };
        }>;
      };
      const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof fn !== "function") return null;
      const u = await fn.call(q);
      const mu = u?.session?.model_usage;
      if (!mu || typeof mu !== "object") return null;
      let sum = 0;
      for (const mUsage of Object.values(mu)) {
        const o = mUsage?.outputTokens;
        if (typeof o === "number" && isFinite(o)) sum += o;
      }
      return sum;
    } catch {
      return null; // 接口不可用/報錯 → 退回本地累加,絕不拖垮回合
    }
  }

  private handleMessage(ch: Channel, m: any): void {
    const sid = ch.sid;
    const turn = ch.turn;
    if (turn && !turn.completed) {
      turn.seen = true; // 送達確認(#116 b)
      turn.lastActivityAt = Date.now(); // #253 看門狗續期:有事件 = 沒卡
    }
    const isE2E = turn?.isE2E ?? this.e2e?.isE2E(sid) ?? false;

    if (m.type === "system" && m.subtype === "init" && typeof m.session_id === "string") {
      // #118:streaming 模式每回合一個 init。首回合據此存映射;每回合 setDriven(live 獨佔投遞)。
      const currentLocalSid =
        this.map[sid] ?? (CC_UUID_RE.test(sid) ? sid : undefined);
      if (!currentLocalSid) {
        this.map[sid] = m.session_id;
        this.rememberLocalSessionId(sid, m.session_id);
        if (!this.saveMap() && isE2E) {
          this.fatalIdentityPersistence(
            `failed to persist Claude Code E2E identity for ${sid} (${m.session_id})`,
          );
        }
      } else if (currentLocalSid !== m.session_id) {
        // #266/#347:CLI resume/fork 可能換 uuid。map 跟隨當前 transcript，aliases 永久保留
        // 舊、新 uuid 的共同 wire 身份（wire 本身是 UUID 也一樣）；先同步內存，再立即雙份持久，
        // import/mirror 不得出現明文窗口。
        const previous = currentLocalSid;
        this.rememberLocalSessionId(sid, previous);
        this.rememberLocalSessionId(sid, m.session_id);
        this.map[sid] = m.session_id;
        if (!this.saveMap()) {
          this.fatalIdentityPersistence(
            `failed to persist Claude Code identity rotation for ${sid} ` +
              `(${previous} -> ${m.session_id})`,
          );
        }
        this.counters.initMapMismatch = (this.counters.initMapMismatch ?? 0) + 1;
        console.error(
          `[#266 init session_id 不一致 sid=${sid} 舊=${previous} 新=${m.session_id}` +
            "（CLI fork/resume?）——已切換當前映射並持久保留兩個 alias]",
        );
      }
      this.mirror?.setDriven(m.session_id); // 本回合 live 獨佔(per-turn)
      this.mirror?.markDrivenUuid(m.session_id); // 影子兜底:永久登記此 CLI uuid 為「被驅動過」
      // #201 每回合一個 init。若此刻無 active turn(上個回合已 done、通道閒置)——說明這是子任務完成後
      // SDK 自動喚醒 agent 的續寫回合(無 prompt.submit)。建合成 turn 接住,否則後續內容被 !turn 丟棄。
      // 正常回合:startTurn 已同步建好 ch.turn(見其註),故此處 !ch.turn 為假、不觸發。
      if (!ch.turn && !ch.closing) this.startContinuationTurn(ch);
      return;
    }
    // #97 後台任務(subagent + run_in_background bash 統一走 task_*):展示進度/完成。E2E 會話
    // 跳過(避免明文洩漏);ambient/housekeeping 任務隱藏。#118:可在回合間到達(不依賴 turn)。
    if (m.type === "system" && typeof m.subtype === "string" && m.subtype.startsWith("task")) {
      // E2E 只抑制展示，仍需內部追蹤 task 生命周期，否則 #212 的 idle 保護會失效。
      this.handleTaskEvent(sid, m, !isE2E);
      return;
    }
    // #199 命令清單變更(agent 進子目錄動態發現新 skill 等):SDK 明示載荷是整份新清單,
    // 直接替換上報(supportedCommands 重調只會拿到 init 舊快照)。
    if (m.type === "system" && m.subtype === "commands_changed") {
      if (Array.isArray(m.commands)) this.commands?.update(m.commands);
      return;
    }
    // #102 壓縮可見化:長會話自動/手動壓縮不再是無解釋停頓。
    if (m.type === "system" && m.subtype === "compact_boundary") {
      if (!isE2E) {
        const meta = m.compact_metadata ?? {};
        const trig = meta.trigger === "manual" ? "手動" : "自動";
        const toks = typeof meta.pre_tokens === "number" ? `,壓縮前 ~${meta.pre_tokens} tokens` : "";
        this.emit(sid, "review.summary", { summary: `📦 上下文已壓縮(${trig}${toks})` });
      }
      return;
    }
    if (m.type === "system" && m.subtype === "status") {
      // 只提示 compacting;requesting/null 太碎,靜默。
      if (!isE2E && m.status === "compacting") this.emit(sid, "review.summary", { summary: "📦 正在壓縮上下文…" });
      return;
    }
    // #102 API 重試可見化(限流/過載時用戶不再乾等)。
    if (m.type === "system" && m.subtype === "api_retry") {
      if (!isE2E) {
        const http = m.error_status ? `,HTTP ${m.error_status}` : "";
        this.emit(sid, "review.summary", { summary: `🔁 API 重試中 (${m.attempt}/${m.max_retries}${http})` });
      }
      return;
    }
    // #102 權限規則層拒絕(不經 canUseTool)此前完全隱形。
    if (m.type === "system" && m.subtype === "permission_denied") {
      if (!isE2E) {
        const why = m.message ? `:${String(m.message).slice(0, 200)}` : "";
        this.emit(sid, "review.summary", { summary: `🚫 工具 ${m.tool_name ?? "?"} 被權限規則拒絕${why}` });
      }
      return;
    }
    if (m.type === "stream_event") {
      if (!turn || turn.completed) return; // 回合外的流事件(不應有)——丟棄
      const ev = m.event ?? {};
      if (ev.type === "content_block_delta") {
        const d = ev.delta ?? {};
        if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
          this.startMsg(sid, turn);
          turn.acc += d.text;
          if (!turn.isE2E) this.emit(sid, "message.delta", { text: d.text });
        } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking && !turn.isE2E) {
          this.startMsg(sid, turn);
          this.emit(sid, "reasoning.delta", { text: d.thinking });
        }
      } else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        const b = ev.content_block;
        const id = String(b.id ?? "");
        turn.tools.set(id, { name: String(b.name ?? "tool"), argsText: "" });
        this.startMsg(sid, turn);
        if (!turn.isE2E) this.emit(sid, "tool.start", { tool_id: id, name: String(b.name ?? "tool") });
      } else if (ev.type === "message_delta") {
        // #141 當前子消息的累積 output_tokens(Anthropic 流式標準:message_delta.usage 累加)。
        const ot = ev.usage?.output_tokens;
        if (typeof ot === "number") {
          turn.outputLive = ot;
          this.emitTurnUsage(ch, sid, turn);
        }
      }
      return;
    }
    if (m.type === "assistant") {
      if (!turn || turn.completed) return;
      // #318 記本回合 live 覆蓋的 API message.id(mirror 據此吞晚落盤殘片,防雙投)。
      if (typeof m.message?.id === "string") turn.seenMsgIds.add(m.message.id);
      // #102 API 級錯誤分類(authentication_failed/billing_error/rate_limit/overloaded…)留給失敗行
      if (typeof m.error === "string") turn.lastError = m.error;
      // #141 子消息完成:把其最終 output_tokens 折進 base、清 live(下個子消息 message_delta 重新累)。
      const ot = m.message?.usage?.output_tokens;
      if (typeof ot === "number") {
        turn.outputBase += ot;
        turn.outputLive = 0;
        this.emitTurnUsage(ch, sid, turn, true);
      }
      // 完整 assistant API 消息：補齊 tool_use 的 args（deltas 裡是分片 json）
      for (const b of m.message?.content ?? []) {
        if (b?.type === "tool_use" && typeof b.id === "string" && turn.tools.has(b.id)) {
          turn.tools.get(b.id)!.argsText = JSON.stringify(b.input ?? {});
        }
      }
      return;
    }
    if (m.type === "user") {
      if (!turn || turn.completed) return;
      for (const b of m.message?.content ?? []) {
        if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const t = turn.tools.get(b.tool_use_id);
        if (!t || turn.isE2E) continue;
        const resultText =
          typeof b.content === "string"
            ? b.content
            : (Array.isArray(b.content) ? b.content : [])
                .filter((x: any) => x?.type === "text")
                .map((x: any) => x.text)
                .join("");
        // #384 後台任務啟動回執裡帶 output 文件路徑——記下來,task_notification 時讀真輸出作 report
        this.captureTaskOutputFile(String(resultText));
        this.emit(sid, "tool.complete", {
          tool_id: b.tool_use_id,
          name: t.name,
          args: this.safeArgs(t.argsText),
          result: null,
          result_text: String(resultText).slice(0, 20_000),
        });
      }
      return;
    }
    if (m.type === "result") {
      if (!turn || turn.completed) return; // 回合外的 stray result——丟棄
      this.finishTurn(ch, turn, m);
      return;
    }
    // #102 兜底:SDKMessage union 37 個成員只處理上面一小撮,其餘曾靜默丟棄=SDK 升級漂移無感知。
    // 每種 (type/subtype) 進程內只記一次,帶採樣 JSON。
    const key = `${m.type}/${m.subtype ?? ""}`;
    if (!this.loggedUnknown.has(key)) {
      this.loggedUnknown.add(key);
      console.log(`[drive] 未處理的 SDK 消息 ${key}(首次,已忽略): ${JSON.stringify(m).slice(0, 400)}`);
    }
  }

  /**
   * #201 SDK 自發喚醒的續寫回合:子任務(Task 子代理/後台)完成 → SDK 注入 `<task-notification>` 把
   * agent 叫回來續寫。這種回合**沒有 prompt.submit**(無 user content),原本 handleMessage 的 `!turn`
   * 分支會把它的 assistant/流/result 全丟(2026-07-13 實測:一份寫好的設計被扔、既不投 live 也不鏡像
   * ——driven 會話鏡像本就跳過)。建一個合成 turn 讓內容照常走 message.start→delta→complete 投成一條新
   * agent 消息。清舊閒置計時(防它 mid-回合關通道)、進 #200 pending;seen=true(非用戶投遞,無送達確認
   * /重投語義)、isFirstMacchiatoTurn=false(不生成標題)。driven 會話鏡像跳過 → 這條是唯一路、不雙投。
   */
  private startContinuationTurn(ch: Channel): void {
    const sid = ch.sid;
    if (ch.idleTimer) {
      clearTimeout(ch.idleTimer);
      ch.idleTimer = undefined;
    }
    ch.turn = {
      content: "",
      tools: new Map(),
      started: false,
      completed: false,
      seen: true,
      retried: false,
      acc: "",
      seenMsgIds: new Set(),
      isE2E: this.e2e?.isE2E(sid) ?? false,
      isFirstMacchiatoTurn: false,
      outputBase: 0, // #141
      outputLive: 0,
      lastUsageEmitAt: 0,
      usageBaseline: null,
      sdkOutput: null,
      usageInFlight: false,
      lastSdkPollAt: 0,
      lastActivityAt: Date.now(), // #253
    };
    if (!ch.turn.isE2E) void this.snapshotUsageBaseline(ch, ch.turn); // #141b 基線快照
    this.armTurnWatchdog(ch); // #253 合成回合也上看門狗(無後續內容 → 判卡收尾,不永久卡 pending)
    this.pending.add(sid); // #200 在途回合登記
    this.saveMap();
    console.log(`· ${sid} SDK 自發續寫回合(子任務完成自動喚醒)→ 建合成 turn 投遞`);
  }

  /** #118 回合定稿(result 到):message.complete + 鏡像快進 + 續投排隊/閒置計時。 */
  private finishTurn(ch: Channel, turn: TurnCtx, m: any): void {
    const sid = ch.sid;
    turn.completed = true;
    this.clearTurnWatchdog(ch); // #253
    this.projects?.checkTurnEnd(); // #227 agent 可能在本回合改了 AGENTS.md → 惰性落版本
    const interrupted = this.interruptedSids.delete(sid);
    const isErr = m.subtype !== "success" || m.is_error === true;
    // #310 認證失效偵測:auth 類失敗置持續態(health 上報 authOk=false → app 顯降級);成功回合恢復。
    const authErr = isErr && /authenticat/i.test([turn.lastError ?? "", ...(Array.isArray(m.errors) ? m.errors.map(String) : [])].join(" "));
    if (authErr) this.authFailed = true;
    else if (!isErr) this.authFailed = false;
    // #102 status:協議 MessageCompletePayload 本就有(server 已消費 done/interrupted/error);
    // 此前不發 → 失敗回合對用戶靜默成「正常結束」。
    const status = isErr ? (interrupted ? "interrupted" : "error") : "complete";
    const finalText: string = typeof m.result === "string" && m.result ? m.result : turn.acc;
    // #102 usage/cost 上行(協議字段現成;server 落庫/UI 展示為 server/web 側後續)。
    const usage: Record<string, unknown> = {
      ...(m.usage && typeof m.usage === "object" ? m.usage : {}),
      ...(typeof m.total_cost_usd === "number" ? { total_cost_usd: m.total_cost_usd } : {}),
      ...(typeof m.num_turns === "number" ? { num_turns: m.num_turns } : {}),
      ...(typeof m.duration_ms === "number" ? { duration_ms: m.duration_ms } : {}),
      ...(m.modelUsage && typeof m.modelUsage === "object" ? { models: Object.keys(m.modelUsage) } : {}),
    };
    if (turn.isE2E) {
      this.sendE2ETurn(sid, finalText);
    } else {
      // #102 失敗回合(非用戶中斷)給一條可讀錯誤行:subtype + assistant.error 分類 + 首條 errors[]
      if (isErr && !interrupted) {
        const detail = [
          typeof m.subtype === "string" && m.subtype !== "success" ? m.subtype : "",
          turn.lastError ?? "",
          ...(Array.isArray(m.errors) ? m.errors.slice(0, 1).map(String) : []),
        ]
          .filter(Boolean)
          .join(" · ");
        // #310 auth 失敗給可行動文案(而非裸分類串,用戶不知道要去終端 /login)
        this.emit(sid, "review.summary", {
          summary: authErr
            ? "❌ Claude Code 登錄已失效——請在連接器主機終端跑 `claude /login` 重新登錄後重試"
            : `❌ 回合失敗${detail ? `(${detail.slice(0, 200)})` : ""}`,
        });
      }
      this.startMsg(sid, turn);
      this.emit(sid, "message.complete", { text: finalText, status, usage });
    }
    // 懸而未決的審批一律拒（回合都結束了）
    for (const p of this.approvals.get(sid) ?? []) p.resolve(false, false);
    this.approvals.delete(sid);
    const cc = this.ccSidFor(sid);
    if (cc) {
      // #318 把本回合 live 覆蓋的 message.id 交給 mirror:fastForward 吞不掉的晚落盤殘片(SDK result
      // 早於 CLI 寫完 transcript 尾巴)由此精確攔截,不再作為「終端新活動」補投成重複。順序在 fastForward
      // 前登記,確保解除 driven 後恢復鏡像時集合已就位。
      if (turn.seenMsgIds.size) this.mirror?.markLivePosted(cc, turn.seenMsgIds);
      this.mirror?.fastForward(cc); // live 已投遞 → 鏡像水位線快進越過本回合
      this.mirror?.unsetDriven(cc); // 僅回合級跳過：解除後終端側活動恢復鏡像（CC 無 gateway,鏡像是唯一路）
    }
    // #94：標題已在回合開頭立即生成(見 startTurn),此處不重複。回合末補寫回 transcript
    // (終端也見同一標題;ccSid 此時已建立)——只寫回,不重新生成(genTitle 由早期生成緩存)。
    const gt = this.genTitle.get(sid); // #266 per-sid,不再被並發首回合互相覆蓋
    if (turn.isFirstMacchiatoTurn && cc && gt) {
      void renameSession(cc, gt).catch(() => {});
      this.genTitle.delete(sid);
    }
    ch.turn = undefined;
    this.pending.delete(sid); // #200 回合正常收尾 → 出在途集(有續投則 startTurn 再加回)
    this.saveMap();
    // 排隊的後續 prompt → 同通道續投(startTurn 自檢 cwd 變更);沒有 → 閒置計時回收。
    const next = this.queued.get(sid)?.shift();
    if (!this.queued.get(sid)?.length) this.queued.delete(sid);
    if (next !== undefined) {
      this.startTurn(sid, next);
      return;
    }
    if (ch.cwd !== this.cwdFor(sid)) {
      this.closeChannel(ch); // #105 回合中 cwd 被改 → 回合末重建生效
      return;
    }
    this.scheduleIdleClose(ch);
  }

  /** #118 通道結束(close/crash 後的統一收尾):未完回合定性;送達重投;續投排隊。 */
  private onChannelEnd(ch: Channel, err?: Error): void {
    const sid = ch.sid;
    if (this.channels.get(sid) === ch) this.channels.delete(sid);
    if (ch.idleTimer) {
      clearTimeout(ch.idleTimer);
      ch.idleTimer = undefined;
    }
    this.clearTurnWatchdog(ch); // #253
    const turn = ch.turn;
    ch.turn = undefined;
    this.pending.delete(sid); // #200 通道收尾 → 出在途集(下面若走送達重投,startTurn 會再加回)
    this.saveMap();
    if (turn && !turn.completed) {
      // 送達確認(#116 b):push 後 CLI 未及處理(未見任何事件)即死 → 重投一次(新通道 resume)。
      // 已見事件的回合:user 消息已落 transcript(#116 b 實測),重投=雙投,只能定稿 error。
      if (err && !turn.seen && !turn.retried) {
        console.error(`[channel died before delivery for ${sid}] ${err.message} → 重投一次`);
        this.startTurn(sid, turn.content, { retriedDelivery: true });
        return;
      }
      console.error(`[turn failed for ${sid}] ${err?.message ?? "channel closed mid-turn"}`);
      const interrupted = this.interruptedSids.delete(sid);
      if (turn.isE2E) {
        // #266 E2E 通道崩潰也要定稿:走加密批(user 消息 + 已累積回覆/錯誤註記),並清 pendingUser——
        // 此前只走非 E2E 分支、pendingUser 不清,用戶消息滯留、隨下個成功回合的加密批串出去。
        this.sendE2ETurn(sid, turn.acc || `(error: ${err?.message ?? "channel closed"})`);
      } else {
        this.startMsg(sid, turn);
        this.emit(sid, "message.complete", {
          text: turn.acc || `(error: ${err?.message ?? "channel closed"})`,
          status: interrupted ? "interrupted" : "error",
          usage: {},
        });
      }
      for (const p of this.approvals.get(sid) ?? []) p.resolve(false, false);
      this.approvals.delete(sid);
      // #109 懸掛的 AskUserQuestion 單題:record(null) 令組內計數歸零、canUseTool 以無答案解掛
      // (通道已死,resolve 結果無人消費,但清掉防 map 泄漏)。
      for (const [reqId, c] of this.clarifies) {
        if (c.sid === sid) {
          this.clarifies.delete(reqId);
          c.record(null);
        }
      }
      const cc = this.ccSidFor(sid);
      if (cc) {
        this.mirror?.fastForward(cc);
        this.mirror?.unsetDriven(cc);
      }
    }
    // 通道死了但還有排隊 → 繼續(startTurn 會開新通道 resume)。
    const next = this.queued.get(sid)?.shift();
    if (!this.queued.get(sid)?.length) this.queued.delete(sid);
    if (next !== undefined) this.startTurn(sid, next);
  }

  /** #118 關通道:回收 CLI 進程(閒置/變更 cwd/dispose)。consume 循環隨後自然結束。 */
  private closeChannel(ch: Channel): void {
    ch.closing = true;
    if (ch.idleTimer) {
      clearTimeout(ch.idleTimer);
      ch.idleTimer = undefined;
    }
    if (this.channels.get(ch.sid) === ch) this.channels.delete(ch.sid);
    try {
      ch.input.close();
    } catch {
      /* 重複 close 無害 */
    }
  }

  /** 回合開頭生成的標題(緩存供回合末寫回 transcript;避免二次生成)。 */
  /** #266 sid → 早期生成的標題(回合末寫回 transcript 用)。此前是實例級單欄位,多會話並發
   * 首回合互相覆蓋 → 錯標題被 renameSession 寫回另一會話。改 per-sid Map。 */
  private readonly genTitle = new Map<string, string>();

  /** #94：立即用首條 user 文本生成標題 → emit session.title(server 更新)。ccSid 有則順帶寫回 transcript。 */
  private async maybeTitle(sid: string, ccSid: string | undefined, firstUserText: string): Promise<void> {
    try {
      const title = await generateTitle(firstUserText);
      if (!title) return;
      this.genTitle.set(sid, title); // 供回合末寫回 transcript(首回合時 ccSid 尚未建立)
      this.emit(sid, "session.title", { title });
      if (ccSid) {
        try {
          await renameSession(ccSid, title);
        } catch {
          /* 寫回 transcript 失敗不致命(session.title 已發給 server) */
        }
      }
      console.log(`· 生成標題「${title}」→ ${sid}`);
    } catch (e) {
      console.error(`[title gen failed for ${sid}] ${(e as Error).message}`);
    }
  }

  /**
   * #94 後續:UI 發起 AI 重新命名。讀該會話的 transcript 首條真人消息 → generateTitle → session.title。
   * 對鏡像會話(uuid sid=CC session id)與 Macchiato 會話(映射到 cc sid)都適用;E2E 跳過(防洩漏)。
   */
  private async retitleFromTranscript(sid: string): Promise<void> {
    if (this.e2e?.isE2E(sid)) return;
    try {
      const cc = this.ccSidFor(sid);
      if (!cc) return;
      const file = discoverSessions().find((s) => s.sid === cc)?.file;
      if (!file) {
        console.error(`[retitle] 找不到 ${cc} 的 transcript`);
        return;
      }
      const { entries, endOffset } = readEntries(file, 0);
      const { messages } = foldEntries(entries, endOffset, Number.MAX_SAFE_INTEGER);
      const firstUser = messages.find((m) => m.role === "user")?.text;
      if (!firstUser) return;
      const title = await generateTitle(firstUser);
      if (!title) return;
      this.emit(sid, "session.title", { title });
      try {
        await renameSession(cc, title);
      } catch {
        /* 寫回 transcript 失敗不致命 */
      }
      console.log(`· AI 重新命名「${title}」→ ${sid}`);
    } catch (e) {
      console.error(`[retitle failed for ${sid}] ${(e as Error).message}`);
    }
  }

  /**
   * canUseTool → approval.request，掛起等 approval.respond。
   * #102:payload 帶 request_id(=SDK toolUseID);respond 回帶則精準配對,缺省 FIFO(舊 server 兼容)。
   * #238「總是允許」優先回 SDK 給的 suggestions(原生窄規則,SDK 文檔明示的用法);沒有則退化
   * addRules destination:"session"(工具級)。跨通道重建的持久化走 alwaysRules →
   * settings.permissions.allow 回灌;不再有按工具名短路的本地 Set。
   */
  private requestApproval(
    sid: string,
    toolName: string,
    input: Record<string, unknown>,
    opts?: { toolUseID?: string; suggestions?: PermissionUpdate[]; title?: string; description?: string },
  ): Promise<PermissionResult> {
    const e2e = this.e2e?.isE2E(sid) ?? false;
    const requestId = opts?.toolUseID || (e2e ? randomUUID() : undefined);
    let executionSnapshot: ClaudeApprovalExecutionSnapshot | undefined;
    let executionDisplay: string | undefined;
    if (e2e && requestId) {
      try {
        executionSnapshot = immutableE2EApprovalSnapshot<ClaudeApprovalExecutionSnapshot>({
          v: 1,
          connector: "claude-code",
          sessionId: sid,
          requestId,
          toolName,
          input,
        });
        executionDisplay = canonicalE2EApprovalDisplay(executionSnapshot);
      } catch (error) {
        console.error(
          `[E2E approval auto-denied ${sid}] ${error instanceof Error ? error.message : String(error)}`,
        );
        return Promise.resolve({
          behavior: "deny",
          message: "E2E approval request cannot be displayed safely",
        });
      }
    }
    // E2E 下所有展示与获批后的 updatedInput 都从快照取值；调用方随后修改 input 无效。
    const approvedInput = executionSnapshot?.input ?? input;
    // #99 Plan 模式:ExitPlanMode 經此橋;input.plan=計劃全文 → 作卡片正文(而非工具名+JSON)。
    const isPlan = toolName === "ExitPlanMode";
    const planText =
      isPlan && typeof approvedInput.plan === "string" ? approvedInput.plan : "";
    const argsPreview = JSON.stringify(approvedInput).slice(0, 500);
    const command = isPlan ? "Approve plan and start execution" : opts?.title || `${toolName} ${argsPreview}`;
    const description = isPlan ? planText.slice(0, 8000) : opts?.description || `Claude Code wants to use ${toolName}`;
    // #240 E2E:命令/說明/計劃全文加密進 enc,明文只留占位 + pattern_key(工具名)+ request_id;
    // server 盲存密文、不落明文,iOS 用 K_S 解密渲染。完整执行请求一并置于密文，
    // requestDigest 不再依赖 500 字预览；E2E 当前只接受单次 yes/no。
    const requestDigest =
      executionSnapshot
        ? e2eApprovalRequestDigest(this.e2e!.requireKey(sid), executionSnapshot)
        : undefined;
    const approvalPlaintext = e2e
      ? {
          command,
          description,
          patternKey: toolName,
          ...(isPlan ? { plan: planText.slice(0, 20000) } : {}),
          requestId,
          requestDigest,
          executionRequest: executionSnapshot,
          executionDisplay,
        }
      : undefined;
    if (
      approvalPlaintext
      && Buffer.byteLength(JSON.stringify(approvalPlaintext), "utf8")
        > E2E_APPROVAL_PLAINTEXT_MAX_BYTES
    ) {
      console.error(
        `[E2E approval auto-denied ${sid}] encrypted approval payload exceeds device limit`,
      );
      return Promise.resolve({
        behavior: "deny",
        message: "E2E approval request cannot be displayed safely",
      });
    }
    // 尺寸闸门必须先于 emit / approvals.push；否则设备拒绝卡片后 canUseTool 会永久挂起。
    const encPayload = approvalPlaintext
      ? this.e2e!.encryptContent(sid, approvalPlaintext)
      : undefined;
    this.emit(sid, "approval.request", {
      command: e2e ? "🔒 加密審批請求" : command,
      pattern_key: toolName,
      pattern_keys: [toolName],
      description: e2e ? "" : description,
      ...(!e2e && isPlan ? { plan: planText.slice(0, 20000) } : {}),
      ...(encPayload ? { enc: encPayload } : {}),
      ...(requestId ? { request_id: requestId } : {}),
      ...(requestDigest ? { request_digest: requestDigest } : {}),
    });
    return new Promise((resolve) => {
      const list = this.approvals.get(sid) ?? [];
      list.push({
        toolName,
        requestId,
        requestDigest,
        executionSnapshot,
        suggestions: opts?.suggestions,
        resolve: (allow, always) =>
          resolve(
            allow
              ? {
                  behavior: "allow",
                  updatedInput: approvedInput,
                  ...(always
                    ? {
                        updatedPermissions: opts?.suggestions?.length
                          ? opts.suggestions
                          : ([
                              { type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" },
                            ] satisfies PermissionUpdate[]),
                      }
                    : {}),
                }
              : { behavior: "deny", message: "Denied via Macchiato" },
          ),
      });
      this.approvals.set(sid, list);
    });
  }

  /**
   * #109 AskUserQuestion → 逐題 clarify.request（帶 request_id=`${toolUseID}#i`），收齊
   * clarify.respond 後把答案掛回 `updatedInput.answers`（`{問題原文: 所選 label}`）解掛 canUseTool。
   * 全部跳過/無答案 → 原樣 allow（CLI 自答「The user did not answer the questions.」，模型自行繼續）。
   * multiSelect 一律單選（v1）；「Other」自由文本不做（用戶可事後追問）。
   */
  private requestAnswers(
    sid: string,
    input: Record<string, unknown>,
    toolUseID?: string,
  ): Promise<PermissionResult> {
    // clarify.request 是明文 TUI 控制幀；E2E 會話不得把問題/選項旁路送往 server。
    // 無答案即是 SDK 已有的「跳過」語義，讓模型在本地自行繼續。
    if (this.e2e?.isE2E(sid)) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    const questions = Array.isArray((input as { questions?: unknown }).questions)
      ? ((input as { questions: unknown[] }).questions as Record<string, unknown>[])
      : [];
    if (!questions.length) return Promise.resolve({ behavior: "allow", updatedInput: input });
    const base = toolUseID || `ask_${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve) => {
      const answers: Record<string, string> = {};
      let remaining = questions.length;
      const finishOne = (question: string, answer: string | null) => {
        if (answer) answers[question] = answer;
        if (--remaining > 0) return;
        const hasAnswers = Object.keys(answers).length > 0;
        resolve({ behavior: "allow", updatedInput: hasAnswers ? { ...input, answers } : input });
      };
      questions.forEach((q, i) => {
        const question = String(q?.question ?? "").slice(0, 500);
        const reqId = `${base}#${i}`;
        this.clarifies.set(reqId, { sid, record: (answer) => finishOne(question, answer) });
        this.emit(sid, "clarify.request", {
          question,
          // Macchiato 對 choices 的形狀約定（見 protocol ClarifyRequestPayload 註釋）:
          // {header?, multiSelect?, options:[{id,label,description?}]}。server 映射成選項卡。
          choices: {
            ...(typeof q?.header === "string" && q.header ? { header: q.header } : {}),
            ...(q?.multiSelect === true ? { multiSelect: true } : {}),
            options: (Array.isArray(q?.options) ? (q.options as Record<string, unknown>[]) : [])
              .slice(0, 8)
              .map((o, j) => ({
                id: String(j),
                label: String(o?.label ?? "").slice(0, 120),
                ...(typeof o?.description === "string" && o.description
                  ? { description: o.description.slice(0, 300) }
                  : {}),
              })),
          },
          request_id: reqId,
        });
      });
    });
  }

  /** §19：E2E 回合結束 → 用戶消息 + 回覆加密成 mirror_append 批（方案 A，同 OpenClaw）。 */
  private sendE2ETurn(sid: string, reply: string): void {
    if (!this.e2e) return;
    const msgs: Record<string, unknown>[] = (this.pendingUser.get(sid) ?? []).map((t) => ({
      role: "user",
      enc: this.e2e!.encryptContent(sid, { text: t }),
    }));
    this.pendingUser.delete(sid);
    if (reply.trim()) msgs.push({ role: "agent", enc: this.e2e.encryptContent(sid, { text: reply }) });
    if (!msgs.length) return;
    this.linkb.send({
      t: "mirror_append",
      agentLinkId: this.linkb.agentLinkId,
      sessions: [{ hermesSessionId: sid, source: "claude-code", e2e: true, messages: msgs }],
    });
    console.log(`· E2E turn → encrypted mirror batch (${sid}, ${msgs.length} messages)`);
  }

  private safeArgs(s: string): Record<string, unknown> {
    try {
      return JSON.parse(s || "{}");
    } catch {
      return { raw: s.slice(0, 500) };
    }
  }

  /** 存檔：v2 = `{v:2, map, cwds}`（#105 起）；舊版是平面 `Record<sid, ccSid>`，讀時兼容。 */
  private persistSessionSetting(
    target: Record<string, string>,
    sid: string,
    value: string,
    authenticated: AuthenticatedControlTag | undefined,
    label: string,
  ): boolean {
    const hadPrevious = Object.hasOwn(target, sid);
    const previous = target[sid];
    if (value ? previous === value : !hadPrevious) return false;
    if (value) target[sid] = value;
    else delete target[sid];
    if (this.saveMap()) return true;
    if (hadPrevious) target[sid] = previous!;
    else delete target[sid];
    if (authenticated) {
      throw new E2EControlError(`failed to persist authenticated ${label}`);
    }
    return false;
  }

  private loadState(): PersistedDriveState {
    for (const [path, isPrimary] of [[mapPath(), true], [`${mapPath()}.bak`, false]] as const) {
      try {
        return parseDriveState(readFileSync(path, "utf8"), isPrimary);
      } catch {
        /* 下一個候選；backup 是舊代，只作內容恢復，不提升身份信任。 */
      }
    }
    return {
      map: {},
      aliases: {},
      cwds: {},
      permModes: {},
      models: {},
      efforts: {},
      pending: [],
      identityStateTrusted: false,
      aliasHistoryTrusted: false,
    };
  }
  private saveMap(): boolean {
    try {
      mkdirSync(dirname(mapPath()), { recursive: true });
      const tmp = `${mapPath()}.tmp`;
      const backupTmp = `${mapPath()}.bak.tmp`;
      const protectedIds = this.protectedWireSids();
      // 無受保護會話時可建立新的完整基線；一旦已有 E2E，舊 schema/backup 的未知歷史
      // 不能因 cwd/pending 等普通存檔「自我洗白」成完整 aliases。
      const nextAliasHistoryTrusted =
        protectedIds.length === 0 && this.hasAuthoritativeServerSnapshot()
          ? true
          : this.aliasHistoryTrusted;
      const snapshot = JSON.stringify({
        v: 2,
        map: this.map,
        aliases: this.aliases,
        aliasHistoryTrusted: nextAliasHistoryTrusted,
        cwds: this.cwds,
        permModes: this.permModes,
        models: this.models,
        efforts: this.efforts, // #231
        pending: [...this.pending], // #200 在途回合
      });
      writeFileSync(tmp, snapshot);
      renameSync(tmp, mapPath());
      writeFileSync(backupTmp, snapshot);
      renameSync(backupTmp, `${mapPath()}.bak`);
      const protectedMappedIds = protectedIds.filter(
        (sid) =>
          !CC_UUID_RE.test(sid) ||
          this.map[sid] !== undefined ||
          (this.aliases[sid]?.length ?? 0) > 0,
      );
      if (
        protectedMappedIds.every((sid) => {
          const current = this.map[sid];
          const localSids = this.localSessionIdsForWire(sid);
          return (
            CC_UUID_RE.test(current ?? "") &&
            localSids.includes(current) &&
            localSids.every((localSid) => CC_UUID_RE.test(localSid))
          );
        })
      ) {
        this.identityStateTrusted = true;
      }
      this.aliasHistoryTrusted = nextAliasHistoryTrusted;
      return true;
    } catch (e) {
      console.error("[session map save failed]", (e as Error).message);
      return false;
    }
  }
}
