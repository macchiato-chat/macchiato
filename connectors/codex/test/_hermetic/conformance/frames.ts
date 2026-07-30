/**
 * Link-B tui event 信封解析 + 形狀斷言。
 * 不斷言版本字面量/枚舉計數（反 change-detector，docs/testing-strategy.md §6）。
 */
import type { OutboundMessage, TuiEvent } from "./types";

/**
 * 從出站消息列表抽出 method=event 的 tui 事件。
 * 容許各家在頂層帶/不帶 agentLinkId、jsonrpc 字段差異——只認契約字段。
 */
export function extractTuiEvents(sent: OutboundMessage[]): TuiEvent[] {
  const out: TuiEvent[] = [];
  for (const raw of sent) {
    if (raw.t !== "tui") continue;
    const frame = raw.frame as Record<string, unknown> | undefined;
    if (!frame || typeof frame !== "object") continue;
    const params = frame.params as Record<string, unknown> | undefined;
    if (!params || typeof params !== "object") continue;
    // 入站控制幀（prompt.submit 等）沒有 type；出站 event 必有 type
    if (typeof params.type !== "string") continue;
    if (frame.method !== undefined && frame.method !== "event") continue;
    const session_id =
      typeof params.session_id === "string"
        ? params.session_id
        : typeof raw.sessionId === "string"
          ? raw.sessionId
          : "";
    const payload =
      params.payload !== null && typeof params.payload === "object" && !Array.isArray(params.payload)
        ? (params.payload as Record<string, unknown>)
        : {};
    out.push({ type: params.type, session_id, payload, raw });
  }
  return out;
}

/**
 * 斷言一條 tui event 的跨家信封不變量：
 *   - t === "tui"
 *   - frame.method === "event"（若有 method）
 *   - params.type 非空字符串
 *   - params.session_id 非空（或頂層 sessionId）
 *   - payload 為 plain object（可為空）
 *
 * 不鎖死 agentLinkId / jsonrpc 是否出現——那是實現細節，非契約。
 */
export function assertTuiEventEnvelope(ev: TuiEvent): void {
  if (ev.raw.t !== "tui") {
    throw new Error(`tui event envelope: expected t="tui", got ${String(ev.raw.t)}`);
  }
  const frame = ev.raw.frame as Record<string, unknown> | undefined;
  if (!frame || typeof frame !== "object") {
    throw new Error("tui event envelope: missing frame");
  }
  if (frame.method !== undefined && frame.method !== "event") {
    throw new Error(`tui event envelope: method must be "event", got ${String(frame.method)}`);
  }
  if (typeof ev.type !== "string" || !ev.type) {
    throw new Error("tui event envelope: params.type must be non-empty string");
  }
  if (typeof ev.session_id !== "string" || !ev.session_id) {
    throw new Error("tui event envelope: session_id must be non-empty string");
  }
  if (ev.payload === null || typeof ev.payload !== "object" || Array.isArray(ev.payload)) {
    throw new Error("tui event envelope: payload must be a plain object");
  }
}

export function eventsOfType(sent: OutboundMessage[], type: string): TuiEvent[] {
  return extractTuiEvents(sent).filter((e) => e.type === type);
}
