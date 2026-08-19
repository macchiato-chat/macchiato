/**
 * #947 會話血緣（claude-code）：把「這條 transcript 屬於哪段對話」從**文件名約定 + 啟發式**
 * 換成**讀 Claude Code 自己在行內寫下的聲明**。
 *
 * CC 有兩種「多條 transcript 檔 = 同一段對話」（本機 545 個真實 transcript 實測，2026-08-14）：
 *
 *  - **子 agent**：獨立檔（新版寫在 `<project>/<父會話 id>/subagents/agent-*.jsonl`，老版直接寫在
 *    項目目錄頂層），每行帶 `isSidechain: true` / `agentId` / `sessionId = 父會話 id`——本機
 *    231/231 全部指向現存主會話。它們是父會話的**執行單元**，不是另一段對話 → 不建會話。
 *    文件名 `agent-*` 降級為**兜底**（老檔、或聲明缺席時才用）。
 *
 *  - **續接**：終端 `--resume` / rewind 會**新開一個 `<uuid>.jsonl`**，把父會話的歷史整段複製進去
 *    （實測 270→700 行、147→1694 行；rewind 是 705→149 的截斷副本）。複製時**每行的 `sessionId`
 *    被改寫成新檔自己的 id**（所以 `sessionId` 認不出續接），但**每行的 `uuid` 原樣保留**——於是
 *    「對話根消息的 uuid」和「首條 `last-prompt` 行的 `leafUuid`」在父子兩檔裡是同一個值，
 *    成了這段對話的天然指紋。本機 312 個主會話裡 10 個是續接，指紋 10/10 全中、主會話 0 誤傷。
 *    不接回父會話的後果就是生產庫裡那 11 條會話 / 1600 條重複消息（#926）。
 *
 * 成本：指紋只從**文件頭**取，且每個會話**只解一次**（結論由 Mirror 持久化到鏡像狀態），
 * 不每輪 poll 全量重掃 transcript。
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** 這條執行線程相對「一段對話」的角色。 */
export type OriginKind = "user" | "subagent" | "continuation";
/** 判據來源：源系統聲明 / 我們的兜底推斷 / 什麼都沒有。 */
export type OriginEvidence = "declared" | "inferred" | "absent";

export interface TranscriptOrigin {
  kind: OriginKind;
  evidence: OriginEvidence;
  /** 源系統直接聲明的父/根會話 id（子 agent 的 `sessionId`；顯式續接同理）。 */
  declaredParent?: string;
  /** 子 agent 的 `agentId`（診斷/日誌用）。 */
  agentId?: string;
  /**
   * 這段對話的指紋（`u:<根消息 uuid>` / `l:<首條 last-prompt 的 leafUuid>`）。
   * 續接檔與其父檔的指紋相同 —— 這是把 `--resume` 接回父會話的唯一可靠鉤子。
   */
  fingerprints: string[];
  /** 頭部真正解析出的行數（0 = 檔剛建還沒寫內容，結論**不可**緩存）。 */
  parsedLines: number;
  /** 本次實際讀了多少字節。 */
  bytesRead: number;
}

const HEAD_CHUNK = 64 * 1024;
/** 單條 user 行實測可達 490KB（IDE / hook 注入大上下文），根消息可能落在很深的地方。 */
const HEAD_MAX = 1024 * 1024;
const HEAD_MAX_LINES = 200;

/** `agent-*.jsonl`：子 agent 檔的**文件名兜底**（聲明缺席時才用）。 */
const AGENT_FILE_PREFIX = "agent-";

function emptyOrigin(file: string): TranscriptOrigin {
  const named = basename(file).startsWith(AGENT_FILE_PREFIX);
  return {
    kind: named ? "subagent" : "user",
    evidence: named ? "inferred" : "absent",
    fingerprints: [],
    parsedLines: 0,
    bytesRead: 0,
  };
}

/**
 * 讀 transcript 檔頭，解出它自報的歸屬。全程防禦性解析（CC 官方標注「內部格式」）——
 * 認不出一律回落到「自己就是一段對話」，絕不拋。
 */
export function readTranscriptOrigin(file: string, threadId: string): TranscriptOrigin {
  let fd: number;
  let size: number;
  try {
    size = statSync(file).size;
    fd = openSync(file, "r");
  } catch {
    return emptyOrigin(file);
  }

  let rootUuid: string | undefined;
  let firstLeafUuid: string | undefined;
  let declaredSessionId: string | undefined;
  let agentId: string | undefined;
  let isSidechain = false;
  let parsedLines = 0;
  let pos = 0;

  try {
    const limit = Math.min(size, HEAD_MAX);
    const decoder = new StringDecoder("utf8");
    let carry = "";
    const buf = Buffer.allocUnsafe(HEAD_CHUNK);
    outer: while (pos < limit) {
      const want = Math.min(HEAD_CHUNK, limit - pos);
      const n = readSync(fd, buf, 0, want, pos);
      if (n <= 0) break;
      pos += n;
      carry += decoder.write(buf.subarray(0, n));
      let nl: number;
      while ((nl = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, nl).trim();
        carry = carry.slice(nl + 1);
        if (!line) continue;
        let d: Record<string, unknown>;
        try {
          d = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // 壞行跳過
        }
        parsedLines += 1;
        if (!declaredSessionId && typeof d.sessionId === "string" && d.sessionId) {
          declaredSessionId = d.sessionId;
        }
        if (!rootUuid && typeof d.uuid === "string" && d.uuid) {
          rootUuid = d.uuid;
          // ⚠️ 子 agent 的判據只看**根消息行**，不看「檔裡出現過 isSidechain」——老版本 CC 把
          // 子 agent 的行**內聯**在主會話 transcript 裡（2026-08-01 生產實測：開場 user 行之後
          // 跟著 >1MB 的 sidechain 洪流）。整檔一見 isSidechain 就判子 agent，會把主會話整條抹掉。
          if (d.isSidechain === true) isSidechain = true;
          if (typeof d.agentId === "string" && d.agentId) agentId = d.agentId;
        }
        if (!firstLeafUuid && typeof d.leafUuid === "string" && d.leafUuid) firstLeafUuid = d.leafUuid;
        if (parsedLines >= HEAD_MAX_LINES) break outer;
        // 兩個指紋都拿到了就別再讀（絕大多數檔在第一塊 64KB 內就收工）。
        if (rootUuid && firstLeafUuid && declaredSessionId) break outer;
      }
    }
  } catch {
    /* 讀壞就用已解出的部分 */
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }

  const fingerprints: string[] = [];
  if (rootUuid) fingerprints.push(`u:${rootUuid}`);
  if (firstLeafUuid) fingerprints.push(`l:${firstLeafUuid}`);

  // ① 子 agent：行內聲明優先（`isSidechain` / `agentId`）。
  if (isSidechain || agentId) {
    return {
      kind: "subagent",
      evidence: "declared",
      ...(declaredSessionId && declaredSessionId !== threadId ? { declaredParent: declaredSessionId } : {}),
      ...(agentId ? { agentId } : {}),
      fingerprints,
      parsedLines,
      bytesRead: pos,
    };
  }
  // ② 文件名兜底（老版本 CC 的 `agent-*.jsonl`，或未來聲明字段又改名）。
  if (basename(file).startsWith(AGENT_FILE_PREFIX)) {
    return {
      kind: "subagent",
      evidence: "inferred",
      ...(declaredSessionId && declaredSessionId !== threadId ? { declaredParent: declaredSessionId } : {}),
      fingerprints,
      parsedLines,
      bytesRead: pos,
    };
  }
  // ③ 顯式續接：行內 `sessionId` 指向別的會話（當前 CC 會改寫 sessionId，所以這條是為
  //    「上游哪天不改寫了」留的正向出口——真出現時我們直接接回，不用再等一次生產事故）。
  if (declaredSessionId && declaredSessionId !== threadId) {
    return {
      kind: "continuation",
      evidence: "declared",
      declaredParent: declaredSessionId,
      fingerprints,
      parsedLines,
      bytesRead: pos,
    };
  }
  // ④ 頂層用戶會話。指紋在則「有據可依」，否則 absent（維持現行行為，不倒退）。
  return {
    kind: "user",
    evidence: fingerprints.length ? "declared" : "absent",
    fingerprints,
    parsedLines,
    bytesRead: pos,
  };
}

/**
 * 「這個檔是子 agent 嗎」的記憶化查詢（discoverSessions 每輪 poll 都要問，不能每次重讀）。
 * 檔的角色在創建時就定死、不會變，所以一次判定即可；只有「還沒寫出任何行」的空檔不緩存
 * （等它寫出內容再判）。
 */
const subagentMemo = new Map<string, boolean>();

/**
 * 上游漂移的觀測口：`subagentInferred` 持續 > 0 = CC 不再寫行內聲明、我們已經退回猜文件名，
 * 該去看看它又改了什麼（而不是等生產庫裡冒出一堆同名會話才發現）。
 */
export const lineageCounters = { subagentDeclared: 0, subagentInferred: 0 };

export function isSubagentTranscript(file: string, threadId: string): boolean {
  const cached = subagentMemo.get(file);
  if (cached !== undefined) return cached;
  const origin = readTranscriptOrigin(file, threadId);
  const subagent = origin.kind === "subagent";
  // 空檔（0 行且沒讀到什麼）先不下結論——除非文件名已經把話說死。
  const conclusive = subagent || origin.parsedLines > 0 || origin.bytesRead >= HEAD_CHUNK;
  if (conclusive) {
    if (subagentMemo.size > 4096) subagentMemo.clear(); // 有界：轉錄檔可能很多，滿了整清重建
    subagentMemo.set(file, subagent);
    if (subagent) {
      if (origin.evidence === "declared") lineageCounters.subagentDeclared += 1;
      else lineageCounters.subagentInferred += 1;
    }
  }
  return subagent;
}

/** 測試用：清空記憶化（每個用例一套臨時目錄，路徑可能撞名）。 */
export function resetLineageMemo(): void {
  subagentMemo.clear();
  lineageCounters.subagentDeclared = 0;
  lineageCounters.subagentInferred = 0;
}

/** 協議 `ThreadOrigin` 的 wire 形狀（公開 connector 不依賴私有包）。 */
export interface ThreadOriginWire {
  threadId: string;
  conversationId: string;
  kind: "root" | "continuation" | "derived" | (string & {});
  parentThreadId?: string;
  label?: string;
  depth?: number;
  evidence: OriginEvidence;
}

/**
 * #985：獨立 session 據實報 kind；已經併進別人的批次只能報 root。
 *
 * `wireSid` = 這批消息實際上報的 `hermesSessionId`。協議要求 `origin.threadId ≡ wireSid`，
 * 對不上 server 整份退回 legacy。
 *
 * 續接若以**自己的 id** 上報且帶 `conversationId` 指向父 → `continuation`。
 * ⚠️ caller 不得在「這條線程自己持着一把獨立 K_S」時走 continuation——新 server 會把
 * 密文並進父會話，父那把鑰匙解不開。E2E 身份閘沒合併的路徑繼續報 root。
 */
export function toWireOrigin(
  wireSid: string,
  evidence: OriginEvidence | undefined,
  local?: { threadId: string; kind?: OriginKind; conversationId?: string; parentThreadId?: string },
): ThreadOriginWire | undefined {
  if (!evidence || evidence === "absent") return undefined;
  if (!local || local.threadId !== wireSid) {
    return { threadId: wireSid, conversationId: wireSid, kind: "root", evidence };
  }
  if (!local.kind || local.kind === "user") {
    return { threadId: wireSid, conversationId: wireSid, kind: "root", evidence };
  }
  const parent = local.conversationId && local.conversationId !== wireSid ? local.conversationId : undefined;
  if (local.kind === "subagent") {
    return {
      threadId: wireSid,
      conversationId: parent ?? wireSid,
      kind: "derived",
      ...(local.parentThreadId ?? parent ? { parentThreadId: local.parentThreadId ?? parent } : {}),
      evidence,
    };
  }
  // continuation
  if (!parent) return { threadId: wireSid, conversationId: wireSid, kind: "root", evidence };
  return {
    threadId: wireSid,
    conversationId: parent,
    kind: "continuation",
    parentThreadId: local.parentThreadId ?? parent,
    evidence,
  };
}
