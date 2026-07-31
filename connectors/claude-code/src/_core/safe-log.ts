/**
 * #381 connector 日志脱敏。
 *
 * 默认只记：事件类型、截断 session/request ID、长度、状态、稳定错误码。
 * 不记：prompt / args / approval detail / secret / 附件 URL / 标题正文。
 *
 * 详细内容日志必须显式 `MACCHIATO_LOG_CONTENT=1`，默认关；生产/发布默认配置禁止打开。
 */

export const LOG_CONTENT_ENV = "MACCHIATO_LOG_CONTENT";

export function logContentEnabled(): boolean {
  return process.env[LOG_CONTENT_ENV] === "1";
}

/** 截断 session / request / thread ID，避免完整标识长期落盘。 */
export function shortId(id: string | undefined | null, keep = 12): string {
  if (id == null || id === "") return "-";
  const s = String(id);
  return s.length <= keep ? s : `${s.slice(0, keep)}…`;
}

export function textLen(v: unknown): number {
  if (typeof v === "string") return v.length;
  if (v == null) return 0;
  try {
    return String(v).length;
  } catch {
    return 0;
  }
}

/** 稳定短码（无空白）原样放行；自由文本只报类型 + 长度。 */
export function safeErr(err: unknown): string {
  if (logContentEnabled()) {
    if (err instanceof Error) return err.message || err.name;
    return String(err);
  }
  if (err == null) return "unknown";
  if (typeof err === "string") {
    return isStableCode(err) ? err : `Error(len=${err.length})`;
  }
  if (err instanceof Error) {
    const msg = err.message || "";
    if (isStableCode(msg)) return msg;
    return `${err.name || "Error"}(len=${msg.length})`;
  }
  return "Error";
}

function isStableCode(s: string): boolean {
  // 仅放行短稳定码：control_rejected / ECONNRESET / gateway.ready。
  // 禁止 / : - 等路径/密钥字符，避免 canary 与绝对路径被误判为「短码」。
  return s.length > 0 && s.length <= 48 && /^[A-Za-z][A-Za-z0-9_.]*$/.test(s);
}

/**
 * 上游 stderr / agent 诊断行：默认只保留短标签 + 长度。
 * 允许整行通过的仅限极短稳定诊断（无自由文本体）。
 */
export function redactUpstreamLine(line: string): string {
  if (logContentEnabled()) return line;
  const t = line.replace(/\s+$/, "");
  if (!t) return "";
  if (/^\[[A-Za-z0-9_.:-]{1,48}\]\s*$/.test(t)) return t.trim();
  const m = t.match(/^(\[[A-Za-z0-9_.:-]{1,48}\])/);
  if (m) return `${m[1]} redacted len=${Math.max(0, t.length - m[1].length)}`;
  if (isStableCode(t)) return t;
  return `redacted len=${t.length}`;
}

/** debug 详细内容：仅 MACCHIATO_LOG_CONTENT=1 时输出，并带醒目标签。 */
export function logContent(label: string, detail: string): void {
  if (!logContentEnabled()) return;
  console.log(`[${LOG_CONTENT_ENV}] ${label}: ${detail}`);
}

/** command.invoke 安全摘要（永不写 args 正文）。 */
export function formatCommandInvokeLog(opts: {
  tag?: string;
  name: string;
  argsLen: number;
  sid: string;
  e2e?: boolean;
  extra?: string;
}): string {
  const tag = opts.tag ? `${opts.tag} ` : "";
  const e2e = opts.e2e ? " e2e=1" : "";
  const extra = opts.extra ? ` ${opts.extra}` : "";
  return `· ${tag}command.invoke name=${opts.name} argsLen=${opts.argsLen}${e2e}${extra} → ${shortId(opts.sid)}`;
}
