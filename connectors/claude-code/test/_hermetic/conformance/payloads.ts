/**
 * 共享 payload 契約（對齊 packages/protocol/src/tui-gateway.ts）。
 * 只斷言關係與類型，不斷言具體枚舉計數 / 版本字面量。
 */

/** #141 turn.usage：非負安全整數 output_tokens；允許且僅關注此字段（E2E 明文白名單同款）。 */
export function assertTurnUsagePayload(payload: Record<string, unknown>): void {
  if (!("output_tokens" in payload)) {
    throw new Error("turn.usage: missing output_tokens");
  }
  const ot = payload.output_tokens;
  if (typeof ot !== "number" || !Number.isSafeInteger(ot) || ot < 0) {
    throw new Error(`turn.usage: output_tokens must be non-negative safe integer, got ${String(ot)}`);
  }
}

/**
 * #102/#115 message.complete：
 *   - text 若有必須是 string
 *   - status 若有必須是非空 string（complete/error/interrupted…——不鎖死枚舉表，防 change-detector）
 *   - usage 若有則為 plain object；其中 output_tokens 若出現必須是非負數
 */
export function assertMessageCompletePayload(payload: Record<string, unknown>): void {
  if ("text" in payload && typeof payload.text !== "string") {
    throw new Error("message.complete: text must be string when present");
  }
  if ("status" in payload) {
    if (typeof payload.status !== "string" || !payload.status) {
      throw new Error("message.complete: status must be non-empty string when present");
    }
  }
  if ("usage" in payload && payload.usage !== undefined) {
    const u = payload.usage;
    if (u === null || typeof u !== "object" || Array.isArray(u)) {
      throw new Error("message.complete: usage must be plain object when present");
    }
    const usage = u as Record<string, unknown>;
    if ("output_tokens" in usage) {
      const ot = usage.output_tokens;
      if (typeof ot !== "number" || !Number.isFinite(ot) || ot < 0) {
        throw new Error(`message.complete.usage.output_tokens invalid: ${String(ot)}`);
      }
    }
  }
}

/**
 * #109 clarify.request：
 *   - request_id / question 非空字符串
 *   - choices 存在（形狀自由；CC 慣例是 {options:[{id,label}]}，不斷言死結構以免綁一家）
 */
export function assertClarifyRequestPayload(payload: Record<string, unknown>): void {
  if (typeof payload.request_id !== "string" || !payload.request_id) {
    throw new Error("clarify.request: request_id must be non-empty string");
  }
  if (typeof payload.question !== "string" || !payload.question) {
    throw new Error("clarify.request: question must be non-empty string");
  }
  if (!("choices" in payload)) {
    throw new Error("clarify.request: choices required");
  }
}

/**
 * #104 task.start：
 *   - task_id / kind / desc 非空字符串
 */
export function assertTaskStartPayload(payload: Record<string, unknown>): void {
  for (const key of ["task_id", "kind", "desc"] as const) {
    if (typeof payload[key] !== "string" || !(payload[key] as string)) {
      throw new Error(`task.start: ${key} must be non-empty string`);
    }
  }
}
