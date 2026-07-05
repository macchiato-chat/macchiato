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
import type { LinkBClient } from "../linkb/client";
import type { OpenClawGateway, GatewayEvent } from "./gateway";
import { keyForSid, sidForKey, type Mirror } from "./mirror";
import type { E2EKeyStore } from "../e2e/keys";

// key ↔ sid 映射移居 mirror.ts（E2E 回灌也要用）；re-export 保持既有導入面不變。
export { keyForSid, sidForKey };

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

  /** E2E 會話：runId 前暫存的（已解密）用戶消息, 回合結束隨加密批一起投遞。 */
  private readonly pendingUser = new Map<string, string[]>();

  constructor(
    private readonly gw: OpenClawGateway,
    private readonly linkb: LinkBClient,
    private readonly mirror?: Mirror,
    private readonly e2e?: E2EKeyStore,
  ) {}

  /** 掛上兩側監聽（linkb.start 前調用）。 */
  wire(): void {
    this.linkb.onFrame((m) => void this.onServerFrame(m));
    this.gw.onEvent((e) => this.onGatewayEvent(e));
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
    this.mirror?.setDriven(key);
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
          let text = String(params.text ?? "").trim();
          if (!text) return;
          if (this.e2e?.isE2E(sid)) {
            // §19：iOS 發來的是密文 → 解密再提交 agent；記下明文供回合結束的加密鏡像批
            try {
              text = this.e2e.decryptText(sid, text).trim();
            } catch (e) {
              console.error(`[E2E prompt decrypt failed for ${sid}] ${(e as Error).message}`);
              return;
            }
            if (!text) return;
            const arr = this.pendingUser.get(key) ?? [];
            arr.push(text);
            this.pendingUser.set(key, arr);
          }
          this.markDriven(key, sid);
          if (this.active.has(key)) {
            const r = await this.gw.request("sessions.steer", { key, message: text });
            console.log(`· Turn in progress → steering follow-up into (${key}, status=${r?.status})`);
          } else {
            await this.gw.request("chat.send", {
              sessionKey: key,
              message: text,
              idempotencyKey: `mc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            });
          }
          return;
        }
        case "session.interrupt":
          await this.gw.request("sessions.abort", { key });
          return;
        case "session.create":
          this.markDriven(key, sid); // 會話本體由首次 chat.send 自動建
          return;
        default:
          return; // 其它方法 v1 忽略
      }
    } catch (e) {
      console.error(`[drive ${frame.method} failed for ${sid}] ${(e as Error).message}`);
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
}
