"""#1 發布簽名驗證(零依賴):純 Python ed25519(RFC 8032 參考實現)+ 清單校驗。

self_update 此前 `curl install.sh | bash` 裸跑——repo/CDN 投毒或 server 沦陷即本機 RCE。
現在:release.json + .sig 用內嵌公鑰驗簽 → 拒絕降級 → install.sh sha256 對上清單才執行。
信任根 = 發布機私鑰(~/.macchiato/release-signing.key,scripts/release/sign-manifest.mjs 簽)。
純 Python 驗簽 ~100ms,一次性調用可接受;Hermes venv 只保證 websockets,不引第三方密碼庫。
"""
from __future__ import annotations

import base64
import hashlib
import json

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
def _semver_lt(a: str, b: str) -> bool:
    pa = [int(x) for x in a.split(".") if x.isdigit() or x]
    pb = [int(x) for x in b.split(".") if x.isdigit() or x]
    for i in range(max(len(pa), len(pb))):
        x = pa[i] if i < len(pa) else 0
        y = pb[i] if i < len(pb) else 0
        if x != y:
            return x < y
    return False


def verify_manifest(manifest_bytes: bytes, sig_b64: str, pubkey_hex: str = RELEASE_PUBKEY_HEX) -> dict:
    """驗簽 + 解析;失敗拋 ValueError。"""
    sig = base64.b64decode(sig_b64.strip())
    if not ed25519_verify(bytes.fromhex(pubkey_hex), manifest_bytes, sig):
        raise ValueError("release.json 簽名驗證失敗(repo 被改?公鑰輪換?)")
    m = json.loads(manifest_bytes)
    if not isinstance(m.get("version"), str) or not isinstance(m.get("files"), dict):
        raise ValueError("release.json 結構不對")
    return m


def check_not_downgrade(manifest_version: str, current_version: str) -> None:
    if _semver_lt(manifest_version, current_version):
        raise ValueError(f"拒絕降級:清單 v{manifest_version} < 本機 v{current_version}")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
