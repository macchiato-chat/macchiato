"""#381 connector 日志脱敏。

默认只记：事件类型、截断 session/request ID、长度、状态、稳定错误码。
不记：prompt / args / approval detail / secret / 附件 URL / 标题正文。

详细内容日志必须显式 MACCHIATO_LOG_CONTENT=1，默认关。
"""

from __future__ import annotations

import os
import re
import sys
from typing import Any, Optional

LOG_CONTENT_ENV = "MACCHIATO_LOG_CONTENT"

# 仅放行短稳定码（control_rejected / ECONNRESET / gateway.ready）。
# 禁止 / : - 等路径/密钥字符，避免 canary 与绝对路径被误判为「短码」。
_STABLE_CODE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.]{0,47}$")
_TAG_RE = re.compile(r"^(\[[A-Za-z0-9_.:-]{1,48}\])")


def log_content_enabled() -> bool:
    return os.environ.get(LOG_CONTENT_ENV) == "1"


def short_id(id_value: Optional[str], keep: int = 12) -> str:
    if not id_value:
        return "-"
    s = str(id_value)
    return s if len(s) <= keep else f"{s[:keep]}…"


def text_len(v: Any) -> int:
    if v is None:
        return 0
    if isinstance(v, str):
        return len(v)
    try:
        return len(str(v))
    except Exception:
        return 0


def _is_stable_code(s: str) -> bool:
    return bool(s) and len(s) <= 48 and _STABLE_CODE_RE.match(s) is not None


def safe_err(err: Any) -> str:
    """自由错误文本 → 类型 + 长度；稳定短码原样。"""
    if log_content_enabled():
        if isinstance(err, BaseException):
            return str(err) or type(err).__name__
        return str(err)
    if err is None:
        return "unknown"
    if isinstance(err, str):
        return err if _is_stable_code(err) else f"Error(len={len(err)})"
    if isinstance(err, BaseException):
        msg = str(err) if str(err) else ""
        # GatewayError 等可能是 "[code] message" —— 一律按长度，避免正文泄漏
        name = type(err).__name__
        if _is_stable_code(msg):
            return msg
        return f"{name}(len={len(msg)})"
    return "Error"


def redact_upstream_line(line: str) -> str:
    """上游 stderr / agent 诊断行脱敏。"""
    if log_content_enabled():
        return line
    t = line.rstrip()
    if not t:
        return ""
    if re.match(r"^\[[A-Za-z0-9_.:-]{1,48}\]\s*$", t):
        return t.strip()
    m = _TAG_RE.match(t)
    if m:
        tag = m.group(1)
        return f"{tag} redacted len={max(0, len(t) - len(tag))}"
    if _is_stable_code(t):
        return t
    return f"redacted len={len(t)}"


def log_content(label: str, detail: str, *, file=None) -> None:
    if not log_content_enabled():
        return
    print(f"[{LOG_CONTENT_ENV}] {label}: {detail}", file=file or sys.stderr)


def format_command_invoke_log(
    *,
    name: str,
    args_len: int,
    sid: str,
    expanded_len: Optional[int] = None,
    tag: str = "#199",
    e2e: bool = False,
) -> str:
    parts = [f"· {tag} command.invoke name={name} argsLen={args_len}"]
    if expanded_len is not None:
        parts.append(f"expandedLen={expanded_len}")
    if e2e:
        parts.append("e2e=1")
    return " ".join(parts) + f" → {short_id(sid)}"
