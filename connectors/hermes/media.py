"""#372 出站附件路徑 capability-bound 校驗。

背景/威脅:agent 正文裡 `MEDIA:<path>` 舊實現只要文件存在就讀並 media.attach。
模型輸出不是可信授權邊界;prompt injection 可誘導打印 `/etc/hosts`、`~/.ssh/*` 等。

對策(務實落地,對齊 openclaw media.ts):
  - **只認 `MEDIA:` 標記**(不再合併裸絕對路徑自動上傳);
  - 路徑必須落在「會話允許根」內:
      · 會話 cwd(drive 有 per-session cwd 時);
      · connector 管理目錄(STATE_DIR / ATTACH_DIR);
      · `MACCHIATO_MEDIA_ALLOW_ROOTS`(冒號分隔額外根,測試與本機擴展);
  - realpath 解析 symlink 後做包含性檢查(逃逸根外 → 拒);
  - O_NOFOLLOW 打開 + fstat 常規文件 + size 上限(縮 TOCTOU)。
失敗只記 reason / path_len,不 dump 路徑正文或文件內容。
"""

from __future__ import annotations

import base64
import mimetypes
import os
import stat
import sys
from typing import Optional

MEDIA_MAX = 12 * 1024 * 1024  # 出站附件 base64 內聯上限(12MB),超出跳過
MEDIA_ALLOW_ROOTS_ENV = "MACCHIATO_MEDIA_ALLOW_ROOTS"


def expand_home(p: str) -> str:
    """~ / ~/... 展開為絕對路徑(不觸碰 fs 解析 symlink)。"""
    if p == "~":
        return os.path.expanduser("~")
    if p.startswith("~/"):
        return os.path.join(os.path.expanduser("~"), p[2:])
    return p


def within_root(root: str, target: str) -> bool:
    """target 是否在 root 之內(邊界安全:同路徑或以 root+sep 為前綴)。"""
    if target == root:
        return True
    prefix = root if root.endswith(os.sep) else root + os.sep
    return target.startswith(prefix)


def resolve_media_allow_roots(
    *,
    session_cwd: Optional[str] = None,
    state_dir: Optional[str] = None,
    attach_dir: Optional[str] = None,
    extra_roots: Optional[list[str]] = None,
) -> list[str]:
    """彙總允許根(realpath 後的目錄;不存在/不可解析跳過)。空列表 = fail closed。"""
    candidates: list[str] = []
    cwd = (session_cwd or "").strip()
    if cwd:
        candidates.append(expand_home(cwd))

    # connector 管理目錄(調用方可注入;默認從 env / ~/.macchiato 推)
    if state_dir is None:
        state_dir = (os.environ.get("MACCHIATO_STATE_DIR") or "").strip() or "~/.macchiato"
    state_abs = expand_home(state_dir)
    candidates.append(state_abs)

    if attach_dir is None:
        attach_abs = os.path.join(state_abs, "attachments")
    else:
        attach_abs = expand_home(attach_dir)
    candidates.append(attach_abs)

    raw = (os.environ.get(MEDIA_ALLOW_ROOTS_ENV) or "").strip()
    if raw:
        for part in raw.split(":"):
            p = part.strip()
            if p:
                candidates.append(expand_home(p))
    if extra_roots:
        for r in extra_roots:
            p = (r or "").strip()
            if p:
                candidates.append(expand_home(p))

    out: list[str] = []
    seen: set[str] = set()
    for c in candidates:
        try:
            if not os.path.exists(c):
                continue
            canon = os.path.realpath(c)
            if not os.path.isdir(canon):
                continue
            if canon in seen:
                continue
            seen.add(canon)
            out.append(canon)
        except OSError:
            pass
    return out


def resolve_allowed_media_path(raw_path: str, roots: list[str]) -> Optional[str]:
    """規範化並校驗:realpath + 落在某根內 + 常規文件。成功回 realpath,否則 None。"""
    if not roots:
        return None
    expanded = expand_home((raw_path or "").strip())
    if not expanded:
        return None
    try:
        canon = os.path.realpath(expanded)
    except OSError:
        return None
    if not any(within_root(r, canon) for r in roots):
        return None
    try:
        st = os.lstat(canon)  # realpath 後末段必非 symlink
        if not stat.S_ISREG(st.st_mode):
            return None
    except OSError:
        return None
    return canon


def _log_denied(reason: str, path_len: int) -> None:
    print(f"[media denied] reason={reason} path_len={path_len}", file=sys.stderr)


def extract_media_files(text: str, allowed_roots: list[str]) -> list[str]:
    """從正文提取 MEDIA: 路徑(去重、存在性+允許根校驗)。不認裸絕對路徑。

    復用 Hermes 平台適配器的 MEDIA: 解析(與 Discord/Telegram 投遞同一套標記語法),
    但**不**合併 extract_local_files 的裸路徑(#372)。
    """
    if not allowed_roots:
        return []
    try:
        from gateway.platforms.base import BasePlatformAdapter as B
    except ImportError:
        # 無 Hermes 時僅做極簡 MEDIA: 行解析(單測 / 無 gateway 環境)
        return _extract_media_markers_fallback(text, allowed_roots)

    media, _cleaned = B.extract_media(text)
    media = B.filter_media_delivery_paths(media)  # [(path, is_voice)],校驗存在
    out: list[str] = []
    seen: set[str] = set()
    for path, _v in media:
        canon = resolve_allowed_media_path(path, allowed_roots)
        if not canon or canon in seen:
            continue
        seen.add(canon)
        out.append(canon)
    return out


def _extract_media_markers_fallback(text: str, allowed_roots: list[str]) -> list[str]:
    """無 Hermes 時的 MEDIA: 標記解析(行首或內聯 MEDIA:path)。"""
    import re

    out: list[str] = []
    seen: set[str] = set()
    # 行首整行 或 內聯 MEDIA:/abs/path(與歷史 Hermes 測試 `see MEDIA:{p} done` 對齊)
    for m in re.finditer(r"(?:^|\s)MEDIA:\s*(\S+)", text or "", flags=re.M):
        canon = resolve_allowed_media_path(m.group(1), allowed_roots)
        if not canon or canon in seen:
            continue
        seen.add(canon)
        out.append(canon)
    return out


def read_media_file(path: str, allowed_roots: list[str]) -> Optional[dict]:
    """讀文件成 media.attach payload;根外/超限/非常規/讀失敗 → None。"""
    path_len = len(path or "")
    canon = resolve_allowed_media_path(path, allowed_roots)
    if not canon:
        _log_denied("outside_roots_or_missing", path_len)
        return None

    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(canon, flags)
    except OSError as exc:
        reason = "symlink_race" if getattr(exc, "errno", None) in (
            getattr(__import__("errno"), "ELOOP", -1),
        ) else "open_failed"
        _log_denied(reason, path_len)
        return None

    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            _log_denied("not_regular_file", path_len)
            return None
        size = int(st.st_size)
        if size <= 0:
            _log_denied("empty", path_len)
            return None
        if size > MEDIA_MAX:
            print(f"[media too big] size={size}B path_len={path_len}", file=sys.stderr)
            return None
        chunks: list[bytes] = []
        remaining = size
        while remaining > 0:
            buf = os.read(fd, remaining)
            if not buf:
                break
            chunks.append(buf)
            remaining -= len(buf)
        data = b"".join(chunks)
        if len(data) != size:
            _log_denied("short_read", path_len)
            return None
        mime = mimetypes.guess_type(canon)[0] or "application/octet-stream"
        return {
            "kind": "image" if mime.startswith("image/") else "document",
            "name": os.path.basename(canon),
            "mime": mime,
            "size": size,
            "data_b64": base64.b64encode(data).decode("ascii"),
        }
    except OSError:
        _log_denied("read_failed", path_len)
        return None
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
