/**
 * #946 會話身份：**源系統聲明的歸屬**，不再是 rollout 文件名。
 *
 * Codex 在每個 rollout 的 `session_meta` 裡就回答了「你屬於哪段對話」：
 *   - `id`            = 這條執行線程自己（＝文件名裡的 uuid，本機 1300/1300 完全一致）
 *   - `session_id`    = **它所屬的根線程**（`session_id ≠ id` ⟺ 派生線程，本機 515/515 零例外）
 *   - `parent_thread_id` / `forked_from_id` = 直接父線程（老一點的版本只有這兩個）
 *   - `thread_source` = `user` | `subagent` | `internal`
 *   - `source`        = 字串（`vscode`/`cli`/`exec`）或標籤聯合 `{subagent:{other:"guardian"}}`
 *
 * 判據鏈（issue #946）：`session_id` → `parent_thread_id` → `forked_from_id` → `id` → 文件名。
 * **是鏈不是替換**：`session_id` 只有新版 Codex 才寫（本機 639/1399），老版本必須原樣回落到
 * 以前的行為，否則等於把存量會話重新洗一遍身份。
 *
 * 三個輸出各管一件事，別混：
 *   - `conversationId` 決定**歸屬**（這條線程的內容落到哪一段對話）
 *   - `kind`           決定**可見性**（subagent/internal 不進用戶列表）
 *   - `evidence`       決定**信誰**：`declared` = 源系統寫了字段；`inferred` = 只能靠正文猜
 *     （#789/#918 的三條啟發式降級到這裡，只在聲明缺席時生效）；`absent` = 老版本沒這概念。
 *     最後兩者的區分是安全閥：**未知 ≠ 沒有**——沒有就維持現行行為，不倒退。
 */

import type {
  ThreadOrigin as WireThreadOrigin,
  ThreadOriginKind as WireThreadOriginKind,
} from "../linkb/proto";
import { isCodexInternalHistoryText } from "./transcripts";

export type OriginKind = "user" | "subagent" | "internal" | "fork";
export type OriginEvidence = "declared" | "inferred" | "absent";

export interface ThreadOrigin {
  /** 這條執行線程自己的 id（`session_meta.id`，缺則文件名）。 */
  threadId: string;
  /** 它屬於哪段對話（判據鏈；根線程 = threadId 自己）。 */
  conversationId: string;
  kind: OriginKind;
  /** 最近的父線程（`forked_from_id` → `parent_thread_id` → `session_id`）——公共前綴比對用。 */
  parentThreadId?: string;
  /** 子 agent 的名字/路徑（`agent_nickname` / `agent_path`），日誌與未來父會話卡片用。 */
  label?: string;
  evidence: OriginEvidence;
  /** 判據來源（日誌/計數口徑；與 #789 的 skip reason 逐字兼容）。 */
  reason?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** session_meta 的結構化派生標記（有 = 源系統明確聲明了它不是用戶頂層線程）。 */
function declaredDerived(
  meta: Record<string, unknown>,
): { kind: OriginKind; reason: string } | undefined {
  const threadSource = meta.thread_source;
  if (threadSource === "internal") return { kind: "internal", reason: "thread_source=internal" };
  if (threadSource === "subagent") return { kind: "subagent", reason: "thread_source=subagent" };

  const source = meta.source;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const tags = source as Record<string, unknown>;
    if ("internal" in tags) return { kind: "internal", reason: "source.internal" };
    if ("subagent" in tags) {
      const sub = tags.subagent;
      if (
        sub
        && typeof sub === "object"
        && !Array.isArray(sub)
        && (sub as Record<string, unknown>).other === "guardian"
      ) {
        return { kind: "subagent", reason: "source.subagent.other=guardian" };
      }
      return { kind: "subagent", reason: "source.subagent" };
    }
    if ("thread_spawn" in tags) return { kind: "subagent", reason: "source.thread_spawn" };
  }
  return undefined;
}

/**
 * 解析一條 rollout 的身份與歸屬。`content` 只需頭部（`readRolloutPreamble` 的兩行足夠）。
 * `fileThreadId` 是最後兜底——`session_meta.id` 缺失的老格式才用得上。
 */
export function parseOrigin(content: string | Buffer, fileThreadId = ""): ThreadOrigin {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : content;
  let meta: Record<string, unknown> | undefined;
  let firstUser: string | undefined;
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o: { type?: string; payload?: Record<string, unknown> } & Record<string, unknown>;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (!meta && o.type === "session_meta") {
      meta = (o.payload ?? o) as Record<string, unknown>;
    } else if (
      firstUser === undefined
      && o.type === "event_msg"
      && o.payload?.type === "user_message"
      && typeof o.payload.message === "string"
    ) {
      firstUser = o.payload.message;
    }
    if (meta && firstUser !== undefined) break;
  }

  const m = meta ?? {};
  const threadId = nonEmptyString(m.id) ?? fileThreadId;
  const sessionId = nonEmptyString(m.session_id);
  const parentThreadId = nonEmptyString(m.parent_thread_id);
  const forkedFromId = nonEmptyString(m.forked_from_id);
  const label = nonEmptyString(m.agent_nickname) ?? nonEmptyString(m.agent_path);
  const derived = meta ? declaredDerived(m) : undefined;

  // 判據鏈：取**第一個出現**的字段（源系統說「我屬於自己」時 session_id === id，同樣算聲明）。
  const declaredConversation = sessionId ?? parentThreadId ?? forkedFromId;
  const conversationId = declaredConversation ?? threadId;
  // 公共前綴比對要的是**最近**的父，不是根。
  const nearestParent = forkedFromId ?? parentThreadId ?? sessionId;

  // `thread_source: "user"` 本身就是一句聲明（本機 106 條只有它、沒有 session_id 的），
  // 有它就不必再去猜正文——猜的代價是把用戶轉貼那段英文的會話整條吞掉。
  const hasDeclaration = !!(derived || declaredConversation || nonEmptyString(m.thread_source));
  if (derived) {
    return {
      threadId,
      conversationId,
      kind: derived.kind,
      ...(nearestParent && nearestParent !== threadId ? { parentThreadId: nearestParent } : {}),
      ...(label ? { label } : {}),
      evidence: "declared",
      reason: derived.reason,
    };
  }

  if (declaredConversation && conversationId !== threadId) {
    // 源系統聲明了歸屬、但沒說自己是 subagent/internal：終端側 rewind / fork / 續接。
    // 它**不是**要丟的內部線程——丟掉的後果是用戶那條會話從此靜默停更（#946）。
    return {
      threadId,
      conversationId,
      kind: "fork",
      ...(nearestParent ? { parentThreadId: nearestParent } : {}),
      ...(label ? { label } : {}),
      evidence: "declared",
      reason: sessionId ? "session_id" : parentThreadId ? "parent_thread_id" : "forked_from_id",
    };
  }

  // ↓↓↓ 以下全是「源聲明缺席」時的兜底：#789/#918 的正文啟發式降級到這裡。
  if (!hasDeclaration && firstUser !== undefined && isCodexInternalHistoryText(firstUser)) {
    return {
      threadId,
      conversationId: threadId,
      kind: "internal",
      evidence: "inferred",
      reason: "codex-internal-history",
    };
  }

  return {
    threadId,
    conversationId,
    kind: "user",
    ...(label ? { label } : {}),
    evidence: hasDeclaration ? "declared" : "absent",
  };
}

/**
 * 沿著判據鏈把歸屬解析到**根**對話：fork 的 fork（老格式只有 `forked_from_id` 時會出現鏈）
 * 若只認直接父，就會歸到一個從未在 app 裡存在過的中間線程上，等於又建一條新會話。
 * `lookup` 拿不到的 id 就地停下（父 rollout 已被壓縮/刪除 → 直接父就是最好的答案）。
 */
export function resolveConversationId(
  origin: ThreadOrigin,
  lookup: (threadId: string) => ThreadOrigin | undefined,
  maxHops = 8,
): string {
  let current = origin.conversationId;
  const seen = new Set<string>([origin.threadId]);
  for (let i = 0; i < maxHops; i++) {
    if (!current || seen.has(current)) break;
    seen.add(current);
    const parent = lookup(current);
    if (!parent || !parent.conversationId || parent.conversationId === current) break;
    if (seen.has(parent.conversationId)) break;
    current = parent.conversationId;
  }
  return current || origin.threadId;
}

/** 鏡像口徑：只有 subagent / internal 整檔不進用戶會話；fork 改走「歸屬」。 */
export function isHiddenKind(kind: OriginKind): boolean {
  return kind === "subagent" || kind === "internal";
}

/**
 * #966 把已經算出來的血緣填成協議的 `ImportSession.origin`（`wireSid` = 這批內容實際掛的
 * `hermesSessionId`）。與 claude-code（#967）同一形狀。
 *
 * 為什麼**恒是 `root`**、而不是把 `fork`/`subagent` 原樣報上去：協議規定
 * `origin.threadId` ≡ `hermesSessionId` 所指的那條線程，而**判定權今天仍在連接器**——派生
 * 線程在本地就已經並進父會話了（#946），所以這批內容對 server 而言就是**那條頂層對話自己的
 * 內容**，據實報成 root。真報 `continuation`/`derived` 要等判定權交回 server（那時
 * `hermesSessionId` 換成線程自己的 id）；現在報了只會被 `classifyThreadOrigin` 判成自相矛盾
 * 的元數據原地丟掉（threadId ≠ 掛載身份 → `legacy`），既沒用、還污染 `evidence` 那條漂移告警。
 *
 * 落地當天的收益不是零：新會話落 `origin_kind='root'` + `origin_evidence='declared'`，
 * #945 那條「標題像機器文本就隔離」的兜底啟發式從此不會有機會誤傷真實用戶會話（用戶轉貼過
 * 那段英文的會話就是這麼被誤判的），且 `sessions_resolved{kind,evidence}` 有了對賬口徑。
 *
 * `evidence: "absent"`（老版本 Codex 壓根沒這概念）→ 返回 `undefined`，整個字段不上線：
 * 與 server 的 `legacy` 逐字節等價，少發一個字段。
 */
export function toWireOrigin(origin: ThreadOrigin, wireSid: string): WireThreadOrigin | undefined {
  if (origin.evidence === "absent") return undefined;
  const kind: WireThreadOriginKind = "root";
  return { threadId: wireSid, conversationId: wireSid, kind, evidence: origin.evidence };
}
