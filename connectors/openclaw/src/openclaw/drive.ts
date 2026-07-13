/**
 * Drive：Macchiato → OpenClaw 的雙向橋（對應 Hermes 連接器的 tui 分派 + 事件回傳）。
 *
 * 下行（server → 連接器, t:"tui" 幀）：
 *   prompt.submit  → chat.send（回合進行中 → sessions.steer 注入, §18 方案 D, 實測可用）
 *   session.interrupt → sessions.abort
 *   session.create → 登記 driven（chat.send 首次提交時自動建會話）
 * 上行（OpenClaw gateway 事件 → server tui EVENT, 形狀均為 2026-07-04 活測捕獲）：
 *   chat state:"delta" {deltaText}        → message.start（首個 delta 補發）+ message.delta
 *   chat state:"final" {message.content}  → message.complete（ingest 對累積/增量雙容）
 *   agent lifecycle start/end             → 回合活躍表 + 結束時讓鏡像快進（防雙投）
 *
 * 會話映射：server 下發 hermesSessionId；`agent:` 開頭 = OpenClaw 真實 key（鏡像來的會話, 直接續聊）；
 * 否則是 Macchiato 新建會話 → 包成 `agent:main:macchiato:<sid>`（無渠道綁定, 回覆只走 Macchiato）。
 * ⚠️ 續聊渠道會話（discord key）的回覆是否會同時投遞到該渠道 —— chat.send 無 deliver 參數
 *（sessions.send 也實測拒收 deliver）, 待真機驗證；probe 證明無綁定 key 是乾淨的。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { LinkBClient } from "../linkb/client";
import { fetchChatAttachment, type ChatAttachment } from "./attachments";
import type { OpenClawGateway, GatewayEvent } from "./gateway";
import { keyForSid, sidForKey, type Mirror } from "./mirror";
import { generateTitle, loadTitled, saveTitled } from "./titles";
import type { E2EKeyStore } from "../e2e/keys";

// key ↔ sid 映射移居 mirror.ts（E2E 回灌也要用）；re-export 保持既有導入面不變。
export { keyForSid, sidForKey };

/** #202 drive 持久狀態文件(driven key→sid + 對賬水位線)。 */
function driveStatePath(): string {
  return process.env.MACCHIATO_OPENCLAW_DRIVE || join(homedir(), ".macchiato/openclaw-drive.json");
}

export class Drive {
  /** key → runId（回合進行中）。 */
  private readonly active = new Map<string, string>();
  /** 已發過 message.start 的 runId。 */
  private readonly started = new Set<string>();
  /** runId → 已收 delta 的累積文本（lifecycle end 無 final 時兜底 complete 用）。 */
  private readonly acc = new Map<string, string>();
  /** 已發 message.complete 的 runId。 */
  private readonly completed = new Set<string>();
  /** 本進程驅動過的 key（鏡像跳過 → live 路徑獨佔投遞）。 */
  private readonly driven = new Set<string>();
  /** 小寫 key → server 原始 sid（大寫 ULID）；回傳事件用它找回 server 認識的 sid。 */
  private readonly sidByKey = new Map<string, string>();
  /**
   * #202 對賬狀態(持久,跨重啟):驅動過的 key→sid + 每 key 已對賬的最大 __openclaw.seq 水位線。
   * driven key 的投遞是 live 獨佔(鏡像跳過),live 漏收 gateway 廣播(WS 重連窗/進程死)= 該段丟。
   * 對賬 = 重連/啟動時拉 chat.history(每條帶穩定 __openclaw.id + 單調 seq),把 seq>水位線的行
   * 用 mirror_append+srcId 補投——已由 live 投遞且回合末回填過 srcId 的行撞 (session,dedup_key)
   * 唯一索引被吃掉,不雙投;真漏的行被補上,不再丟。
   */
  private wmByKey: Record<string, number> = {};
  private drivenPersist: Record<string, string> = {};

  /** E2E 會話：runId 前暫存的（已解密）用戶消息, 回合結束隨加密批一起投遞。 */
  private readonly pendingUser = new Map<string, string[]>();

  /** #113 已自動生成過標題的 sid(持久,重啟不重生、不覆蓋用戶手改)。 */
  private readonly titled = loadTitled();

  /** #4 已重投過的 `sid:text哈希`——每條 prompt 最多重投一次,寧丟勿雙發。 */
  private readonly promptRetried = new Set<string>();
  /** #4 最近一次重投任務(測試 await 用;生產無人等)。 */
  retryTask: Promise<void> | null = null;
  /** #5 重投等待中的 key;用戶中斷時據此標記取消——已叫停的 prompt 不許復活雙發。 */
  private readonly retryWaiting = new Set<string>();
  private readonly retryCancelled = new Set<string>();

  /** #10:累計計數(進程生命週期),健康上報帶出。 */
  readonly counters: Record<string, number> = { promptRetries: 0, promptRetryFails: 0, driveErrors: 0 };

  constructor(
    private readonly gw: OpenClawGateway,
    private readonly linkb: LinkBClient,
    private readonly mirror?: Mirror,
    private readonly e2e?: E2EKeyStore,
  ) {
    // #202 載入持久對賬狀態;歷史 driven key 重新登記(鏡像跳過 + 事件路由 + 對賬覆蓋)。
    try {
      const st = JSON.parse(readFileSync(driveStatePath(), "utf8")) as Record<string, unknown>;
      this.drivenPersist = (st.driven ?? {}) as Record<string, string>;
      this.wmByKey = (st.wm ?? {}) as Record<string, number>;
    } catch {
      /* 首跑/損壞 → 空狀態 */
    }
    for (const [key, sid] of Object.entries(this.drivenPersist)) {
      this.driven.add(key);
      this.sidByKey.set(key, sid);
      this.mirror?.setDriven(key, sid);
    }
  }

  private saveDriveState(): void {
    try {
      const p = driveStatePath();
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, driven: this.drivenPersist, wm: this.wmByKey }));
      renameSync(tmp, p);
    } catch (e) {
      console.error("[drive state save failed]", (e as Error).message);
    }
  }

  /** 掛上兩側監聽（linkb.start 前調用）。 */
  wire(): void {
    this.linkb.onFrame((m) => void this.onServerFrame(m));
    this.gw.onEvent((e) => this.onGatewayEvent(e));
    // #202 重連後對賬:斷連窗內漏收的廣播(live 唯一路)靠 chat.history 補齊。
    this.gw.onConnected?.(() => void this.reconcileAll("reconnect"));
  }

  isDriven(key: string): boolean {
    return this.driven.has(key);
  }


  private emit(sid: string, type: string, payload: Record<string, unknown>): void {
    this.linkb.send({
      t: "tui",
      agentLinkId: this.linkb.agentLinkId,
      sessionId: sid,
      frame: { jsonrpc: "2.0", method: "event", params: { type, session_id: sid, payload } },
    });
  }

  private markDriven(key: string, sid: string): void {
    this.driven.add(key);
    this.sidByKey.set(key, sid);
    this.mirror?.setDriven(key, sid); // #147 帶真大小寫 sid(打撈的 mirror_append 用)
    if (this.drivenPersist[key] !== sid) {
      this.drivenPersist[key] = sid; // #202 持久:重啟後仍知道哪些 key 歸 live、對賬要覆蓋誰
      this.saveDriveState();
    }
  }

  async onServerFrame(msg: Record<string, unknown>): Promise<void> {
    if (msg.t !== "tui" || !msg.frame) return;
    const frame = msg.frame as { method?: string; params?: Record<string, unknown> };
    const params = frame.params ?? {};
    const sid = (msg.sessionId ?? params.session_id) as string | undefined;
    if (!sid || !frame.method) return;
    const key = keyForSid(sid);
    try {
      switch (frame.method) {
        case "prompt.submit": {
          // #73/#89 語音優雅降級：OpenClaw 無 STT——audio 附件立即回「未能轉錄」失敗回執，
          // 否則 server 的「轉錄中…」占位永久卡住（CC 連接器同款修法）。新 server 已按
          // health `stt:false` 預路由、不會下達音頻；這是對舊 server 的兜底。
          const atts = Array.isArray(params.attachments)
            ? (params.attachments as Array<{ id?: string; kind?: string }>)
            : [];
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
            }
          }
          // #60 真支持:非 audio 附件(圖片/文件)下載 → base64 → chat.send 的 attachments
          // 參數(gateway 原生收,落 agent 工作區/圖片走視覺,默認 20MB 上限)。
          // 單個失敗不擋正文,失敗的才發降級回執(E2E 跳過明文行——同舊)。
          const media = atts.filter((a) => a?.kind && a.kind !== "audio");
          const chatAtts: ChatAttachment[] = [];
          let failed = 0;
          for (const a of media) {
            try {
              chatAtts.push(await fetchChatAttachment(a as Record<string, unknown>));
            } catch (e) {
              failed += 1;
              console.error(`[#60 attachment ${String((a as any).name ?? (a as any).id)} failed] ${(e as Error).message}`);
            }
          }
          if (failed && !this.e2e?.isE2E(sid)) {
            this.emit(sid, "review.summary", {
              summary: `⚠️ ${failed} 個附件下載失敗已跳過(其餘 ${chatAtts.length} 個已送達 agent)`,
            });
          }
          let text = String(params.text ?? "").trim();
          if (!text && !chatAtts.length) return;
          if (text && this.e2e?.isE2E(sid)) {
            // §19：iOS 發來的是密文 → 解密再提交 agent；記下明文供回合結束的加密鏡像批
            try {
              text = this.e2e.decryptText(sid, text).trim();
            } catch (e) {
              console.error(`[E2E prompt decrypt failed for ${sid}] ${(e as Error).message}`);
              return;
            }
            if (!text && !chatAtts.length) return;
            const arr = this.pendingUser.get(key) ?? [];
            arr.push(text);
            this.pendingUser.set(key, arr);
          }
          this.markDriven(key, sid);
          // #113 首個 prompt → 自動標題(越早越好,與 CC/Hermes 對齊)。僅 Macchiato 發起的會話
          // (鏡像來的 agent: key 有自己的頻道標題);E2E 跳過(標題事件是明文,防洩漏)。
          if (text && !sid.startsWith("agent:") && !this.e2e?.isE2E(sid) && !this.titled.has(sid)) {
            this.titled.add(sid);
            saveTitled(this.titled);
            void this.autoTitle(sid, text);
          }
          await this.sendPrompt(key, sid, text, chatAtts);
          return;
        }
        case "session.interrupt":
          // #5:重投等待期(#4)收到中斷 → 標記取消重投。
          if (this.retryWaiting.has(key)) {
            this.retryCancelled.add(key);
            console.log(`· 用戶中斷 → 取消待重投 prompt(${key})`);
          }
          await this.gw.request("sessions.abort", { key });
          return;
        case "session.create":
          this.markDriven(key, sid); // 會話本體由首次 chat.send 自動建
          return;
        default:
          return; // 其它方法 v1 忽略
      }
    } catch (e) {
      this.counters.driveErrors += 1; // #10
      console.error(`[drive ${frame.method} failed for ${sid}] ${(e as Error).message}`);
    }
  }

  /** #4:提交 prompt(回合進行中 → steer 注入);連接死於在途 → 排一次重投。
   * #60:attachments 隨 chat.send 送達(steer 無附件通道——回合進行中只 steer 文字+回執說明)。 */
  private async sendPrompt(key: string, sid: string, text: string, attachments: ChatAttachment[] = []): Promise<void> {
    const idem = `mc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      if (this.active.has(key)) {
        if (attachments.length && !this.e2e?.isE2E(sid)) {
          this.emit(sid, "review.summary", {
            summary: `⚠️ 回合進行中,${attachments.length} 個附件暫無法注入——僅文字已轉交 agent,回合結束後請重發附件`,
          });
        }
        if (!text) return; // 純附件 + 回合進行中:無可 steer
        const r = await this.gw.request("sessions.steer", { key, message: text });
        console.log(`· Turn in progress → steering follow-up into (${key}, status=${r?.status})`);
      } else {
        await this.gw.request("chat.send", {
          sessionKey: key,
          message: text,
          idempotencyKey: idem,
          ...(attachments.length ? { attachments } : {}),
        });
      }
    } catch (e) {
      const m = (e as Error).message ?? "";
      // 只重投「連接死亡」類失敗(請求確定沒送達)。timeout 不重投:daemon 可能仍在處理,
      // steer 無冪等鍵,重投有雙發風險——寧丟勿雙發。業務錯誤(gateway error: …)照舊上拋記日誌。
      if (!m.includes("gateway connection lost") && !m.includes("gateway not connected")) throw e;
      this.retryTask = this.retryPrompt(key, sid, text, idem, attachments);
    }
  }

  /** #4 prompt 級重試:等 gateway 重連後重投一次。
   * 去重雙保險:① promptRetried 本地記賬,同 (sid, 文本) 只重投一次;
   * ② chat.send 帶**原 idempotencyKey**——即使首發實際已進 daemon(理論窗口),OpenClaw 冪等去重。
   * 重投一律走 chat.send 不走 steer:斷線期間 lifecycle 事件丟失,active 表不可信;
   * 且重連通常意味 daemon 重啟、舊 run 已死。 */
  private async retryPrompt(key: string, sid: string, text: string, idem: string, attachments: ChatAttachment[] = []): Promise<void> {
    const rkey = `${sid}:${createHash("sha256").update(text).digest("hex")}`;
    if (this.promptRetried.has(rkey)) {
      console.error(`[#4 重投已用過,放棄 ${sid}]`);
      return;
    }
    if (this.promptRetried.size > 512) this.promptRetried.clear(); // 防無界(正常極少進來)
    this.promptRetried.add(rkey);
    this.retryWaiting.add(key);
    try {
      const deadline = Date.now() + 180_000; // 覆蓋重連退避(3→60s);gateway 真沒了則放棄
      while (Date.now() < deadline && !this.gw.isConnected) {
        if (this.retryCancelled.has(key)) {
          console.log(`[#5 重投已被用戶中斷取消 ${sid}]`);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (this.retryCancelled.has(key)) {
        console.log(`[#5 重投已被用戶中斷取消 ${sid}]`);
        return;
      }
      if (!this.gw.isConnected) {
        console.error(`[#4 重投放棄:gateway 180s 未重連 ${sid}]`);
        return;
      }
      await this.gw.request("chat.send", {
        sessionKey: key,
        message: text,
        idempotencyKey: idem,
        ...(attachments.length ? { attachments } : {}),
      });
      this.counters.promptRetries += 1; // #10
      console.log(`· #4 prompt 重投成功 (${key},gateway 死於在途,已補投)`);
    } catch (e) {
      this.counters.promptRetryFails += 1; // #10
      console.error(`[#4 重投失敗,放棄 ${sid}] ${(e as Error).message}`);
    } finally {
      this.retryWaiting.delete(key);
      this.retryCancelled.delete(key);
    }
  }

  /** #113:經用戶自己的 agent 生成標題(titles.generateTitle,隱藏 titlegen 會話)→ session.title。 */
  private async autoTitle(sid: string, firstUserText: string): Promise<void> {
    try {
      const title = await generateTitle(this.gw, sid, firstUserText);
      if (!title) return;
      this.emit(sid, "session.title", { title });
      console.log(`· 生成標題「${title}」→ ${sid}`);
    } catch (e) {
      console.error(`[auto title failed for ${sid}] ${(e as Error).message}`);
    }
  }

  onGatewayEvent(evt: GatewayEvent): void {
    const p = (evt.payload ?? {}) as Record<string, any>;
    const key = typeof p.sessionKey === "string" ? p.sessionKey.toLowerCase() : undefined;
    if (!key || !this.driven.has(key)) return;
    const sid = this.sidByKey.get(key) ?? sidForKey(key);

    const isE2E = this.e2e?.isE2E(sid) ?? false;
    if (evt.event === "agent" && p.stream === "lifecycle") {
      const phase = p.data?.phase;
      const runId: string = p.runId ?? "";
      if (phase === "start") {
        this.active.set(key, runId);
        if (isE2E) return; // §19 方案 A：E2E 會話不走明文 live, 內容由加密鏡像批投遞
        // OpenClaw 不做 token 流式（消息級）→ 回合一開跑就發 message.start, 
        // app 立刻顯示「AI 工作中」氣泡, 而不是整個回合靜默（UX）。
        if (runId && !this.started.has(runId)) {
          this.started.add(runId);
          this.emit(sid, "message.start", {});
        }
      } else if (phase === "end") {
        this.active.delete(key);
        if (isE2E) {
          this.mirror?.fastForward(key); // 明文 .jsonl 快進（E2E 內容只走加密批）
          return;
        }
        // 回合結束但沒收到 chat final（錯誤/中斷/靜默回合）→ 兜底 complete, 免得 app 卡轉圈
        if (runId && this.started.has(runId) && !this.completed.has(runId)) {
          this.emit(sid, "message.complete", { text: this.acc.get(runId) ?? "" });
        }
        this.started.delete(runId);
        this.acc.delete(runId);
        this.completed.delete(runId);
        this.mirror?.fastForward(key); // live 已投遞 → 鏡像水位線快進到文件末, 防雙投
        void this.reconcileTurnEnd(key, sid); // #202 回填 srcId + 推水位線(fire-and-forget)
      }
      return;
    }

    if (evt.event === "chat") {
      const runId: string = p.runId ?? "";
      if (isE2E) {
        // §19：final 時把（解密過的）用戶消息 + agent 回覆加密成 enc, 走 mirror_append
        if (p.state === "final" && p.message?.role === "assistant" && this.e2e) {
          const reply = (Array.isArray(p.message.content) ? p.message.content : [])
            .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text)
            .join("");
          const msgs: Record<string, unknown>[] = (this.pendingUser.get(key) ?? []).map((t) => ({
            role: "user",
            enc: this.e2e!.encryptContent(sid, { text: t }),
          }));
          this.pendingUser.delete(key);
          if (reply.trim()) msgs.push({ role: "agent", enc: this.e2e.encryptContent(sid, { text: reply }) });
          if (msgs.length) {
            this.linkb.send({ t: "mirror_append", agentLinkId: this.linkb.agentLinkId, sessions: [
              { hermesSessionId: sid, source: "openclaw", e2e: true, messages: msgs },
            ] });
            console.log(`· E2E turn → encrypted mirror batch (${sid}, ${msgs.length} messages)`);
          }
        }
        return;
      }
      if (p.state === "delta" && typeof p.deltaText === "string" && p.deltaText) {
        if (!this.started.has(runId)) {
          this.started.add(runId);
          this.emit(sid, "message.start", {});
        }
        this.acc.set(runId, (this.acc.get(runId) ?? "") + p.deltaText);
        this.emit(sid, "message.delta", { text: p.deltaText });
      } else if (p.state === "final") {
        const m = p.message ?? {};
        if (m.role !== "assistant") return;
        const text = (Array.isArray(m.content) ? m.content : [])
          .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("");
        if (!this.started.has(runId)) {
          this.started.add(runId);
          this.emit(sid, "message.start", {});
        }
        this.emit(sid, "message.complete", { text });
        this.completed.add(runId);
      }
    }
  }

  // ── #202 對賬:live 漏收廣播 = driven key 唯一投遞路斷 → 靠 chat.history(穩定 id+seq)補齊 ──

  /** chat.history → 規整行 {seq, id, role, text}(role 只留 user/assistant;無 id/seq 的行丟棄)。 */
  private async historyRows(key: string): Promise<Array<{ seq: number; id: string; role: string; text: string }>> {
    const r = await this.gw.request<{ messages?: any[] }>("chat.history", { sessionKey: key, limit: 50 });
    const out: Array<{ seq: number; id: string; role: string; text: string }> = [];
    for (const m of r?.messages ?? []) {
      const meta = m?.__openclaw;
      if (!meta || typeof meta.seq !== "number" || typeof meta.id !== "string") continue;
      const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
      if (role !== "user" && role !== "assistant") continue; // 工具/系統行不入鏡像
      const text =
        typeof m.content === "string"
          ? m.content
          : (Array.isArray(m.content) ? m.content : [])
              .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
              .map((b: any) => b.text)
              .join("");
      out.push({ seq: meta.seq, id: meta.id, role, text });
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /**
   * 回合末(lifecycle end):把本回合落庫的行 id 回填給 server 作 live 消息的 dedup_key
   * (#13 同款,Hermes 驗證過的模式),再推水位線。順序刻意:先回填、後推水位——若死在中間,
   * 重啟對賬會重投 >wm 的行,但 srcId 已回填 → 撞唯一索引被吃掉,不雙投。
   */
  private async reconcileTurnEnd(key: string, sid: string): Promise<void> {
    if (this.e2e?.isE2E(sid)) return; // E2E 走加密批,不參與明文對賬
    try {
      const rows = await this.historyRows(key);
      const fresh = rows.filter((r) => r.seq > (this.wmByKey[key] ?? 0));
      if (!fresh.length) return;
      const lastUser = [...fresh].reverse().find((r) => r.role === "user");
      const lastAssistant = [...fresh].reverse().find((r) => r.role === "assistant");
      const items: Array<{ role: string; srcId: string }> = [];
      if (lastUser) items.push({ role: "user", srcId: lastUser.id });
      if (lastAssistant) items.push({ role: "agent", srcId: lastAssistant.id });
      if (items.length) {
        this.linkb.send({ t: "message_srcid", agentLinkId: this.linkb.agentLinkId, sessionId: sid, items });
      }
      this.wmByKey[key] = Math.max(...fresh.map((r) => r.seq));
      this.saveDriveState();
    } catch (e) {
      this.counters.driveErrors += 1; // #10
      console.error(`[#202 turn-end reconcile failed ${key}] ${(e as Error).message}`);
    }
  }

  /**
   * 對賬一個 driven key:seq>水位線的行 = live 沒投過(或投了但回填/推水位前死了)→
   * mirror_append + srcId 補投;已投+已回填的撞唯一索引被 server 吃掉。E2E 會話跳過。
   * Link B 未 ready 時整體跳過不推水位(mirror_append 不入斷線緩衝,發了即丟)。
   */
  async reconcileKey(key: string, sid: string): Promise<number> {
    if (this.e2e?.isE2E(sid)) return 0;
    if (!this.linkb.isReady) return 0;
    const rows = await this.historyRows(key);
    const fresh = rows.filter((r) => r.seq > (this.wmByKey[key] ?? 0) && r.text.trim());
    if (fresh.length) {
      this.linkb.send({
        t: "mirror_append",
        agentLinkId: this.linkb.agentLinkId,
        sessions: [
          {
            hermesSessionId: sid,
            source: "openclaw",
            messages: fresh.map((r) => ({ role: r.role === "assistant" ? "agent" : "user", text: r.text, srcId: r.id })),
          },
        ],
      });
      console.log(`· #202 對賬 ${key}:補投 ${fresh.length} 行(seq>${this.wmByKey[key] ?? 0})`);
    }
    if (rows.length) {
      this.wmByKey[key] = Math.max(this.wmByKey[key] ?? 0, ...rows.map((r) => r.seq));
      this.saveDriveState();
    }
    return fresh.length;
  }

  /** 對賬全部 driven key(啟動時 index.ts 調 + gateway 重連時 wire 的 onConnected 調)。 */
  async reconcileAll(reason: string): Promise<void> {
    const entries = Object.entries(this.drivenPersist);
    if (!entries.length) return;
    if (!this.linkb.isReady) return; // 下次觸發再補(水位線沒動,不丟)
    let delivered = 0;
    for (const [key, sid] of entries) {
      try {
        delivered += await this.reconcileKey(key, sid);
      } catch (e) {
        this.counters.driveErrors += 1;
        console.error(`[#202 reconcile failed ${key}] ${(e as Error).message}`);
      }
    }
    if (delivered) console.log(`· #202 對賬(${reason}):共補投 ${delivered} 行`);
  }
}
