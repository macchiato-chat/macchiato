"""#1 發布簽名驗證(零依賴):純 Python ed25519(RFC 8032 參考實現)+ 清單校驗。

self_update 此前 `curl install.sh | bash` 裸跑——repo/CDN 投毒或 server 沦陷即本機 RCE。
現在:release.json + .sig 用內嵌公鑰驗簽 → bootstrap bridge + 嚴格升版 → install.sh sha256
對上清單才執行。
信任根 = 發布機私鑰(~/.macchiato/release-signing.key,scripts/release/sign-manifest.mjs 簽)。
純 Python 驗簽 ~100ms,一次性調用可接受;Hermes venv 只保證 websockets,不引第三方密碼庫。
"""
from __future__ import annotations

import base64
import hashlib
import json
import re

# 發布簽名公鑰(ed25519 raw 32B hex;與 TS 連接器 selfupdate.ts 同一把)。
RELEASE_PUBKEY_HEX = "48d741eac2364340cfbd14502eac7506f8babcd4ce502775e831abcd1ed0f105"

# ── RFC 8032 ed25519 verify(參考實現,僅驗簽路徑)────────────────────────────────
_p = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_d = (-121665 * pow(121666, _p - 2, _p)) % _p
_sqrt_m1 = pow(2, (_p - 1) // 4, _p)


def _recover_x(y: int, sign: int):
    if y >= _p:
        return None
    x2 = (y * y - 1) * pow(_d * y * y + 1, _p - 2, _p) % _p
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (_p + 3) // 8, _p)
    if (x * x - x2) % _p != 0:
        x = x * _sqrt_m1 % _p
    if (x * x - x2) % _p != 0:
        return None
    if (x & 1) != sign:
        x = _p - x
    return x


_g_y = 4 * pow(5, _p - 2, _p) % _p
_g_x = _recover_x(_g_y, 0)
_G = (_g_x, _g_y, 1, _g_x * _g_y % _p)


def _add(P, Q):
    A = (P[1] - P[0]) * (Q[1] - Q[0]) % _p
    B = (P[1] + P[0]) * (Q[1] + Q[0]) % _p
    C = 2 * P[3] * Q[3] * _d % _p
    D = 2 * P[2] * Q[2] % _p
    E, F, G, H = B - A, D - C, D + C, B + A
    return (E * F % _p, G * H % _p, F * G % _p, E * H % _p)


def _mul(s, P):
    Q = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            Q = _add(Q, P)
        P = _add(P, P)
        s >>= 1
    return Q


def _eq(P, Q):
    return (P[0] * Q[2] - Q[0] * P[2]) % _p == 0 and (P[1] * Q[2] - Q[1] * P[2]) % _p == 0


def _decompress(s: bytes):
    if len(s) != 32:
        return None
    y = int.from_bytes(s, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % _p)


def ed25519_verify(public: bytes, msg: bytes, signature: bytes) -> bool:
    if len(public) != 32 or len(signature) != 64:
        return False
    A = _decompress(public)
    if A is None:
        return False
    Rs = signature[:32]
    R = _decompress(Rs)
    if R is None:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= _L:
        return False
    h = int.from_bytes(hashlib.sha512(Rs + public + msg).digest(), "little") % _L
    return _eq(_mul(s, _G), _add(R, _mul(h, A)))


# ── 清單校驗 ───────────────────────────────────────────────────────────────────
_STRICT_SEMVER_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_LOWER_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_SAFE_PATH_RE = re.compile(r"^[A-Za-z0-9._+@/-]+$")
_SIGNATURE_RE = re.compile(r"^[A-Za-z0-9+/]{86}==\n?$")
_MAX_SAFE_INTEGER = 2**53 - 1
_MAX_MANIFEST_BYTES = 1024 * 1024


def _parse_strict_semver(version: str) -> tuple[int, int, int]:
    """只接受無前導零的 X.Y.Z；上限與 JS Number 安全整數一致，跨實現比較不失真。"""
    if not isinstance(version, str):
        raise ValueError("版本必須是字串")
    match = _STRICT_SEMVER_RE.fullmatch(version)
    if not match:
        raise ValueError(f"版本格式不合法:{version}")
    parts = tuple(int(x) for x in match.groups())
    if any(x > _MAX_SAFE_INTEGER for x in parts):
        raise ValueError(f"版本字段超出安全範圍:{version}")
    return parts


def _semver_compare(a: str, b: str) -> int:
    pa = _parse_strict_semver(a)
    pb = _parse_strict_semver(b)
    return -1 if pa < pb else (1 if pa > pb else 0)


def _semver_lt(a: str, b: str) -> bool:
    """a < b；格式畸形時拋錯，讓更新 fail closed。"""
    return _semver_compare(a, b) < 0


def verify_manifest(manifest_bytes: bytes, sig_b64: str, pubkey_hex: str = RELEASE_PUBKEY_HEX) -> dict:
    """驗簽 + 解析;失敗拋 ValueError。"""
    if not 0 < len(manifest_bytes) <= _MAX_MANIFEST_BYTES:
        raise ValueError("release.json 結構不對:大小越界")
    if not isinstance(sig_b64, str) or _SIGNATURE_RE.fullmatch(sig_b64) is None:
        raise ValueError("release.json 簽名編碼不合法")
    if not isinstance(pubkey_hex, str) or re.fullmatch(r"[0-9a-f]{64}", pubkey_hex) is None:
        raise ValueError("release.json 公鑰編碼不合法")
    sig = base64.b64decode(sig_b64.strip(), validate=True)
    if not ed25519_verify(bytes.fromhex(pubkey_hex), manifest_bytes, sig):
        raise ValueError("release.json 簽名驗證失敗(repo 被改?公鑰輪換?)")

    def reject_duplicate_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"release.json 結構不對:重複字段 {key}")
            result[key] = value
        return result

    try:
        m = json.loads(manifest_bytes.decode("utf-8"), object_pairs_hook=reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("release.json 結構不對:JSON 非法") from exc
    if (
        not isinstance(m, dict)
        or set(m) != {"version", "bootstrapVersion", "bootstrapSha256", "files"}
        or type(m.get("bootstrapVersion")) is not int
        or m["bootstrapVersion"] != 1
        or not isinstance(m.get("bootstrapSha256"), str)
        or _LOWER_SHA256_RE.fullmatch(m["bootstrapSha256"]) is None
        or not isinstance(m.get("files"), dict)
        or not 0 < len(m["files"]) <= 10_000
    ):
        raise ValueError("release.json 結構不對")
    _parse_strict_semver(m.get("version"))
    for path, digest in m["files"].items():
        if (
            not isinstance(path, str)
            or _SAFE_PATH_RE.fullmatch(path) is None
            or path.startswith("/")
            or "//" in path
            or any(part in (".", "..") for part in path.split("/"))
            or not isinstance(digest, str)
            or _LOWER_SHA256_RE.fullmatch(digest) is None
        ):
            raise ValueError(f"release.json 結構不對:非法文件項 {path}")
    if "install.sh" not in m["files"]:
        raise ValueError("release.json 結構不對:缺 install.sh")
    canonical_obj = {
        "version": m["version"],
        "bootstrapVersion": m["bootstrapVersion"],
        "bootstrapSha256": m["bootstrapSha256"],
        "files": dict(sorted(m["files"].items())),
    }
    canonical = (json.dumps(canonical_obj, indent=2).replace("\n    ", "\n  ") + "\n").encode()
    if canonical != manifest_bytes:
        raise ValueError("release.json 結構不對:非 canonical/歧義字段")
    return m


def check_not_downgrade(manifest_version: str, current_version: str) -> None:
    """歷史 API 名稱保留；現在同版重放也拒絕，只允許嚴格升版。"""
    order = _semver_compare(manifest_version, current_version)
    if order <= 0:
        relation = "<" if order < 0 else "="
        raise ValueError(f"拒絕非升級清單:清單 v{manifest_version} {relation} 本機 v{current_version}")


def check_self_update_allowed(manifest: dict, current_version: str) -> None:
    """執行前再次要求 bootstrap 信任橋；verify_manifest 已对缺字段 fail closed。"""
    if (
        type(manifest.get("bootstrapVersion")) is not int
        or manifest["bootstrapVersion"] != 1
        or not isinstance(manifest.get("bootstrapSha256"), str)
        or _SHA256_RE.fullmatch(manifest["bootstrapSha256"]) is None
    ):
        raise ValueError("release.json 缺少合法 bootstrap v1 信任橋")
    check_not_downgrade(manifest.get("version"), current_version)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
