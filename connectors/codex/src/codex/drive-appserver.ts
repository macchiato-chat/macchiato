/**
 * #132 v2 Drive:常駐 `codex app-server`(JSON-RPC)驅動——exec v1(drive.ts,保留作 fallback)
 * 拿不到的四能力在此齊活(全部 0.144.1 兩輪探針活測背書):
 *   - token 級 delta:item/agentMessage/delta → message.delta(v1 只有整條 item);
 *   - 遠程審批:item/commandExecution|fileChange/requestApproval 反向 JSON-RPC ↔ Macchiato
 *     審批卡(approval.request/respond,對齊 CC canUseTool 橋;all=true → acceptForSession
 *     用 codex 原生會話級審批緩存);
 *   - mid-turn steer:回合進行中的 prompt → turn/steer{expectedTurnId}(v1 只能排隊);
 *   - 原生圖片:image 附件 → UserInput{type:"localImage", path}(v1 只能路徑注入)。
 * 白嫖:thread/tokenUsage/updated → turn.usage 事件(#141 同款 output tokens 計數)。
 *
 * 事實依據(探針):turn/start 立即返回(turn 在後台跑);turn/completed 的 turn.items 是
 * notLoaded 空數組——最終文本必須從 item/completed(agentMessage)累積;app-server 回合照寫
 * ~/.codex/sessions rollout(鏡像/導入零改動);thread/resume 接受 exec 建的既有 rollout id。
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppServerClient, AppServerDied } from "./appserver";
import { loadDriveState, saveDriveState, codexPermsFor, CODEX_AUTH_ERR_RE } from "./state";
import { workDir } from "./drive";
import { deriveMeta, discoverRollouts } from "./mirror";
import { fallbackTitle, titleMode } from "./titles";
import { materializeAttachment } from "./attachments";
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
import type { Mirror } from "./mirror";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 必须与 iOS E2EControlCrypto.maxPayloadBytes 一致；设备会拒绝更大的解密 JSON。 */
const E2E_APPROVAL_PLAINTEXT_MAX_BYTES = 64 * 1024;

function sameLocalUUID(a: string, b: string): boolean {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  return UUID_RE.test(lowerA) && UUID_RE.test(lowerB) && lowerA === lowerB;
}

/** #279 E2E prompt 解密失敗的用戶可見回執(僅提示語,零內容洩漏;四連接器同文案)。 */
const E2E_DECRYPT_FAIL_WARNING = "無法解密這條消息(設備與連接器的加密密鑰可能失步)——請重試,或重新關閉再開啟本會話的端到端加密。";

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


function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 審批策略:untrusted(白名單外全問)/on-request(模型自行請求升權)/never。默認 on-request——
 * 沙箱(workspace-write)兜底安全,審批卡只在越沙箱時彈,手機端不被刷屏。 */
function approvalPolicy(): string {
  const m = process.env.MACCHIATO_CODEX_APPROVAL;
  const ok = ["untrusted", "on-request", "never"];
  if (m && ok.includes(m)) return m;
  if (m) console.error(`[drive2] 忽略非法 MACCHIATO_CODEX_APPROVAL=${m}(${ok.join("/")})`);
  return "on-request";
}
/** 沙箱模式(與 v1 同 env)。 */
function sandboxMode(): string {
  const m = process.env.MACCHIATO_CODEX_SANDBOX;
  const ok = ["read-only", "workspace-write", "danger-full-access"];
  if (m && ok.includes(m)) return m;
  return "workspace-write";
}

/** #153 同款工具卡,v2 item 形狀(camelCase:aggregatedOutput/exitCode;schema 0.144.1)。 */
export function toolCardForV2(it: any): { name: string; args: Record<string, unknown>; resultText: string; error?: string } {
  const type = String(it?.type ?? "tool");
  if (type === "commandExecution") {
    const exit = typeof it.exitCode === "number" ? it.exitCode : undefined;
    return {
      name: "command",
      args: { command: String(it.command ?? "") },
      resultText: String(it.aggregatedOutput ?? ""),
      ...(exit !== undefined && exit !== 0 ? { error: `exit ${exit}` } : {}),
    };
  }
  if (type === "fileChange") {
    return {
      name: "file_change",
      args: { changes: it.changes ?? [] },
      resultText: String(it.status ?? ""),
      ...(String(it.status ?? "") === "failed" ? { error: "failed" } : {}),
    };
  }
  if (type === "mcpToolCall") {
    const server = String(it.server ?? "");
    const tool = String(it.tool ?? "");
    return {
      name: server || tool ? `mcp:${[server, tool].filter(Boolean).join(".")}` : "mcpToolCall",
      args: it.arguments && typeof it.arguments === "object" ? it.arguments : {},
      resultText: String(it.result ?? it.status ?? ""),
      ...(String(it.status ?? "") === "failed" ? { error: "failed" } : {}),
    };
  }
  if (type === "webSearch") {
    return { name: "web_search", args: { query: String(it.query ?? "") }, resultText: String(it.status ?? "") };
  }
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(it ?? {})) {
    if (k === "id" || k === "type") continue;
    args[k] = typeof v === "string" && v.length > 500 ? v.slice(0, 500) + "…" : v;
  }
  return { name: type, args, resultText: String(it.command ?? it.text ?? it.status ?? "") };
}

/** app-server 的 UserInput(schema 0.144.1;skill 臂 #317)。 */
type UserInput =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string };

interface ActiveTurn {
  threadId: string;
  turnId?: string;
  started: boolean; // message.start 已發
  agentText: string;
  /** 當前正在流 delta 的 agentMessage itemId + 已流出長度(item/completed 補尾用)。 */
  deltaItem?: string;
  deltaLen: number;
  reasoningSeen: Set<string>;
  toolItems: Map<string, { name: string }>;
  usage: Record<string, unknown>;
  isE2E: boolean;
  isFirstMacchiatoTurn: boolean;
  lastError?: string;
  /** #245 interrupt 點在 turnId 未到位的窗口 → 掛起,turnId 到位即補發。 */
  interruptPending?: boolean;
}

type CodexApprovalKind = "command" | "fileChange";
type CodexApprovalExecutionSnapshot = {
  v: 1;
  connector: "codex-app-server";
  sessionId: string;
  requestId: string;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval";
  params: Record<string, unknown>;
};

function codexApprovalExecutionRequest(
  sid: string,
  requestId: string,
  kind: CodexApprovalKind,
  params: Record<string, unknown>,
): CodexApprovalExecutionSnapshot {
  return {
    v: 1,
    connector: "codex-app-server",
    sessionId: sid,
    requestId,
    method:
      kind === "command"
        ? "item/commandExecution/requestApproval"
        : "item/fileChange/requestApproval",
    params,
  };
}

interface PendingApproval {
  sid: string;
  /** #245 反向請求的 itemId(隨 approval.request 的 request_id 上行;respond 回帶則精準配對)。 */
  requestId?: string;
  /** #370 E2E 审批必须同时绑定请求摘要；非 E2E 保持 undefined。 */
  requestDigest?: string;
  /** digest、密文卡片以及该 reverse RPC decision 绑定的 immutable 完整请求。 */
  executionSnapshot?: CodexApprovalExecutionSnapshot;
  /** 仅用于执行前确认 AppServer 回调对象自请求后未发生 mutation。 */
  sourceParams?: Record<string, unknown>;
  kind?: CodexApprovalKind;
  resolve: (decision: string) => void;
}

export class AppServerDrive {
  /** #10:累計計數(與 v1 同鍵位,健康上報帶出)。engineAppServer=1 是引擎標記(v1 無此鍵)。 */
  readonly counters: Record<string, number> = { driveErrors: 0, approvalsRequested: 0, steers: 0, engineAppServer: 1, unknownNotifications: 0 };
  /** #310 認證失效持續態:auth 類回合失敗置 true(health 上報 authOk=false),成功回合恢復。 */
  authFailed = false;
  /** #258 已告警過的未知通知 method(去重,不刷屏)。 */
  private readonly loggedUnknownNotif = new Set<string>();
  private map: Record<string, string>;
  private cwds: Record<string, string>;
  private models: Record<string, string>;
  private efforts: Record<string, string>; // #231
  /** #230 serverSid → 會話 permissionMode(映射為 codex sandbox + approvalPolicy)。 */
  private perms: Record<string, string>;
  private pending: Set<string>;
  private titled: Set<string>;
  private abandonedTurns: string[] = [];
  private readonly active = new Map<string, ActiveTurn>();
  /** threadId → sid(通知路由)。 */
  private readonly byThread = new Map<string, string>();
  /** 本 app-server 進程裡已 start/resume 過的 thread(重啟後要重新 resume)。 */
  private readonly loadedThreads = new Set<string>();
  /** sid → 掛起中的審批(approval.respond 解掛;FIFO 對齊 CC)。 */
  private readonly approvals = new Map<string, PendingApproval[]>();
  private readonly pendingUser = new Map<string, string[]>();
  private readonly interruptedSids = new Set<string>();
  /** #224 自己 thread/name/set 寫過的 threadId→title(抑制回聲 thread/name/updated 重投 session.title)。 */
  private readonly renamedTitles = new Map<string, string>();
  /** 僅主身份快照完整解析，或已把當前完整映射成功雙寫，才可放行非 UUID E2E wire sid。 */
  private identityStateTrusted: boolean;
  private readonly e2eControl?: E2EControlVerifier;

  constructor(
    private readonly client: AppServerClient,
    private readonly linkb: LinkBClient,
    private readonly mirror?: Mirror,
    private readonly e2e?: E2EKeyStore,
    /** #227 回合末惰性版本化鉤子。 */
    private readonly projects?: { checkTurnEnd(): void },
    /** #317 skills 索引(name→SKILL.md 路徑),command.invoke 組 SkillUserInput 用。 */
    private readonly skills?: { pathFor(name: string): string | undefined },
    e2eControl?: E2EControlVerifier,
  ) {
    const st = loadDriveState();
    this.map = st.map;
    this.cwds = st.cwds;
    this.models = st.models;
    this.efforts = st.efforts;
    this.perms = st.perms;
    this.titled = st.titled;
    this.identityStateTrusted = st.identityStateTrusted;
    this.abandonedTurns = st.pending;
    this.pending = new Set();
    this.e2eControl = e2eControl ?? (e2e ? new E2EControlVerifier(e2e) : undefined);
    if (st.pending.length) this.saveMap();

    this.client.onNotification((m, p) => this.onNotification(m, p));
    this.client.onReverseRequest("item/commandExecution/requestApproval", (p) => this.onApprovalRequest(p, "command"));
    this.client.onReverseRequest("item/fileChange/requestApproval", (p) => this.onApprovalRequest(p, "fileChange"));
    // app-server 死了重啟:活躍回合已隨進程死 → 清盤 + 對用戶明說(不靜默吞)。
    this.client.onRestart = () => this.onServerRestart();
  }

  wire(): void {
    this.linkb.onFrame((m) => void this.onServerFrame(m));
  }

  dispose(): void {
    this.client.close();
  }

  /** #200:上個進程死於回合中途 → 提示重發(index.ts 在 ready 後調;冪等)。 */
  flushAbandonedTurns(): void {
    const sids = this.abandonedTurns;
    this.abandonedTurns = [];
    for (const sid of sids) {
      if (this.e2e?.isE2E(sid)) continue;
      this.emit(sid, "review.summary", { summary: "⚠️ 連接器剛重啟,上一條消息可能沒跑完——請重發一次。" });
    }
  }

  private emit(sid: string, type: string, payload: Record<string, unknown>): void {
    this.linkb.send({
      t: "tui",
      agentLinkId: this.linkb.agentLinkId,
      sessionId: sid,
      frame: { jsonrpc: "2.0", method: "event", params: { type, session_id: sid, payload } },
    });
  }

  private threadFor(sid: string): string | undefined {
    if (UUID_RE.test(sid)) return sid;
    return this.map[sid];
  }

  /** E2E backfill 的本地 rollout 身份；wire sid 由控制層原樣保留。 */
  localSessionIdFor(sid: string): string | undefined {
    return this.threadFor(sid);
  }

  private protectedWireSids(): string[] {
    const fn = (this.e2e as (E2EKeyStore & { protectedSessionIds?: () => string[] }) | undefined)
      ?.protectedSessionIds;
    return typeof fn === "function" ? fn.call(this.e2e) : [];
  }

  /** 禁止用 protected wire sid 对应的本地 thread UUID 另开明文身份直达同一线程。 */
  private protectedInboundAliasOwner(sid: string): string | undefined {
    return this.protectedWireSids().find((wireSid) => {
      if (wireSid === sid) return false;
      if (sameLocalUUID(wireSid, sid)) return true;
      const localSid = this.map[wireSid];
      return localSid !== undefined && (localSid === sid || sameLocalUUID(localSid, sid));
    });
  }

  /** 見 exec Drive 同名方法：壞/缺 sid↔thread 身份快照時禁止任何 plaintext fallback。 */
  assertE2EIdentitySafe(): void {
    const requiringMap = this.protectedWireSids().filter((sid) => !UUID_RE.test(sid));
    if (!requiringMap.length) return;
    const missing = requiringMap.filter((sid) => !UUID_RE.test(this.map[sid] ?? ""));
    if (!this.identityStateTrusted || missing.length) {
      throw new Error(
        `Codex E2E identity map unavailable/incomplete (trusted=${this.identityStateTrusted}, ` +
          `missing=${missing.slice(0, 3).join(",") || "unknown"}); refusing plaintext fallback`,
      );
    }
  }

  plaintextLocalMirrorAllowed(): boolean {
    try {
      this.assertE2EIdentitySafe();
      return true;
    } catch {
      return false;
    }
  }

  /** Mirror 的本地 UUID → E2E wire ULID 反向解析；只回傳仍受 E2E 保護的映射。 */
  e2eWireSessionIdFor(localSid: string): string | undefined {
    if (!this.e2e) return undefined;
    for (const [wireSid, mappedLocalSid] of Object.entries(this.map)) {
      if (mappedLocalSid === localSid && this.e2e.isE2E(wireSid)) return wireSid;
    }
    return undefined;
  }

  /** history import 的本地 UUID → wire sid E2E 判定快照；任一關聯 wire 為 E2E 即過濾。 */
  localSessionE2EStatus(): { isE2E(localSid: string): boolean } {
    const e2e = this.e2e;
    if (!e2e) return { isE2E: () => false };
    try {
      this.assertE2EIdentitySafe();
    } catch {
      return { isE2E: () => true };
    }
    const protectedLocal = new Set<string>();
    for (const [wireSid, localSid] of Object.entries(this.map)) {
      if (e2e.isE2E(wireSid)) protectedLocal.add(localSid);
    }
    return {
      isE2E: (localSid: string) => protectedLocal.has(localSid) || e2e.isE2E(localSid),
    };
  }

  private cwdFor(sid: string): string {
    const c = this.cwds[sid];
    if (!c) return workDir();
    if (c === "~") return homedir();
    return c.startsWith("~/") ? join(homedir(), c.slice(2)) : c;
  }
  private modelFor(sid: string): string | undefined {
    return this.models[sid] || process.env.MACCHIATO_CODEX_MODEL || undefined;
  }
  private effortFor(sid: string): string | undefined {
    return this.efforts[sid] || process.env.MACCHIATO_CODEX_EFFORT || undefined; // #231
  }
  /** #230 per-session sandbox/approval:permissionMode 映射優先(三檔),否則回退進程級 env 默認。
   *  注:app-server 的 sandbox/approval 在 thread start/resume 時定;會話啟動後再改要等線程重載才生效。 */
  private sandboxFor(sid: string): string {
    return codexPermsFor(this.perms[sid])?.sandbox ?? sandboxMode();
  }
  private approvalFor(sid: string): string {
    return codexPermsFor(this.perms[sid])?.approval ?? approvalPolicy();
  }

  // ============================== 下行(server → 連接器) ==============================

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
      if (
        verified.kind === "clarify.respond" ||
        verified.kind === "secret.respond" ||
        verified.kind === "task.stop"
      ) {
        throw new E2EControlError(`${verified.kind} is not supported by Codex`);
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
        `[drive2 rejected] Link B outer/params session mismatch: ${String(msg.sessionId)} != ${String(params.session_id)}`,
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
          await this.onPrompt(sid, params);
          return;
        }
        case "command.invoke": {
          // #317 skill 調用(composer / 菜單選中):組原生 SkillUserInput {type:"skill",name,path}
          // (schema 0.144.1;path 從 SkillsReporter 索引拿),args 附 text 項。索引未命中(skill
          // 已刪/改名/枚舉未跑)→ 回退 `$name` 文本(codex 原生 mention 語法),消息不丟。
          // E2E:invoke 幀本就明文(#199 既定設計),命令文本記入 pendingUser 供回合末密文回灌。
          const name = String(params.command ?? "")
            .trim()
            .replace(/^\//, "");
          if (!name) return;
          const args = String(params.args ?? "").trim();
          const path = this.skills?.pathFor(name);
          const input: UserInput[] = path
            ? [{ type: "skill", name, path }, ...(args ? [{ type: "text", text: args } as UserInput] : [])]
            : [{ type: "text", text: `$${name}${args ? ` ${args}` : ""}` }];
          const display = `/${name}${args ? ` ${args}` : ""}`;
          if (this.e2e?.isE2E(sid)) {
            const arr = this.pendingUser.get(sid) ?? [];
            arr.push(display);
            this.pendingUser.set(sid, arr);
          }
          const logDisplay =
            authenticated && args ? `/${name} [encrypted args]` : display;
          console.log(`· #317 command.invoke ${logDisplay}${path ? "" : "(索引未命中,回退 $name 文本)"} → ${sid}`);
          await this.dispatchInput(sid, input, display, authenticated !== undefined);
          return;
        }
        case "approval.respond": {
          // 審批卡回話 → 解掛反向請求。#245:優先按 request_id(=itemId)精準配對——codex 並行
          // 工具下同會話可同掛多個審批(command+fileChange 交錯),純 FIFO 會把回話錯配到先掛的
          // 請求(批錯命令);缺省回退 FIFO(舊 server 兼容,CC #102 同款)。allow+all →
          // acceptForSession(codex 原生會話級審批緩存);deny → decline(agent 收到拒絕並繼續)。
          const list = this.approvals.get(sid);
          if (!list?.length) {
            this.approvals.delete(sid);
            if (authenticated) throw new E2EControlError("no matching pending approval");
            return;
          }
          const reqId = typeof params.request_id === "string" ? params.request_id : "";
          const reqDigest = typeof params.requestDigest === "string" ? params.requestDigest : "";
          let p: PendingApproval | undefined;
          if (authenticated) {
            if (authenticated.kind !== "approval.respond" || !reqId || !reqDigest) {
              throw new E2EControlError("authenticated approval is missing request identity");
            }
            const i = list.findIndex(
              (item) => {
                if (
                  item.requestId !== reqId ||
                  item.requestDigest !== reqDigest ||
                  item.executionSnapshot === undefined ||
                  item.sourceParams === undefined ||
                  item.kind === undefined
                ) {
                  return false;
                }
                const key = this.e2e!.requireKey(sid);
                // 同时核验 immutable snapshot 与当前 reverse-RPC 对象；后者若被回调方修改，
                // 即使已签旧 digest 也不能放行。
                return (
                  e2eApprovalRequestDigest(key, item.executionSnapshot) === reqDigest &&
                  e2eApprovalRequestDigest(
                    key,
                    codexApprovalExecutionRequest(
                      sid,
                      reqId,
                      item.kind,
                      item.sourceParams,
                    ),
                  ) === reqDigest
                );
              },
            );
            if (i >= 0) p = list.splice(i, 1)[0];
            if (!p) throw new E2EControlError("approval request id/digest mismatch");
          } else {
            if (reqId) {
              const i = list.findIndex((x) => x.requestId === reqId);
              if (i >= 0) p = list.splice(i, 1)[0];
            }
            p ??= list.shift();
          }
          if (!list.length) this.approvals.delete(sid);
          if (!p) return;
          const choice = String(params.choice ?? "deny");
          const allow = choice === "allow" || choice === "yes" || choice === "always";
          const all = params.all === true;
          p.resolve(allow ? (all ? "acceptForSession" : "accept") : "decline");
          return;
        }
        case "session.interrupt": {
          const t = this.active.get(sid);
          if (!t) {
            if (authenticated) throw new E2EControlError("no active turn to interrupt");
            return;
          }
          this.interruptedSids.add(sid);
          if (t.turnId) {
            await this.client.request("turn/interrupt", { threadId: t.threadId, turnId: t.turnId });
            // ⚠️ 回歸契約:scripts/regression/run-codex-regression.mjs 斷言「turn/interrupt → 」,改動需同步
            console.log(`· turn/interrupt → ${sid}`);
          } else {
            // #245:turn/start 未返回的窗口點停止,舊實現靜默吞掉 → turnId 到位即補發
            t.interruptPending = true;
            console.log(`· interrupt 掛起(turnId 未到位,到位即補發)→ ${sid}`);
          }
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
        case "session.delete": {
          const tid = this.threadFor(sid);
          if (tid) this.mirror?.tombstone(tid); // #161 墓碑;不刪 rollout
          return;
        }
        case "session.rename": {
          // #224 改名回寫:app 改標題 → thread/name/set,codex 本地(TUI /resume 列表)看到同名。
          // 僅 app-server 引擎有此能力(exec drive 無此 case,靜默跳過)。無 thread(尚未建會話)→ 跳過。
          const tid = this.threadFor(sid);
          const title = typeof params.title === "string" ? params.title.trim() : "";
          if (tid && title) {
            try {
              await this.client.request("thread/name/set", { threadId: tid, name: title });
              this.renamedTitles.set(tid, title); // 標記自寫,回聲的 thread/name/updated 不再回投
              console.log(`· #224 thread/name/set ${tid} → ${title}`);
            } catch (e) {
              console.error(`[#224 thread/name/set failed ${tid}] ${(e as Error).message}`);
            }
          }
          return;
        }
        case "session.retitle": {
          // #257 app「重新生成標題」:codex 無 LLM 標題(截斷哲學)→ 從 rollout 首條 user 消息
          // 重算 fallbackTitle 並回投。此前無此 case、對 codex 是靜默 no-op。E2E 跳過(標題明文)。
          if (this.e2e?.isE2E(sid)) return;
          const tid = this.threadFor(sid);
          if (!tid) return;
          try {
            const rf = discoverRollouts().rollouts.find((r) => r.threadId === tid);
            if (!rf || !existsSync(rf.file)) return;
            const { title } = deriveMeta(readFileSync(rf.file, "utf8"));
            if (title && title !== "Codex") {
              this.emit(sid, "session.title", { title });
              console.log(`· #257 session.retitle ${sid} → ${title}`);
            }
          } catch (e) {
            console.error(`[#257 retitle failed ${sid}] ${(e as Error).message}`);
          }
          return;
        }
        case "session.archive":
          // #257 codex 無歸檔概念(不像 Hermes 有 state.db archived 列)——明確 no-op,不落 default。
          return;
        case "session.create": {
          const partial = authenticated !== undefined;
          if (!partial || Object.hasOwn(params, "cwd")) {
            const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
            this.persistSessionSetting(this.cwds, sid, cwd, authenticated, "cwd");
          }
          if (!partial || Object.hasOwn(params, "model")) {
            const md = typeof params.model === "string" ? params.model.trim() : "";
            this.persistSessionSetting(this.models, sid, md, authenticated, "model");
          }
          if (!partial || Object.hasOwn(params, "effort")) {
            const ef = typeof params.effort === "string" ? params.effort.trim() : ""; // #231
            this.persistSessionSetting(this.efforts, sid, ef, authenticated, "effort");
          }
          // #230 permissionMode(upsert)。空 = 回退進程級 env 默認。
          if (!partial || Object.hasOwn(params, "permissionMode")) {
            const pm = typeof params.permissionMode === "string" ? params.permissionMode.trim() : "";
            this.persistSessionSetting(this.perms, sid, pm, authenticated, "permissionMode");
          }
          const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
          if (cwd && !this.e2e?.isE2E(sid) && !isDir(this.cwdFor(sid))) {
            this.emit(sid, "review.summary", { summary: `⚠️ 工作目錄不存在或不是目錄:${this.cwdFor(sid)}(連接器主機上)` });
          }
          return;
        }
        default:
          return;
      }
    } catch (e) {
      this.counters.driveErrors += 1;
      console.error(`[drive2 ${frame.method} failed for ${sid}] ${(e as Error).message}`);
      if (authenticated) throw e;
    }
  }

  private async onPrompt(sid: string, params: Record<string, unknown>): Promise<void> {
    let text = String(params.text ?? "").trim();
    const atts = Array.isArray(params.attachments)
      ? (params.attachments as Array<{ id?: string; kind?: string; name?: string; mime?: string; url?: string }>)
      : [];
    // E2E 附件没有端到端密文/完整性协议；在任何 STT、网络或落盘副作用前拒绝整帧。
    if (atts.length && this.e2e?.isE2E(sid)) {
      console.error(`[E2E prompt rejected ${sid}] attachments are not supported`);
      return;
    }
    const images: UserInput[] = [];
    const attachNotes: string[] = [];
    for (const a of atts) {
      if (a?.kind === "audio" && a.id) {
        // #73/#89 無本地 STT → 立即回失敗回執(server 雲端 BYOK 回退鏈)。
        this.linkb.send({ t: "voice_transcript", agentLinkId: this.linkb.agentLinkId, sessionId: sid, attachmentId: a.id, text: "", error: "stt_unavailable" });
        continue;
      }
      if (!a?.url) continue;
      try {
        const p = await materializeAttachment(a);
        // #132 原生圖片:image 附件 → localImage UserInput(視覺直達,活測 "Red");其餘照舊路徑注入。
        if (a.kind === "image") images.push({ type: "localImage", path: p });
        else attachNotes.push(`[Macchiato 附件 ${a.name ?? "file"}(${a.mime ?? "?"})已保存到:${p}]`);
      } catch (e) {
        console.error(`[attachment failed for ${sid}] ${(e as Error).message}`);
        if (!this.e2e?.isE2E(sid)) {
          this.emit(sid, "review.summary", { summary: `⚠️ 附件 ${a.name ?? ""} 下載失敗:${(e as Error).message.slice(0, 120)}` });
        }
      }
    }
    if (!text && !attachNotes.length && !images.length) return;
    if (this.e2e?.isE2E(sid)) {
      try {
        text = this.e2e.decryptText(sid, text).trim();
      } catch (e) {
        console.error(`[E2E prompt decrypt failed for ${sid}] ${(e as Error).message}`);
        // #279:靜默丟=用戶氣泡「已發送」卻永無回應。回 error 終態回合(僅提示語,零內容洩漏)。
        this.emit(sid, "message.start", {});
        this.emit(sid, "message.complete", { text: "", status: "error", warning: E2E_DECRYPT_FAIL_WARNING });
        return;
      }
      if (!text && !images.length) return;
      const arr = this.pendingUser.get(sid) ?? [];
      arr.push(text);
      this.pendingUser.set(sid, arr);
    }
    if (attachNotes.length) text = [text, ...attachNotes].filter(Boolean).join("\n\n");
    const input: UserInput[] = [...(text ? [{ type: "text", text } as UserInput] : []), ...images];
    await this.dispatchInput(sid, input, text);
  }

  /**
   * #132/#317 投遞一回合輸入(prompt.submit 與 command.invoke 共用):
   * mid-turn steer:回合進行中 → turn/steer 注入(expectedTurnId 防競態);
   * steer 失敗(回合恰好剛結束/turnId 不匹配)→ 回退起新回合,消息絕不丟。
   */
  private async dispatchInput(
    sid: string,
    input: UserInput[],
    firstText: string,
    requireDelivery = false,
  ): Promise<void> {
    const running = this.active.get(sid);
    if (running?.turnId) {
      try {
        await this.client.request("turn/steer", { threadId: running.threadId, expectedTurnId: running.turnId, input });
        this.counters.steers += 1;
        // ⚠️ 回歸契約:scripts/regression/run-codex-regression.mjs 斷言「turn/steer 注入跟進消息」,改動需同步
        console.log(`· turn/steer 注入跟進消息 → ${sid}`);
        return;
      } catch (e) {
        console.log(`· steer 未命中(${(e as Error).message.slice(0, 120)})→ 起新回合`);
      }
    }
    await this.runTurn(sid, input, firstText, requireDelivery);
  }

  private async runTurn(
    sid: string,
    input: UserInput[],
    firstText: string,
    requireDelivery = false,
  ): Promise<void> {
    const isE2E = this.e2e?.isE2E(sid) ?? false;
    const cwd = this.cwdFor(sid);
    if (!isDir(cwd)) {
      const err = `⚠️ 工作目錄不存在或不是目錄:${cwd}(連接器主機上)。請修正會話目錄後重發。`;
      if (isE2E) this.sendE2ETurn(sid, err);
      else this.emit(sid, "review.summary", { summary: err });
      if (requireDelivery) throw new E2EControlError(err);
      return;
    }
    let threadId = this.threadFor(sid);
    const isFirstMacchiatoTurn = !threadId && !UUID_RE.test(sid) && !isE2E;
    if (isFirstMacchiatoTurn && !this.titled.has(sid) && firstText) this.maybeTitle(sid, firstText);
    try {
      if (threadId && !this.loadedThreads.has(threadId)) {
        await this.client.request("thread/resume", { threadId, cwd, approvalPolicy: this.approvalFor(sid), sandbox: this.sandboxFor(sid) });
        this.loadedThreads.add(threadId);
      } else if (!threadId) {
        const ts = await this.client.request("thread/start", { cwd, approvalPolicy: this.approvalFor(sid), sandbox: this.sandboxFor(sid) });
        threadId = String(ts?.thread?.id ?? "");
        if (!threadId) throw new Error("thread/start 未返回 thread.id");
        this.loadedThreads.add(threadId);
        if (!UUID_RE.test(sid)) {
          this.map[sid] = threadId;
          this.saveMap();
        }
      }
      this.byThread.set(threadId, sid);
      this.mirror?.setDriven(threadId); // live 獨佔投遞
      const turn: ActiveTurn = {
        threadId,
        started: false,
        agentText: "",
        deltaLen: 0,
        reasoningSeen: new Set(),
        toolItems: new Map(),
        usage: {},
        isE2E,
        isFirstMacchiatoTurn,
      };
      this.active.set(sid, turn);
      this.pending.add(sid); // #200
      this.saveMap();
      const model = this.modelFor(sid);
      const effort = this.effortFor(sid); // #231 per-turn reasoning effort
      const res = await this.client.request("turn/start", { threadId, input, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      // turn/start 立即返回(探針);turnId 也會隨 turn/started 通知到,這裡先記省一拍。
      if (res?.turn?.id) turn.turnId = String(res.turn.id);
      if (turn.turnId && turn.interruptPending) void this.fireDeferredInterrupt(sid, turn); // #245
    } catch (e) {
      this.active.delete(sid);
      this.pending.delete(sid);
      this.saveMap();
      const msg = e instanceof AppServerDied ? "codex app-server 不可用(重啟中),請稍後重發" : (e as Error).message.slice(0, 200);
      if (isE2E) this.sendE2ETurn(sid, `❌ 回合啟動失敗:${msg}`);
      else this.emit(sid, "review.summary", { summary: `❌ 回合啟動失敗:${msg}` });
      this.counters.driveErrors += 1;
      if (requireDelivery) throw e;
    }
  }

  // ============================== 上行(app-server 通知 → server) ==============================

  private onNotification(method: string, p: any): void {
    const threadId = String(p?.threadId ?? "");
    const sid = threadId ? this.byThread.get(threadId) : undefined;
    if (!sid) return;
    const turn = this.active.get(sid);
    switch (method) {
      case "turn/started": {
        if (turn && !turn.turnId) turn.turnId = String(p.turn?.id ?? "");
        if (turn?.turnId && turn.interruptPending) void this.fireDeferredInterrupt(sid, turn); // #245
        return;
      }
      case "thread/name/updated": {
        // #224 codex 自己起的 thread 名 → session.title(替代首條消息截斷的土標題)。
        // 自寫回聲(session.rename 觸發的)不回投;E2E 跳過(標題事件明文,#113 紀律)。
        const name = typeof p.threadName === "string" ? p.threadName.trim() : "";
        if (!name || this.e2e?.isE2E(sid)) return;
        if (this.renamedTitles.get(threadId) === name) {
          this.renamedTitles.delete(threadId);
          return;
        }
        this.emit(sid, "session.title", { title: name });
        console.log(`· #224 thread/name/updated → session.title(${sid})`);
        return;
      }
      case "item/agentMessage/delta": {
        if (!turn) return;
        const itemId = String(p.itemId ?? "");
        const delta = String(p.delta ?? "");
        if (!delta) return;
        this.startMsg(sid, turn);
        // 換 agentMessage item(commentary → final_answer)→ 段落分隔,對齊 v1 的 "\n\n" join。
        if (turn.deltaItem && turn.deltaItem !== itemId && turn.agentText) {
          turn.agentText += "\n\n";
          if (!turn.isE2E) this.emit(sid, "message.delta", { text: "\n\n" });
        }
        if (turn.deltaItem !== itemId) {
          turn.deltaItem = itemId;
          turn.deltaLen = 0;
        }
        turn.agentText += delta;
        turn.deltaLen += delta.length;
        if (!turn.isE2E) this.emit(sid, "message.delta", { text: delta });
        return;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        if (!turn || turn.isE2E) return;
        const delta = String(p.delta ?? "");
        if (!delta) return;
        this.startMsg(sid, turn);
        turn.reasoningSeen.add(String(p.itemId ?? ""));
        this.emit(sid, "reasoning.delta", { text: delta });
        return;
      }
      case "item/started":
      case "item/completed": {
        if (!turn) return;
        this.onItem(sid, turn, method === "item/completed", p.item ?? {});
        return;
      }
      case "thread/tokenUsage/updated": {
        // #141 同款回合 token 計數 + 定稿 usage(turn/completed 不帶 usage,靠這裡最後一拍)。
        const last = p.tokenUsage?.last ?? {};
        if (turn) {
          turn.usage = {
            input_tokens: last.inputTokens,
            output_tokens: last.outputTokens,
            cached_input_tokens: last.cachedInputTokens,
            reasoning_output_tokens: last.reasoningOutputTokens,
          };
          if (!turn.isE2E && typeof last.outputTokens === "number") {
            this.emit(sid, "turn.usage", { output_tokens: last.outputTokens });
          }
        }
        return;
      }
      case "error": {
        if (turn) turn.lastError = String(p.message ?? "");
        return;
      }
      case "turn/completed": {
        if (!turn) return;
        this.finishTurn(sid, turn, p.turn ?? {});
        return;
      }
      default:
        // #258 已知線程的未處理通知 method = codex 可能升版改了通知面(delta/審批等可能靜默消失)。
        // 此前 default 一行 log 都不打 → 無感知。去重告警 + 計數(health 帶出 unknownNotifications)。
        if (!this.loggedUnknownNotif.has(method)) {
          this.loggedUnknownNotif.add(method);
          console.error(`[#258 未知 app-server 通知 method=${method}——codex 可能升版改了通知面,請查是否需處理(delta 恐靜默消失)]`);
        }
        this.counters.unknownNotifications += 1;
        return;
    }
  }

  private onItem(sid: string, turn: ActiveTurn, completed: boolean, it: any): void {
    const type = String(it?.type ?? "");
    if (type === "agentMessage") {
      if (!completed) return;
      const text = String(it.text ?? "");
      // delta 已流出的部分不重發;斷流(通知丟失)時補尾,保定稿完整。
      if (String(it.id ?? "") === turn.deltaItem) {
        const missing = text.slice(turn.deltaLen);
        if (missing) {
          turn.agentText += missing;
          if (!turn.isE2E) this.emit(sid, "message.delta", { text: missing });
        }
        turn.deltaLen = text.length;
      } else if (text) {
        this.startMsg(sid, turn);
        const chunk = turn.agentText ? "\n\n" + text : text;
        turn.agentText += chunk;
        if (!turn.isE2E) this.emit(sid, "message.delta", { text: chunk });
      }
      return;
    }
    if (type === "reasoning") {
      // 思考正文走 textDelta 流;沒流過的(只有 summary 定稿)補整條。
      if (!completed || turn.isE2E) return;
      if (turn.reasoningSeen.has(String(it.id ?? ""))) return;
      const parts = [...(Array.isArray(it.summary) ? it.summary : []), ...(Array.isArray(it.content) ? it.content : [])];
      const rtext = parts
        .map((s: any) => (typeof s === "string" ? s : String(s?.text ?? "")))
        .filter(Boolean)
        .join("\n");
      if (rtext) {
        this.startMsg(sid, turn);
        this.emit(sid, "reasoning.delta", { text: rtext });
      }
      return;
    }
    if (type === "userMessage" || type === "") return; // 自己的輸入回顯,不投
    // 工具類 item(commandExecution/fileChange/mcpToolCall/webSearch/未知)。
    const id = String(it.id ?? `${type}-${turn.toolItems.size}`);
    const card = toolCardForV2(it);
    if (!completed) {
      turn.toolItems.set(id, { name: card.name });
      this.startMsg(sid, turn);
      if (!turn.isE2E) this.emit(sid, "tool.start", { tool_id: id, name: card.name });
    } else if (turn.toolItems.has(id) && !turn.isE2E) {
      this.emit(sid, "tool.complete", {
        tool_id: id,
        name: card.name,
        args: card.args,
        result: null,
        result_text: card.resultText.slice(0, 20_000),
        ...(card.error ? { error: card.error } : {}),
      });
    }
  }

  private startMsg(sid: string, turn: ActiveTurn): void {
    if (turn.started || turn.isE2E) return;
    turn.started = true;
    this.emit(sid, "message.start", {});
  }

  private finishTurn(sid: string, turn: ActiveTurn, turnObj: any): void {
    this.active.delete(sid);
    this.pending.delete(sid);
    this.saveMap();
    // 懸空審批(回合結束仍沒人回)→ decline 收尾,別讓反向請求永久掛起。
    for (const p of this.approvals.get(sid) ?? []) p.resolve("decline");
    this.approvals.delete(sid);
    const interrupted = this.interruptedSids.delete(sid);
    const st = String(turnObj.status ?? "completed"); // TurnStatus: completed/interrupted/failed/inProgress
    const status = st === "failed" ? "error" : st === "interrupted" || interrupted ? "interrupted" : "complete";
    const errMsg = turnObj.error?.message ?? turn.lastError;
    // #310 認證失效偵測:auth 類失敗置持續態(health authOk=false → app 顯降級);成功回合恢復。
    const authErr = status === "error" && CODEX_AUTH_ERR_RE.test(String(errMsg ?? ""));
    if (authErr) this.authFailed = true;
    else if (status === "complete") this.authFailed = false;
    if (turn.isE2E) {
      this.sendE2ETurn(sid, turn.agentText);
    } else {
      if (status === "error" && !turn.agentText) {
        // #310 auth 失敗給可行動文案(而非裸錯誤串,用戶不知道要去終端 login)
        this.emit(sid, "review.summary", {
          summary: authErr
            ? "❌ Codex 登錄已失效——請在連接器主機終端跑 `codex login` 重新登錄後重試"
            : `❌ 回合失敗:${String(errMsg ?? "unknown").slice(0, 200)}`,
        });
      }
      this.startMsg(sid, turn);
      this.emit(sid, "message.complete", { text: turn.agentText, status, usage: turn.usage });
    }
    this.mirror?.fastForward(turn.threadId);
    this.mirror?.unsetDriven(turn.threadId);
    this.projects?.checkTurnEnd(); // #227
  }

  // ============================== 審批橋 ==============================

  /** #245:補發掛起的 interrupt(點停止時 turn/start 尚未返回)。 */
  private async fireDeferredInterrupt(sid: string, turn: ActiveTurn): Promise<void> {
    turn.interruptPending = false;
    try {
      await this.client.request("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId });
      console.log(`· turn/interrupt(補發) → ${sid}`);
    } catch (e) {
      console.error(`[#245 補發 interrupt 失敗 ${sid}] ${(e as Error).message}`);
    }
  }

  /** 反向請求 → approval.request 卡(payload 對齊 CC 的形狀);掛起等 approval.respond。 */
  private onApprovalRequest(p: any, kind: CodexApprovalKind): Promise<Record<string, unknown>> {
    const sid = this.byThread.get(String(p?.threadId ?? ""));
    if (!sid) return Promise.resolve({ decision: "decline" }); // 不認識的 thread(不該發生)
    this.counters.approvalsRequested += 1;
    const sourceParams = p as Record<string, unknown>;
    // #240 E2E:命令全文/文件路徑/cwd 都敏感 → 加密進 enc,明文只留占位 + 類別 + request_id。
    const isE2E = this.e2e?.isE2E(sid) ?? false;
    const requestId = p.itemId ? String(p.itemId) : isE2E ? randomUUID() : undefined;
    let executionSnapshot: CodexApprovalExecutionSnapshot | undefined;
    let executionDisplay: string | undefined;
    if (isE2E && requestId) {
      try {
        executionSnapshot = immutableE2EApprovalSnapshot<CodexApprovalExecutionSnapshot>(
          codexApprovalExecutionRequest(sid, requestId, kind, sourceParams),
        );
        executionDisplay = canonicalE2EApprovalDisplay(executionSnapshot);
      } catch (error) {
        console.error(
          `[E2E approval auto-declined ${sid}] ${error instanceof Error ? error.message : String(error)}`,
        );
        return Promise.resolve({ decision: "decline" });
      }
    }
    const request = executionSnapshot?.params ?? sourceParams;
    const command =
      kind === "command"
        ? String(request.command ?? "")
        : `修改文件:${(Array.isArray(request.changes) ? request.changes : []).map((c: any) => String(c?.path ?? "")).filter(Boolean).join(", ").slice(0, 300) || "(見詳情)"}`;
    const reason = request.reason ? String(request.reason) : "";
    const cmd = command.slice(0, 500);
    const desc = reason || (kind === "command" ? `Codex 想在 ${String(request.cwd ?? "")} 執行命令` : "Codex 想寫入以上文件");
    const patternKey = kind === "command" ? "shell" : "fileChange";
    const requestDigest =
      executionSnapshot
        ? e2eApprovalRequestDigest(this.e2e!.requireKey(sid), executionSnapshot)
        : undefined;
    const approvalPlaintext =
      isE2E && requestId && requestDigest
        ? {
            command: cmd,
            description: desc,
            patternKey,
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
        `[E2E approval auto-declined ${sid}] encrypted approval payload exceeds device limit`,
      );
      return Promise.resolve({ decision: "decline" });
    }
    // 尺寸闸门必须先于 emit / approvals.push；否则设备拒绝卡片后本地反向请求会永久挂起。
    const enc = approvalPlaintext
      ? this.e2e!.encryptContent(sid, approvalPlaintext)
      : undefined;
    this.emit(sid, "approval.request", {
      command: isE2E ? "🔒 加密審批請求" : cmd,
      pattern_key: patternKey,
      pattern_keys: [patternKey],
      description: isE2E ? "" : desc,
      ...(enc ? { enc } : {}),
      ...(requestId ? { request_id: requestId } : {}),
      ...(requestDigest ? { request_digest: requestDigest } : {}),
    });
    return new Promise((resolve) => {
      const list = this.approvals.get(sid) ?? [];
      list.push({
        sid,
        requestId,
        requestDigest,
        executionSnapshot,
        sourceParams: executionSnapshot ? sourceParams : undefined,
        kind: executionSnapshot ? kind : undefined,
        resolve: (decision) => resolve({ decision }),
      });
      this.approvals.set(sid, list);
    });
  }

  // ============================== 其餘(與 v1 對齊) ==============================

  /** app-server 重啟:活躍回合已死 → 定稿 interrupted + 提示重發;thread 需重新 resume。 */
  private onServerRestart(): void {
    this.loadedThreads.clear();
    for (const [sid, turn] of [...this.active]) {
      this.active.delete(sid);
      this.pending.delete(sid);
      for (const p of this.approvals.get(sid) ?? []) p.resolve("decline");
      this.approvals.delete(sid);
      if (turn.isE2E) {
        this.sendE2ETurn(sid, turn.agentText);
      } else {
        this.startMsg(sid, turn);
        this.emit(sid, "message.complete", { text: turn.agentText, status: "interrupted", usage: turn.usage });
        this.emit(sid, "review.summary", { summary: "⚠️ codex app-server 重啟,這一回合被打斷——請重發一次。" });
      }
      this.mirror?.unsetDriven(turn.threadId);
    }
    this.saveMap();
  }

  /**
   * #224 app-server 標題:codex 原生 thread/name/updated 提供好標題並覆蓋。這裡只即時落一個
   * **便宜的截斷佔位**(不再起額外 codex exec 生成標題——那在 app-server 下純屬浪費),讓會話立刻
   * 有名、codex 的原生名一到就蓋掉。E2E 不落(明文標題,#113 紀律)。
   */
  private maybeTitle(sid: string, firstUserText: string): void {
    try {
      this.titled.add(sid);
      this.saveMap();
      if (titleMode() === "off") return; // off:不落佔位(codex 原生名或無)
      const title = fallbackTitle(firstUserText);
      if (!title) return;
      this.emit(sid, "session.title", { title });
    } catch (e) {
      console.error(`[title placeholder failed for ${sid}] ${(e as Error).message}`);
    }
  }

  private sendE2ETurn(sid: string, reply: string): void {
    if (!this.e2e) return;
    const msgs: Record<string, unknown>[] = (this.pendingUser.get(sid) ?? []).map((t) => ({ role: "user", enc: this.e2e!.encryptContent(sid, { text: t }) }));
    this.pendingUser.delete(sid);
    if (reply.trim()) msgs.push({ role: "agent", enc: this.e2e.encryptContent(sid, { text: reply }) });
    if (!msgs.length) return;
    this.linkb.send({ t: "mirror_append", agentLinkId: this.linkb.agentLinkId, sessions: [{ hermesSessionId: sid, source: "codex", e2e: true, messages: msgs }] });
  }

  private persistSessionSetting(
    target: Record<string, string>,
    sid: string,
    value: string,
    authenticated: AuthenticatedControlTag | undefined,
    label: string,
  ): void {
    const hadPrevious = Object.hasOwn(target, sid);
    const previous = target[sid];
    if (value ? previous === value : !hadPrevious) return;
    if (value) target[sid] = value;
    else delete target[sid];
    if (this.saveMap()) return;
    if (hadPrevious) target[sid] = previous!;
    else delete target[sid];
    if (authenticated) {
      throw new E2EControlError(`failed to persist authenticated ${label}`);
    }
  }

  private saveMap(): boolean {
    const saved = saveDriveState({ map: this.map, cwds: this.cwds, models: this.models, efforts: this.efforts, perms: this.perms, titled: this.titled, pending: this.pending });
    if (saved) {
      const protectedIds = this.protectedWireSids().filter((sid) => !UUID_RE.test(sid));
      if (protectedIds.every((sid) => UUID_RE.test(this.map[sid] ?? ""))) this.identityStateTrusted = true;
    }
    return saved;
  }
}
