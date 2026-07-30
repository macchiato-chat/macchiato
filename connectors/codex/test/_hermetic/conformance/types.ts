/**
 * #303 四家 conformance 適配器契約。
 *
 * 模式對齊 localchain（一份劇本 × 各家假傳輸層）:
 *   - 共享 suite 只斷言 Link-B tui event 的跨家契約（信封 + payload 形狀）
 *   - 各家 test 文件提供 adapter：用自家 fake SDK/gateway/app-server 驅動 Drive，
 *     收集 `linkb.send` 出去的幀，交給 suite 斷言
 *   - caps 沒有的能力響亮 skip（it.skip 或 suite 內 if），不算假綠
 */

/** 從 linkb.send 收集到的原始出站消息（各家 Drive 的 fake linkb.sent）。 */
export type OutboundMessage = Record<string, unknown>;

/**
 * 已解析的 tui event（method=event）。
 * 對齊 packages/protocol `tui-gateway` 事件信封。
 */
export type TuiEvent = {
  type: string;
  session_id: string;
  payload: Record<string, unknown>;
  /** 原始出站消息（含 t/sessionId/agentLinkId）。 */
  raw: OutboundMessage;
};

export type ConformanceCaps = {
  /** 能否在假傳輸層上打出 turn.usage（CC/Codex 有；openclaw/hermes 通常無）。 */
  turnUsage: boolean;
  /** 能否打出帶 status/usage 的 message.complete。 */
  messageComplete: boolean;
  /** 能否打出 clarify.request（目前主要是 CC AskUserQuestion）。 */
  clarify?: boolean;
  /** 能否打出 task.start/end（目前主要是 CC background task）。 */
  backgroundTask?: boolean;
};

export type ConformanceAdapter = {
  /** 連接器短名：claude-code / codex / openclaw / hermes。 */
  name: string;
  caps: ConformanceCaps;
  /**
   * 跑一個普通回合，返回 linkb 出站消息列表。
   * 按各家宣告的 caps，應至少產生：turn.usage（`caps.turnUsage`）、
   * message.complete（`caps.messageComplete`）。
   * 名字刻意不帶 Usage——openclaw 不產 turn.usage 卻同樣要用這個槽位跑回合。
   */
  collectTurn?: () => Promise<OutboundMessage[]>;
  /** 觸發 clarify.request，返回出站消息。 */
  collectClarify?: () => Promise<OutboundMessage[]>;
  /** 觸發 task.start（+ 可選 task.end），返回出站消息。 */
  collectBackgroundTask?: () => Promise<OutboundMessage[]>;
};
