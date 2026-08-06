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
import os
import re
import time
from datetime import datetime, timezone

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


# ── #669 階段 0:策略 sidecar(release-policy.json + .sig)────────────────────────
# **為什麼是獨立檔案、而不是往 release.json 加欄位**:上面的 verify_manifest 把清單欄位集
# 釘死成 {version,bootstrapVersion,bootstrapSha256,files},後面還做 canonical 位元組比對。
# 於是往 release.json 加**任何**一個欄位,全部**存量**連接器都會判清單非法 → self_update 掛,
# supervisor 的崩潰自癒(#528,調用的就是本檔的凍結副本)一起掛,全體永久只剩手工重裝。
# 所以自動更新要用的控制位(分批比例 / 過期時間 / 版本黑名單)一律住在這個 sidecar:老客戶端
# 根本不知道有這個檔案、不去拉它,行為零變化。**release.json 的四個欄位永不動。**
#
# **為什麼本驗證器未知欄位一律忽略**:上面那套「欄位集精確相等 + canonical 位元組比對」把
# 格式焊死了——本意是防重複/歧義欄位,代價是格式再也演進不了(就是本節存在的理由)。這裡
# 絕不重蹈:日後往 policy 加欄位(頻道、最低版本、閒時窗口…)時,舊連接器只是看不懂新欄位,
# 不會把整份策略判非法。嚴格性沒丟,只是落在**已知欄位**上:型別、範圍、語義照 verify_manifest
# 的防禦風格查(嚴格 semver、大小上限、拒絕重複欄位);未知欄位單純不參與決策。
# fail-safe 方向也不同:清單驗不過 = 不裝(安全第一);策略驗不過/過期 = **不更新**,機器停在
# 當前能工作的版本上,絕不能變成「拒絕啟動」。
RELEASE_POLICY_SCHEMA = 1
_MAX_POLICY_BYTES = 64 * 1024
_MAX_BLOCKED_VERSIONS = 256
# 策略的最長有效期:簽壞一份「一百年不過期」的策略就等於永久放棄新鮮度保證(TUF freeze)。
_MAX_POLICY_VALIDITY_SECONDS = 90 * 24 * 60 * 60
# 序號上限取 JS 安全整數:Python 是 bignum,不釘這條兩個實現會對同一份位元組給出不同答案。
_MAX_POLICY_SEQUENCE = 2**53 - 1
_UTC_TIMESTAMP_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$")


class PolicyExpiredError(ValueError):
    """策略過期(不新鮮)。語義是「不更新」,調用方**不得**據此拒絕啟動或中止連接器。"""


def _parse_utc_timestamp(value, field: str) -> float:
    """只接受 RFC3339 的 UTC 秒級時間戳;寬鬆解析會吞掉時區與 2026-02-30 這類不存在的日期。"""
    if not isinstance(value, str) or _UTC_TIMESTAMP_RE.fullmatch(value) is None:
        raise ValueError(f"release-policy.json 結構不對:{field} 必須是 YYYY-MM-DDTHH:MM:SSZ")
    try:
        moment = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError as exc:  # 2026-02-30 / 25 時 之類
        raise ValueError(f"release-policy.json 結構不對:{field} 不是合法時刻 {value}") from exc
    return moment.timestamp()


def verify_policy(
    policy_bytes: bytes,
    sig_b64: str,
    pubkey_hex: str = RELEASE_PUBKEY_HEX,
    now: float | None = None,
) -> dict:
    """驗簽 + 解析策略 sidecar;失敗拋 ValueError,過期拋 PolicyExpiredError(ValueError 子類)。"""
    if not 0 < len(policy_bytes) <= _MAX_POLICY_BYTES:
        raise ValueError("release-policy.json 結構不對:大小越界")
    if not isinstance(sig_b64, str) or _SIGNATURE_RE.fullmatch(sig_b64) is None:
        raise ValueError("release-policy.json 簽名編碼不合法")
    if not isinstance(pubkey_hex, str) or re.fullmatch(r"[0-9a-f]{64}", pubkey_hex) is None:
        raise ValueError("release-policy.json 公鑰編碼不合法")
    sig = base64.b64decode(sig_b64.strip(), validate=True)
    if not ed25519_verify(bytes.fromhex(pubkey_hex), policy_bytes, sig):
        raise ValueError("release-policy.json 簽名驗證失敗(repo 被改?公鑰輪換?)")

    def reject_duplicate_keys(pairs):
        # JSON 對重複欄位是「後者勝」且靜默——同一份簽名位元組,不同解析器可以看到不同的
        # rolloutPercent。清單靠 canonical 位元組比對堵這個洞,策略不能釘死位元組(見上)。
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"release-policy.json 結構不對:重複欄位 {key}")
            result[key] = value
        return result

    try:
        p = json.loads(policy_bytes.decode("utf-8"), object_pairs_hook=reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("release-policy.json 結構不對:JSON 非法") from exc
    if not isinstance(p, dict):
        raise ValueError("release-policy.json 結構不對:頂層必須是物件")
    if type(p.get("schema")) is not int:  # bool 是 int 子類,這裡要擋掉
        raise ValueError("release-policy.json 結構不對:schema 必須是整數")
    if p["schema"] != RELEASE_POLICY_SCHEMA:
        # 新 schema 由新客戶端認;舊客戶端**停在原地**(不更新),不是報錯退出。
        raise ValueError(f"release-policy.json 不支援的 schema:{p['schema']}")
    # sequence 是**必填**已知欄位:沒有序號的策略無從防重放,只能整份拒絕(fail-safe = 不更新)。
    # 攻擊者無法從簽名位元組裡摘掉它(簽名覆蓋全文),缺失只可能來自簽名器 bug 或前序號時代的
    # 陳年策略——兩種都不該被當成「可以放行」。
    sequence = p.get("sequence")
    if type(sequence) is not int or not 1 <= sequence <= _MAX_POLICY_SEQUENCE:  # bool 是 int 子類
        raise ValueError("release-policy.json 結構不對:sequence 必須是 1 起的安全整數")
    _parse_strict_semver(p.get("version"))
    rollout = p.get("rolloutPercent")
    if type(rollout) is not int or not 0 <= rollout <= 100:
        raise ValueError("release-policy.json 結構不對:rolloutPercent 必須是 0–100 的整數")
    blocked = p.get("blocked")
    if not isinstance(blocked, list) or len(blocked) > _MAX_BLOCKED_VERSIONS:
        raise ValueError("release-policy.json 結構不對:blocked 必須是陣列且不超過上限")
    seen = set()
    for item in blocked:
        _parse_strict_semver(item)
        if item in seen:
            raise ValueError(f"release-policy.json 結構不對:blocked 重複項 {item}")
        seen.add(item)
    signed_at = _parse_utc_timestamp(p.get("signedAt"), "signedAt")
    expires = _parse_utc_timestamp(p.get("expires"), "expires")
    if expires <= signed_at:
        raise ValueError("release-policy.json 結構不對:expires 必須晚於 signedAt")
    if expires - signed_at > _MAX_POLICY_VALIDITY_SECONDS:
        raise ValueError("release-policy.json 結構不對:有效期超過上限")
    if (time.time() if now is None else now) >= expires:
        raise PolicyExpiredError(
            f"release-policy.json 已過期(expires {p['expires']})——維持現版本,不更新"
        )
    return p


class PolicyReplayError(ValueError):
    """策略是重放的舊版本。語義同過期:**不更新**,絕不是「不啟動」。"""


# 防重放存檔的格式版本(與策略的 schema 無關,是本機檔案自己的)。
_POLICY_SEQUENCE_STORE_SCHEMA = 1


def policy_sequence_path() -> str:
    """見過的最大序號存哪。

    `~/.macchiato/release-policy-seen.json`——**每機一份、四家共享**:策略談論的是這台機器
    該裝什麼,不分連接器;任一家擋下重放,其它家跟着受益。與 TS 側 `policySequencePath()`
    **刻意同一條路徑**(同一台機器上兩邊看到的必須是同一個「見過的最大值」,否則 hermes 擋下
    的重放,CC 那邊照樣放行)。
    """
    override = os.environ.get("MACCHIATO_POLICY_SEQUENCE_FILE", "").strip()
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".macchiato", "release-policy-seen.json")


def read_seen_policy_sequence(path: str | None = None) -> int:
    """讀「見過的最大序號」;**讀不到一律回 0**(還沒見過任何策略,首見即接受,TOFU)。

    為什麼壞掉的存檔也當「沒見過」而不是拒絕更新:這個檔案是本機快取,不是信任根——它唯一
    要防的是**網絡側**的重放,而能改寫它的人早已能改寫連接器自身(本地寫權限 = 完全淪陷)。
    「壞檔 → 永久停更」只會把一次崩潰寫壞的檔案變成一台再也修不好的機器。我們自己的寫是
    原子的(臨時檔 + rename),所以壞檔本就只可能來自外力。
    """
    target = policy_sequence_path() if path is None else path
    try:
        with open(target, "rb") as fh:
            parsed = json.loads(fh.read(64 * 1024))
    except Exception:
        return 0
    if not isinstance(parsed, dict) or parsed.get("schema") != _POLICY_SEQUENCE_STORE_SCHEMA:
        return 0
    seen = parsed.get("sequence")
    if type(seen) is not int or not 0 <= seen <= _MAX_POLICY_SEQUENCE:  # bool 是 int 子類
        return 0
    return seen


def record_policy_sequence(sequence: int, path: str | None = None) -> None:
    """記下見過的序號;**只進不退**(舊值更大就什麼都不做),原子落盤(臨時檔 + rename)。"""
    if type(sequence) is not int or not 0 <= sequence <= _MAX_POLICY_SEQUENCE:
        raise ValueError(f"拒絕記錄非法策略序號:{sequence!r}")
    target = policy_sequence_path() if path is None else path
    if read_seen_policy_sequence(target) >= sequence:
        return
    directory = os.path.dirname(target) or "."
    os.makedirs(directory, mode=0o700, exist_ok=True)
    tmp = os.path.join(directory, f".{os.path.basename(target)}.{os.getpid()}.tmp")
    payload = json.dumps({"schema": _POLICY_SEQUENCE_STORE_SCHEMA, "sequence": sequence}, indent=2)
    with open(os.open(tmp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600), "w") as fh:
        fh.write(payload + "\n")
    os.replace(tmp, target)


def assert_policy_not_replayed(policy: dict, seen_sequence: int) -> None:
    """序號低於本機見過的最大值 = 重放 → 拋 PolicyReplayError。

    **為什麼序號相同要接受、只拒更低**:策略在兩次重簽之間就是同一份位元組,連接器每輪拉到
    的都是它。若「見過即拒」,一台機器只要成功讀過一次策略就再也用不了它——直到下次有人重簽
    為止,分批放量與 blocked 名單常年失效。真正的攻擊面是**更低**的序號(舊策略)。
    「相同也拒」落在簽名器那一頭(buildReleasePolicy 拒絕簽出不嚴格遞增的序號)。
    """
    sequence = policy.get("sequence") if isinstance(policy, dict) else None
    if type(sequence) is not int or isinstance(sequence, bool):
        raise ValueError("release-policy.json 缺少合法 sequence")
    if sequence < seen_sequence:
        raise PolicyReplayError(
            f"release-policy.json 是重放的舊策略(sequence {sequence} < 本機見過的 "
            f"{seen_sequence})——維持現版本,不更新"
        )


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
