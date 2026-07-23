/**
 * Drive:Macchiato → Codex 的雙向橋(spawn `codex exec --json` 每回合;JSONL stdout → tui 事件)。
 *
 * 下行(server → 連接器, t:"tui" 幀):
 *   prompt.submit     → spawn codex exec(首回合)/ codex exec resume <thread>(續聊);
 *                       回合進行中 → 排隊,回合結束續投(SDK 無 mid-turn steer;v1 同 CC 早期)
 *   session.interrupt → kill 子進程(exec 無 turn/interrupt RPC;app-server 才有 → v2)
 *   session.create    → 登記 cwd(會話本體由首回合建)
 * 上行(codex exec JSONL → server tui EVENT):
 *   thread.started {thread_id}          → 存映射(Macchiato ULID sid ↔ codex thread uuid)
 *   item.completed agent_message        → message.delta(整條)+ 末尾 message.complete
 *   item.started/completed 工具類        → tool.start / tool.complete
 *   turn.completed {usage}              → message.complete{status, usage}(#102 花費)
 *
 * 會話映射:鏡像來的 sid = codex thread uuid → 直接 resume;Macchiato 新建(ULID sid)首回合
 * 拿 thread_id 後持久映射(~/.macchiato/codex-sessions.json)。無映射則重啟後續聊丟上下文。
 *
 * 沙箱:非交互驅動需不卡審批。默認 workspace-write(可 env 調);danger-full-access 需顯式開。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadDriveState, saveDriveState, codexPermsFor, CODEX_AUTH_ERR_RE } from "./state";
import { resolveCodexBin } from "./codex-bin";
import { deriveMeta, discoverRollouts } from "./mirror";
import { generateTitle } from "./titles";
import { materializeAttachment } from "./attachments";
import type { LinkBClient } from "../linkb/client";
import type { E2EKeyStore } from "../e2e/keys";
import {
  dispatchForE2EControl,
  E2EControlError,
  E2EControlVerifier,
  type E2EControlEnvelopeV1,
  type E2EControlKind,
} from "../e2e/control";
import type { Mirror } from "./mirror";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

export function workDir(): string {
  return process.env.MACCHIATO_CODEX_WORKDIR || homedir();
}
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
/** 沙箱模式:read-only / workspace-write / danger-full-access。默認 workspace-write。 */
function sandboxMode(): string {
  const m = process.env.MACCHIATO_CODEX_SANDBOX;
  const ok = ["read-only", "workspace-write", "danger-full-access"];
  if (m && ok.includes(m)) return m;
  if (m) console.error(`[drive] 忽略非法 MACCHIATO_CODEX_SANDBOX=${m}(${ok.join("/")})`);
  return "workspace-write";
}

/**
 * #153 工具卡取實料(活測 2026-07-14 形狀:command_execution 帶 command/aggregated_output/exit_code/status)。
 * 按 item 子類型填 args/result/error;未知類型回退整個 item(去大字段)——別再恆 {}。
 */
export function toolCardFor(it: any): { name: string; args: Record<string, unknown>; resultText: string; error?: string } {
  const type = String(it?.type ?? "tool");
  if (type === "command_execution") {
    const exit = typeof it.exit_code === "number" ? it.exit_code : undefined;
    return {
      name: "command",
      args: { command: String(it.command ?? "") },
      resultText: String(it.aggregated_output ?? ""),
      ...(exit !== undefined && exit !== 0 ? { error: `exit ${exit}` } : {}),
    };
  }
  if (type === "file_change") {
    return {
      name: "file_change",
      args: { changes: it.changes ?? it.files ?? [] },
      resultText: String(it.status ?? ""),
      ...(String(it.status ?? "") === "failed" ? { error: "failed" } : {}),
    };
  }
  if (type === "mcp_tool_call") {
    const server = String(it.server ?? "");
    const tool = String(it.tool ?? "");
    return {
      name: server || tool ? `mcp:${[server, tool].filter(Boolean).join(".")}` : "mcp_tool_call",
      args: it.arguments && typeof it.arguments === "object" ? it.arguments : {},
      resultText: String(it.result ?? it.status ?? ""),
      ...(String(it.status ?? "") === "failed" ? { error: "failed" } : {}),
    };
  }
  if (type === "web_search") {
    return { name: "web_search", args: { query: String(it.query ?? "") }, resultText: String(it.status ?? "") };
  }
  // 未知類型:整個 item 去掉 id/type 與超長字段當 args——保住信息量。
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(it ?? {})) {
    if (k === "id" || k === "type") continue;
    args[k] = typeof v === "string" && v.length > 500 ? v.slice(0, 500) + "…" : v;
  }
  return { name: type, args, resultText: String(it.command ?? it.text ?? it.status ?? "") };
}

interface Turn {
  proc: ChildProcess;
  stdoutBuf: string;
  agentText: string; // 累積 agent 文本(complete 定稿)
  started: boolean;
  completed: boolean;
  usage: Record<string, unknown>;
  isE2E: boolean;
  isFirstMacchiatoTurn: boolean;
  toolItems: Map<string, { name: string }>;
}

export class Drive {
  /** #10:累計計數(進程生命週期),健康上報帶出。 */
  readonly counters: Record<string, number> = { driveErrors: 0 };
  /** #310 認證失效持續態:auth 類回合失敗置 true(health 上報 authOk=false),成功回合恢復。 */
  authFailed = false;
  /** serverSid → codex thread uuid(跨重啟持久)。 */
  private map: Record<string, string>;
  /** serverSid → 會話工作目錄。 */
  private cwds: Record<string, string>;
  /** #143 serverSid → 會話 model(session.create.model 下發;持久,同文件存)。 */
  private models: Record<string, string>;
  private efforts: Record<string, string>; // #231
  /** #230 serverSid → 會話 permissionMode(session.create.permissionMode;映射為 codex sandbox)。 */
  private perms: Record<string, string>;
  /** #200 在途回合 sid 集(持久):回合起加、止刪;進程死於回合中途 → 下次啟動提示重發。 */
  private pending: Set<string>;
  /** #200 上個進程死時遺留的在途回合(構造載入即清盤;flushAbandonedTurns 在 ready 後告知)。 */
  private abandonedTurns: string[] = [];
  /** sid → 進行中回合。 */
  private readonly active = new Map<string, Turn>();
  /** sid → 排隊的後續 prompt。 */
  private readonly queued = new Map<string, string[]>();
  /** sid → E2E 回合暫存的(已解密)用戶消息。 */
  private readonly pendingUser = new Map<string, string[]>();
  /** #145 sid → 本回合被 session.interrupt 中斷(result 定性 interrupted 而非 complete)。 */
  private readonly interruptedSids = new Set<string>();
  /** #113 已生成標題的 sid(持久)。 */
  private titled: Set<string>;
  private genTitle: string | undefined;
  /** 僅主身份快照完整解析，或已把當前完整映射成功雙寫，才可放行非 UUID E2E wire sid。 */
  private identityStateTrusted: boolean;
  private readonly e2eControl?: E2EControlVerifier;

  constructor(
    private readonly linkb: LinkBClient,
    private readonly mirror?: Mirror,
    private readonly e2e?: E2EKeyStore,
    /** #227 回合末惰性版本化鉤子。 */
    private readonly projects?: { checkTurnEnd(): void },
    e2eControl?: E2EControlVerifier,
  ) {
    const st = this.loadState();
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
  }

  /** #200:對上個進程死時被殺的在途回合回 system 提示(Link B ready 後由 index.ts 調;冪等)。 */
  flushAbandonedTurns(): void {
    const sids = this.abandonedTurns;
    this.abandonedTurns = [];
    for (const sid of sids) {
      if (this.e2e?.isE2E(sid)) continue;
      this.emit(sid, "review.summary", { summary: "⚠️ 連接器剛重啟,上一條消息可能沒跑完——請重發一次。" });
    }
  }

  /**
   * #143 該會話當前 model:per-session 選擇優先,回退 env `MACCHIATO_CODEX_MODEL`,都無 →
   * undefined(不傳 -m,用 codex 自身配置默認)。絕不 hardcode(鐵律)——只透傳用戶所選。
   */
  private modelFor(sid: string): string | undefined {
    return this.models[sid] || process.env.MACCHIATO_CODEX_MODEL || undefined;
  }
  private effortFor(sid: string): string | undefined {
    return this.efforts[sid] || process.env.MACCHIATO_CODEX_EFFORT || undefined; // #231
  }

  /**
   * #230 該會話 sandbox:per-session permissionMode 映射優先(plan/auto/bypass 三檔),
   * 否則回退進程級 env 默認 `sandboxMode()`。exec 非交互,approval 不適用,只取 sandbox。
   */
  private sandboxFor(sid: string): string {
    return codexPermsFor(this.perms[sid])?.sandbox ?? sandboxMode();
  }

  wire(): void {
    this.linkb.onFrame((m) => void this.onServerFrame(m));
  }

  dispose(): void {
    for (const t of this.active.values()) t.proc.kill("SIGTERM");
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
    if (UUID_RE.test(sid)) return sid; // 鏡像會話:sid 即 codex thread id
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

  /**
   * 不可信 server 不能把受保护 wire sid 的本地 Codex thread UUID 当成另一条“普通会话”
   * 重新下发。threadFor(UUID) 会直接 resume 该 thread；若只按入站 sid 查 E2E，会绕过
   * prompt 解密与所有控制 MAC。
   */
  private protectedInboundAliasOwner(sid: string): string | undefined {
    return this.protectedWireSids().find((wireSid) => {
      if (wireSid === sid) return false;
      if (sameLocalUUID(wireSid, sid)) return true;
      const localSid = this.map[wireSid];
      return localSid !== undefined && (localSid === sid || sameLocalUUID(localSid, sid));
    });
  }

  /**
   * Link B ready / 在線 E2E 控制幀的硬閘：wire ULID 需要持久 local UUID 映射。
   * 主檔缺失/壞檔（含只從可能過期的 .bak 恢復）時整個連接器退出，不能讓任何 live、
   * mirror、history 路徑猜成 plaintext。UUID 原生鏡像會話身份相同，不依賴此映射。
   */
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
      // 身份已不可證明：導入一律視為受保護，寧可暫停全部歷史也不猜錯一條明文。
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
      if (!verified.kind.startsWith("session.")) {
        throw new E2EControlError(`${verified.kind} is not supported by Codex exec`);
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
          // #146 附件:codex exec 無原生媒體通道 → 「落盤 + 路徑注入 prompt」讓 codex 用讀檔工具訪問
          // (SSRF 防護/100MB 上限見 attachments.ts,移植自 CC);audio 走雲端 STT 回退鏈。
          const atts = Array.isArray(params.attachments)
            ? (params.attachments as Array<{ id?: string; kind?: string; name?: string; mime?: string; url?: string }>)
            : [];
          // E2E 附件没有端到端密文/完整性协议；在任何 STT、网络或落盘副作用前拒绝整帧。
          if (atts.length && this.e2e?.isE2E(sid)) {
            console.error(`[E2E prompt rejected ${sid}] attachments are not supported`);
            return;
          }
          const attachNotes: string[] = [];
          for (const a of atts) {
            if (a?.kind === "audio" && a.id) {
              this.linkb.send({ t: "voice_transcript", agentLinkId: this.linkb.agentLinkId, sessionId: sid, attachmentId: a.id, text: "", error: "stt_unavailable" });
              continue;
            }
            if (!a?.url) continue;
            try {
              const p = await materializeAttachment(a);
              attachNotes.push(`[Macchiato 附件 ${a.name ?? "file"}(${a.mime ?? "?"})已保存到:${p}]`);
            } catch (e) {
              console.error(`[attachment failed for ${sid}] ${(e as Error).message}`);
              if (!this.e2e?.isE2E(sid)) {
                this.emit(sid, "review.summary", { summary: `⚠️ 附件 ${a.name ?? ""} 下載失敗:${(e as Error).message.slice(0, 120)}` });
              }
            }
          }
          if (!text && !attachNotes.length) return;
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
            if (!text) return;
            const arr = this.pendingUser.get(sid) ?? [];
            arr.push(text);
            this.pendingUser.set(sid, arr);
          }
          if (attachNotes.length) text = [text, ...attachNotes].filter(Boolean).join("\n\n"); // #146 路徑注入
          if (this.active.has(sid)) {
            const q = this.queued.get(sid) ?? [];
            q.push(text);
            this.queued.set(sid, q);
            console.log(`· Turn in progress → queued follow-up for ${sid}`);
            return;
          }
          this.runTurn(sid, text);
          return;
        }
        case "session.interrupt": {
          const t = this.active.get(sid);
          const hadQueued = this.queued.has(sid);
          if (!t && !hadQueued && authenticated) {
            throw new E2EControlError("no active turn to interrupt");
          }
          if (t) {
            this.interruptedSids.add(sid); // #145 隨後的 close 定性 interrupted,不再冒充「正常完成」
            t.proc.kill("SIGTERM");
            console.log(`· Interrupted turn for ${sid}`);
          }
          // #145 停止 = 全停:排隊的後續 prompt 一併作廢(否則停完馬上又起一回合,違反預期)。
          this.queued.delete(sid);
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
          // #161 墓碑:app 刪會話 → 鏡像永不再撈;不刪 rollout(app 是遙控器)。
          const tid = this.threadFor(sid);
          if (tid) this.mirror?.tombstone(tid);
          return;
        }
        case "session.retitle": {
          // #257 app「重新生成標題」:從 rollout 首條 user 消息重算(codex 截斷哲學)。E2E 跳過。
          if (this.e2e?.isE2E(sid)) return;
          const tid = this.threadFor(sid);
          if (!tid) return;
          try {
            const rf = discoverRollouts().rollouts.find((r) => r.threadId === tid);
            if (!rf || !existsSync(rf.file)) return;
            const { title } = deriveMeta(readFileSync(rf.file, "utf8"));
            if (title && title !== "Codex") this.emit(sid, "session.title", { title });
          } catch (e) {
            console.error(`[#257 retitle failed ${sid}] ${(e as Error).message}`);
          }
          return;
        }
        case "session.archive":
          return; // #257 codex 無歸檔概念 → 明確 no-op
        case "session.create": {
          const partial = authenticated !== undefined;
          if (!partial || Object.hasOwn(params, "cwd")) {
            const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
            this.persistSessionSetting(this.cwds, sid, cwd, authenticated, "cwd");
          }
          // #143 model(upsert;隨時可改)。空 = 清回連接器默認(env / codex 配置)。自由字符串,只透傳。
          if (!partial || Object.hasOwn(params, "model")) {
            const md = typeof params.model === "string" ? params.model.trim() : "";
            this.persistSessionSetting(this.models, sid, md, authenticated, "model");
          }
          if (!partial || Object.hasOwn(params, "effort")) {
            const ef = typeof params.effort === "string" ? params.effort.trim() : ""; // #231
            this.persistSessionSetting(this.efforts, sid, ef, authenticated, "effort");
          }
          // #230 permissionMode(upsert;隨時可改)。空 = 回退進程級 env 沙箱默認。
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
      this.counters.driveErrors += 1; // #10
      console.error(`[drive ${frame.method} failed for ${sid}] ${(e as Error).message}`);
      if (authenticated) throw e;
    }
  }

  private runTurn(sid: string, text: string): void {
    const isE2E = this.e2e?.isE2E(sid) ?? false;
    const cwd = this.cwdFor(sid);
    if (!isDir(cwd)) {
      const err = `⚠️ 工作目錄不存在或不是目錄:${cwd}(連接器主機上)。請修正會話目錄後重發。`;
      if (isE2E) this.sendE2ETurn(sid, err);
      else this.emit(sid, "review.summary", { summary: err });
      return;
    }
    const resume = this.threadFor(sid);
    const isFirstMacchiatoTurn = !resume && !UUID_RE.test(sid) && !isE2E;
    if (isFirstMacchiatoTurn && !this.titled.has(sid)) void this.maybeTitle(sid, text);

    // exec 級標誌(--json/-s/-C/--skip-git-repo-check/-m)是 `exec` 的選項,必須放在 `resume`
    // 子命令**之前**(codex exec resume 不接這些,實測 2026-07-12)。
    //   codex exec --json --skip-git-repo-check -s <sandbox> -C <cwd> [-m <model>] [resume <id>] <prompt>
    const args = ["exec", "--json", "--skip-git-repo-check", "-s", this.sandboxFor(sid), "-C", cwd];
    // #143 per-session model(空 = 不傳 -m,用 codex 自身配置默認;絕不 hardcode)。放 resume 之前。
    const model = this.modelFor(sid);
    if (model) args.push("-m", model);
    const effort = this.effortFor(sid); // #231 exec 用 config override(app-server 用 turn/start.effort)
    if (effort) args.push("-c", `model_reasoning_effort=${effort}`);
    if (resume) args.push("resume", resume);
    args.push(text);
    const proc = spawn(resolveCodexBin(), args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    const turn: Turn = {
      proc,
      stdoutBuf: "",
      agentText: "",
      started: false,
      completed: false,
      usage: {},
      isE2E,
      isFirstMacchiatoTurn,
      toolItems: new Map(),
    };
    this.active.set(sid, turn);
    this.pending.add(sid); // #200
    this.saveMap();

    proc.stdout!.on("data", (chunk: Buffer) => {
      turn.stdoutBuf += chunk.toString("utf8");
      let nl: number;
      while ((nl = turn.stdoutBuf.indexOf("\n")) >= 0) {
        const line = turn.stdoutBuf.slice(0, nl).trim();
        turn.stdoutBuf = turn.stdoutBuf.slice(nl + 1);
        if (line) this.handleEvent(sid, turn, line);
      }
    });
    let stderr = "";
    proc.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    proc.on("close", (code) => this.finishTurn(sid, turn, code, stderr));
    proc.on("error", (e) => this.finishTurn(sid, turn, -1, e.message));
  }

  private startMsg(sid: string, turn: Turn): void {
    if (turn.started || turn.isE2E) return;
    turn.started = true;
    this.emit(sid, "message.start", {});
  }

  private handleEvent(sid: string, turn: Turn, line: string): void {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return; // 非 JSON 行(如 "Reading additional input…")跳過
    }
    switch (ev.type) {
      case "thread.started": {
        const tid = String(ev.thread_id ?? "");
        if (tid && !this.map[sid] && !UUID_RE.test(sid)) {
          this.map[sid] = tid;
          this.saveMap();
          this.mirror?.setDriven(tid); // live 獨佔投遞
        } else if (tid && UUID_RE.test(sid)) {
          this.mirror?.setDriven(tid);
        }
        return;
      }
      case "item.started":
      case "item.completed": {
        const it = ev.item ?? {};
        if (it.type === "agent_message") {
          if (ev.type === "item.completed" && typeof it.text === "string" && it.text) {
            this.startMsg(sid, turn);
            const chunk = turn.agentText ? "\n\n" + it.text : it.text;
            turn.agentText += (turn.agentText ? "\n\n" : "") + it.text;
            if (!turn.isE2E) this.emit(sid, "message.delta", { text: chunk });
          }
        } else if (it.type === "reasoning") {
          // #153 思考完成項透出(token-delta 要 app-server v2 → #132;完成項現在就能給)。
          const rtext = String(it.text ?? it.summary ?? "");
          if (ev.type === "item.completed" && rtext && !turn.isE2E) {
            this.startMsg(sid, turn);
            this.emit(sid, "reasoning.delta", { text: rtext });
          }
        } else if (it.type && it.type !== "agent_message") {
          // #153 工具類 item:按子類型取實料(args 不再恆 {};exit_code≠0/failed 標 error)。
          const id = String(it.id ?? `${it.type}-${turn.toolItems.size}`);
          const card = toolCardFor(it);
          if (ev.type === "item.started") {
            turn.toolItems.set(id, { name: card.name });
            this.startMsg(sid, turn);
            if (!turn.isE2E) this.emit(sid, "tool.start", { tool_id: id, name: card.name });
          } else {
            const t = turn.toolItems.get(id);
            if (t && !turn.isE2E) {
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
        }
        return;
      }
      case "turn.completed":
        if (ev.usage && typeof ev.usage === "object") {
          const u = ev.usage;
          turn.usage = {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cached_input_tokens: u.cached_input_tokens,
            reasoning_output_tokens: u.reasoning_output_tokens,
          };
        }
        return;
      case "turn.failed":
      case "error":
        turn.usage.error = String(ev.message ?? ev.error ?? "turn failed");
        return;
      default:
        return; // thread.resumed / turn.started 等:忽略
    }
  }

  private finishTurn(sid: string, turn: Turn, code: number | null, stderr: string): void {
    if (turn.completed) return;
    turn.completed = true;
    this.active.delete(sid);
    this.pending.delete(sid); // #200
    this.saveMap();
    const interrupted = this.interruptedSids.delete(sid);
    // #145:code===null = 被信號殺(用戶中斷 / 外部 kill 如 earlyoom)→ interrupted,不冒充 complete。
    const err = code !== 0 && code !== null;
    const status = err ? "error" : interrupted || code === null ? "interrupted" : "complete";
    const finalText = turn.agentText;
    // #310 認證失效偵測(同 v2):auth 類失敗置持續態,成功回合恢復。
    const authErr = err && CODEX_AUTH_ERR_RE.test(stderr);
    if (authErr) this.authFailed = true;
    else if (status === "complete") this.authFailed = false;
    if (turn.isE2E) {
      this.sendE2ETurn(sid, finalText);
    } else {
      if (err && !finalText) {
        this.emit(sid, "review.summary", {
          summary: authErr
            ? "❌ Codex 登錄已失效——請在連接器主機終端跑 `codex login` 重新登錄後重試"
            : `❌ 回合失敗(codex exit ${code}${stderr ? ": " + stderr.slice(0, 200) : ""})`,
        });
      }
      this.startMsg(sid, turn);
      this.emit(sid, "message.complete", { text: finalText, status, usage: turn.usage });
    }
    const tid = this.threadFor(sid);
    if (tid) {
      this.mirror?.fastForward(tid);
      this.projects?.checkTurnEnd(); // #227
      this.mirror?.unsetDriven(tid);
    }
    if (turn.isFirstMacchiatoTurn && this.genTitle) this.genTitle = undefined;
    const next = this.queued.get(sid)?.shift();
    if (!this.queued.get(sid)?.length) this.queued.delete(sid);
    if (next !== undefined) this.runTurn(sid, next);
  }

  private async maybeTitle(sid: string, firstUserText: string): Promise<void> {
    try {
      this.titled.add(sid);
      this.saveMap();
      const title = await generateTitle(firstUserText);
      if (!title) return;
      this.genTitle = title;
      this.emit(sid, "session.title", { title });
      console.log(`· 生成標題「${title}」→ ${sid}`);
    } catch (e) {
      console.error(`[title gen failed for ${sid}] ${(e as Error).message}`);
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

  private loadState(): ReturnType<typeof loadDriveState> {
    return loadDriveState(); // #132 抽到 state.ts(v1/v2 drive 共用同一持久文件)
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
