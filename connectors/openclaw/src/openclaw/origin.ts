/**
 * #949 會話血緣（openclaw）：把 gateway `sessions.list` 的每一行判成「這是一段對話，還是一次執行」。
 *
 * openclaw 的**身份**本來就是四家裡做得最對的（穩定 `key` + `key → transcript sessionId` 別名表，
 * #211/#347）——這一刀**一個字都不動身份**，只補上它唯一缺的那件事：**不過濾派生會話**。
 * 今天 `mirror.ts` 對 `sessions.list` 返回的 key 全量鏡像，只特判了 `MACCHIATO_PREFIX` 與 `:cron:`，
 * 於是子 agent / hook / node / heartbeat 這些**執行單元**會各自在用戶列表裡佔一行。
 *
 * ## 上游到底給了我們什麼（openclaw 2026.7.1-2 dist 實讀，2026-08-14）
 *
 * ⚠️ 先更正一處常見誤解：`kind ∈ {main, group, cron, hook, node, other}` 是 **agent 側 `sessions_list`
 * 工具**（`sessions-helpers` 的 `classifySessionKind`）自己二次分類出來的，**不是我們拿到的東西**。
 * 連接器走的是 **gateway RPC `sessions.list`**，它的 `kind` 來自 `session-utils` 的
 * `classifySessionKey(key, entry)`，值域只有 **`global` / `unknown` / `group` / `direct`**——
 * 對「這是不是派生線程」**一個字都沒說**。所以按 `kind` 判派生是判不出來的。
 *
 * 真正的權威聲明在同一行的**其它字段**與 **key 形狀**上（`buildGatewaySessionRow` 的返回值）：
 *   - `spawnedBy` / `parentSessionKey` = **父會話 key**（live subagent run 的 controller/requester，
 *     或持久化的 `entry.spawnedBy`）——這是「我屬於哪段對話」的正向聲明。
 *   - `spawnDepth` / `subagentRole` / `forkedFromParent` = 子 agent 的附屬元數據。
 *   - key 形狀：子 agent 是 `agent:<agentId>:subagent:<uuid>`（`openclaw-tools` 裡逐字生成），
 *     cron/hook/node/acp/heartbeat 同理。OpenClaw **自己**判「這是不是合成維護會話」用的就是形狀
 *     （`isSyntheticSessionMaintenanceKey`），不是 `kind`。
 *
 * ## 三個輸出各管一件事（與 codex #946 / claude-code #947 同一套詞彙）
 *   - `conversationId` 決定**歸屬**（這條線程屬於哪段對話）
 *   - `kind`           決定**可見性**（`subagent` / `internal` 不進用戶列表）
 *   - `evidence`       決定**信誰**：`declared` = 源系統寫了字段；`inferred` = 只能靠 key 形狀推；
 *     `absent` = 這個版本壓根沒這概念 → **維持現行行為，不倒退**。
 *
 * `quarantined` 是 openclaw 這一刀獨有的第四個出口（協議還沒有 `origin` 字段可上報，見 #926 §5）：
 * `kind` 出現我們**不認識的值**時 fail-closed——不建新會話、打點等人看，而不是放行進用戶列表。
 * **未知 ≠ 沒有**：`kind` 缺席（老 gateway）走 `absent`，行為一個字不變。
 */

import type { ThreadOrigin, ThreadOriginKind } from "../linkb/proto";

/** 這條執行線程相對「一段對話」的角色（與 codex/claude-code 共用詞彙）。 */
export type OriginKind = "user" | "subagent" | "internal";
/** 判據來源：源系統聲明 / 我們按 key 形狀推斷 / 什麼都沒有。 */
export type OriginEvidence = "declared" | "inferred" | "absent";

export interface SessionOrigin {
  /** 這條執行線程自己的身份 —— gateway 的穩定 key（openclaw 的身份錨，不動）。 */
  threadId: string;
  /** 它屬於哪段對話：頂層會話 = 自己；派生會話 = 父 key。 */
  conversationId: string;
  kind: OriginKind;
  /** 最近的父會話 key（`parentSessionKey` / `spawnedBy`），僅在源系統聲明時才有。 */
  parentThreadId?: string;
  /** 子 agent 的角色標籤（日誌/未來父會話卡片用）。 */
  label?: string;
  evidence: OriginEvidence;
  /** 判據來源（日誌與計數口徑）。 */
  reason?: string;
  /** fail-closed：`kind` 是未知值 → 不建新會話，進隔離區等人看。 */
  quarantined?: boolean;
  /** 觸發隔離的那個 gateway `kind` 原值（上報時原樣帶給 server，見 `toThreadOrigin`）。 */
  unknownKind?: string;
}

/** gateway `sessions.list` 一行裡我們會讀的字段（其餘一律忽略，上游加字段不影響我們）。 */
export interface GatewaySessionRow {
  key?: unknown;
  sessionId?: unknown;
  kind?: unknown;
  spawnedBy?: unknown;
  parentSessionKey?: unknown;
  subagentRole?: unknown;
}

/**
 * gateway `classifySessionKey` 的**完整**值域（openclaw 2026.7.1-2）。
 * 出現這之外的值 = 上游發明了新東西 → 隔離 + 打點（ACP v2 enum RFD：線路上寬容、判定上收緊）。
 */
const KNOWN_GATEWAY_KINDS = new Set(["direct", "group", "global", "unknown"]);

/** `global` / `unknown` 是 OpenClaw 自己的哨兵 key，不是任何人的對話。 */
const SENTINEL_KEYS = new Set(["global", "unknown"]);

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * `agent:<agentId>:<rest>` 拆解（對齊上游 `parseAgentSessionKey`：小寫比對、rest 保留冒號）。
 * 不是 agent-scoped key（老式/別名 key）→ 返回 undefined，rest 退化成整個 key。
 */
function parseAgentKey(key: string): { agentId: string; rest: string } | undefined {
  const parts = key.split(":");
  if (parts.length < 3 || parts[0]?.toLowerCase() !== "agent") return undefined;
  const agentId = parts[1]?.trim().toLowerCase();
  const rest = parts.slice(2).join(":");
  if (!agentId || !rest) return undefined;
  return { agentId, rest };
}

/** 派生 / 合成維護會話的 key 形狀（逐條對齊上游 `isSyntheticSessionMaintenanceKey`）。 */
function syntheticReason(rest: string): "cron" | "hook" | "node" | "acp" | "heartbeat" | undefined {
  const r = rest.toLowerCase();
  if (r.startsWith("cron:")) return "cron";
  if (r.startsWith("hook:")) return "hook";
  if (r.startsWith("node:")) return "node";
  if (r.startsWith("acp:") || r.startsWith("acp-bridge:")) return "acp";
  if (r === "heartbeat" || r.endsWith(":heartbeat") || r.includes(":heartbeat:")) return "heartbeat";
  return undefined;
}

/** 子 agent key：`agent:<agentId>:subagent:<uuid>`，或裸 `subagent:<uuid>`（上游兩種都認）。 */
export function isSubagentSessionKey(key: string | undefined): boolean {
  if (!key) return false;
  const rest = parseAgentKey(key)?.rest ?? key;
  return rest.toLowerCase().startsWith("subagent:");
}

/**
 * 解析 gateway 一行的歸屬與可見性。**永不拋**——認不出來一律走 `absent`（維持現行行為）。
 *
 * 判據順序（形狀優先於 `kind`，因為 gateway 的 `kind` 對派生與否什麼都沒說，見文件頭）：
 *   1. 哨兵 key（`global` / `unknown`）→ internal
 *   2. 子 agent 形狀 → subagent，歸屬到聲明的父；沒聲明就歸到該 agent 的主會話
 *   3. cron / hook / node / acp / heartbeat 形狀 → internal
 *   4. 有 `parentSessionKey` / `spawnedBy` 但形狀不是子 agent → 仍是派生執行單元（上游 spawn-child）
 *   5. `kind` 已知（direct/group）→ user；缺席 → user + absent；未知值 → 隔離
 */
export function parseSessionOrigin(row: GatewaySessionRow): SessionOrigin {
  const key = str(row.key) ?? "";
  const self = (kind: OriginKind, evidence: OriginEvidence, extra: Partial<SessionOrigin> = {}): SessionOrigin => ({
    threadId: key,
    conversationId: key,
    kind,
    evidence,
    ...extra,
  });

  if (SENTINEL_KEYS.has(key.toLowerCase())) {
    return self("internal", "declared", { reason: "sentinel" });
  }

  const parsed = parseAgentKey(key);
  const rest = parsed?.rest ?? key;
  const declaredParent = str(row.parentSessionKey) ?? str(row.spawnedBy);
  const label = str(row.subagentRole);

  if (isSubagentSessionKey(key)) {
    // 歸屬 > 丟棄（#926 的第三個出口）：優先用源系統聲明的父 key；拿不到就落到該 agent 的主會話。
    // ⚠️ 主會話 key 在 OpenClaw 裡可配（`normalizeMainKey` 默認 "main"），所以這條回退是**推斷**，
    // 標 inferred；它只影響日誌與未來的父會話卡片，不影響「不建新會話」這個結論。
    const fallbackParent = parsed ? `agent:${parsed.agentId}:main` : undefined;
    const conversationId = declaredParent ?? fallbackParent ?? key;
    return {
      threadId: key,
      conversationId,
      kind: "subagent",
      ...(declaredParent ? { parentThreadId: declaredParent } : {}),
      ...(label ? { label } : {}),
      evidence: declaredParent ? "declared" : "inferred",
      reason: declaredParent ? "spawnedBy" : "key-shape:subagent",
    };
  }

  const synthetic = syntheticReason(rest);
  if (synthetic) {
    return self("internal", "inferred", {
      reason: synthetic,
      ...(declaredParent ? { parentThreadId: declaredParent, conversationId: declaredParent } : {}),
    });
  }

  if (declaredParent && declaredParent !== key) {
    // 上游 `classifySessionKind` 把「entry 有 spawnedBy」單獨列為 spawn-child，並明確說**要在 key
    // 形狀之前判**，否則 key 不透明的 ACP spawn-child 會被誤當成普通直聊。同款順序照抄。
    return {
      threadId: key,
      conversationId: declaredParent,
      kind: "subagent",
      parentThreadId: declaredParent,
      ...(label ? { label } : {}),
      evidence: "declared",
      reason: "spawnedBy",
    };
  }

  const kind = str(row.kind);
  if (!kind) return self("user", "absent"); // 老 gateway 沒這字段——維持現行行為，不倒退
  if (KNOWN_GATEWAY_KINDS.has(kind.toLowerCase())) return self("user", "declared", { reason: `kind=${kind}` });
  // 未知 ≠ 沒有：上游發明了新的會話類別 → fail-closed，不建新會話。
  return self("internal", "declared", {
    reason: `unknown-kind:${kind}`,
    quarantined: true,
    unknownKind: kind,
  });
}

/**
 * #968 本地血緣 → 協議 `ThreadOrigin`（上報給 server 的那份**事實**）。
 *
 * #985：映射本身已經據實（`user→root` / `subagent|internal→derived` / 未知 kind 加前綴）。
 * 連接器**仍按本地 `isHiddenOrigin` 過濾**（老 server 沒判定表，停本地隱藏會讓列表爆出
 * cron/子 agent）。判定權交回 server 要等生產 server 已跑 #926 判定 + #985 熔斷，再開後續。
 *
 * 詞彙對照（左 = 四家連接器共用的說法，右 = server 判定表的值域）：
 *   - `user`     → `root`     頂層用戶對話 → 進列表
 *   - `subagent` → `derived`  執行單元 → 歸屬父會話（定不出父則隔離）
 *   - `internal` → `derived`  cron / hook / node / heartbeat / 哨兵同樣不是一段對話。
 *     刻意**不**另造一個字符串：那會觸發 server 的「上游發明了新 kind」告警（#950），把我們
 *     自己的詞彙變成漂移噪音；而 `derived` 定不出父時的去向本來就是隔離，結論一模一樣。
 *   - 未知 gateway `kind` → 原值加 `openclaw-kind:` 前綴上報。**這一條才是真的漂移**，要的
 *     就是 server 那條 fail-closed + 告警；前綴保證它永遠落不進已知值域（哪怕上游哪天真的
 *     發明了一個叫 `root` 的 kind）。
 *
 * `wireId` = 這批消息實際上報的 `hermesSessionId`。server 的 `classifyThreadOrigin` 要求
 * `origin.threadId` 與它**逐字相等**，否則整份 origin 退回老行為——app 驅動的會話上報的是
 * server sid 而不是 gateway key，所以這裡必須按上報身份重寫，不能直接把 key 塞出去。
 */
export function toThreadOrigin(origin: SessionOrigin, wireId: string): ThreadOrigin {
  const kind: ThreadOriginKind = origin.unknownKind
    ? `openclaw-kind:${origin.unknownKind}`
    : origin.kind === "user"
      ? "root"
      : "derived";
  // 歸屬到自己時跟着上報身份走；歸屬到父會話時父的 wire 身份就是它的 key（openclaw 的身份
  // 錨從來沒動過），原樣帶出去即可。
  const ownConversation = origin.conversationId === origin.threadId;
  return {
    threadId: wireId,
    conversationId: ownConversation ? wireId : origin.conversationId,
    kind,
    ...(origin.parentThreadId ? { parentThreadId: origin.parentThreadId } : {}),
    ...(origin.label ? { label: origin.label } : {}),
    evidence: origin.evidence,
  };
}

/**
 * 鏡像口徑：只有 `user` 進用戶列表；`subagent` / `internal` 是執行單元，不佔一行。
 * #985 先不拆這道閘——舊 server / 當前 prod 還沒判定表，拆了就是列表裡多出一堆機器線程。
 */
export function isHiddenOrigin(origin: SessionOrigin): boolean {
  return origin.kind !== "user" || origin.quarantined === true;
}
