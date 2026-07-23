"""E2E 用户控制信封认证与持久防重放（#370）。

Macchiato server 在 E2E 威胁模型里不可信。它可以路由控制信封，却不能生成、改写或重放
设备意图。本模块用每会话 K_S 派生独立 K_ctrl，验证 HMAC 后先原子推进
``(wire session, key id, device id) -> max seq``，再把 payload 交给 connector 执行。
"""

from __future__ import annotations

import base64
import errno
import fcntl
import hashlib
import hmac
import json
import os
import stat
import struct
import threading
import time
import unicodedata
import uuid
from typing import Callable

from e2e_keys import E2EKeyStore


MAGIC = b"macchiato-e2e-control-v1"
DISABLE_RECEIPT_MAGIC = b"macchiato-e2e-disable-receipt-v1"
HKDF_SALT = hashlib.sha256(b"macchiato-e2e-control-v1:salt").digest()
HKDF_INFO = b"macchiato-e2e-control-v1:key"
MAX_U64 = (1 << 64) - 1
MAX_PAYLOAD = 64 * 1024
MAX_LIFETIME_MS = 5 * 60 * 1000
CLOCK_SKEW_MS = 60 * 1000
ALLOWED_KINDS = {
    "command.invoke",
    "approval.respond",
    "clarify.respond",
    "secret.respond",
    "session.cwd.set",
    "session.permission.set",
    "session.model.set",
    "session.effort.set",
    "session.interrupt",
    "session.e2e.disable",
    "task.stop",
}


class E2EControlError(RuntimeError):
    pass


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _decode_b64(value: object, field: str, *, max_bytes: int) -> bytes:
    if not isinstance(value, str) or not value or len(value) > (max_bytes * 4 // 3 + 8):
        raise E2EControlError(f"{field} is not canonical base64")
    try:
        raw = base64.b64decode(value, validate=True)
    except Exception as exc:
        raise E2EControlError(f"{field} is not canonical base64") from exc
    if not raw or len(raw) > max_bytes or _b64(raw) != value:
        raise E2EControlError(f"{field} is not canonical base64")
    return raw


def _decode_b64url(value: object, field: str, *, expected_bytes: int) -> bytes:
    if not isinstance(value, str) or not value or "=" in value:
        raise E2EControlError(f"{field} is not canonical base64url")
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except Exception as exc:
        raise E2EControlError(f"{field} is not canonical base64url") from exc
    if len(raw) != expected_bytes or _b64url(raw) != value:
        raise E2EControlError(f"{field} is not canonical base64url")
    return raw


def _parse_u64(value: object, field: str, *, allow_zero: bool = False) -> int:
    if not isinstance(value, str) or not value.isascii() or not value.isdigit():
        raise E2EControlError(f"{field} must be a canonical UInt64 string")
    if len(value) > 1 and value[0] == "0":
        raise E2EControlError(f"{field} must be canonical")
    n = int(value)
    if n > MAX_U64 or (not allow_zero and n == 0):
        raise E2EControlError(f"{field} out of range")
    return n


def _field(raw: bytes) -> bytes:
    if len(raw) > 0xFFFFFFFF:
        raise E2EControlError("control field too large")
    return struct.pack(">I", len(raw)) + raw


def mac_input(envelope: dict, payload: bytes) -> bytes:
    """跨 Swift/Node/Python 固定的长度前缀编码；不依赖 JSON key 顺序。"""
    ordered = (
        MAGIC,
        b"1",
        envelope["sessionId"].encode("utf-8"),
        envelope["hermesSessionId"].encode("utf-8"),
        envelope["deviceId"].encode("utf-8"),
        envelope["keyId"].encode("ascii"),
        envelope["msgId"].encode("utf-8"),
        envelope["seq"].encode("ascii"),
        envelope["issuedAtMs"].encode("ascii"),
        envelope["expiresAtMs"].encode("ascii"),
        envelope["kind"].encode("ascii"),
        payload,
    )
    return b"".join(_field(part) for part in ordered)


def derive_control_key(session_key: bytes) -> bytes:
    """RFC 5869 HKDF-SHA256（单 block，32 bytes）。"""
    if len(session_key) != 32:
        raise E2EControlError("K_S must be 32 bytes")
    prk = hmac.new(HKDF_SALT, session_key, hashlib.sha256).digest()
    return hmac.new(prk, HKDF_INFO + b"\x01", hashlib.sha256).digest()


def key_id(session_key: bytes) -> str:
    return _b64url(hashlib.sha256(session_key).digest())


def _default_ignorable(codepoint: int) -> bool:
    """Unicode Default_Ignorable_Code_Point ranges used by JS `/\\p{...}/u`.

    Keep this explicit so approval rendering doesn't depend on an optional regex package or the
    host locale. These ranges cover the Unicode derived property (including variation selectors
    and supplementary tags) used by the Node connectors.
    """
    return (
        codepoint == 0x00AD
        or codepoint == 0x034F
        or codepoint == 0x061C
        or 0x115F <= codepoint <= 0x1160
        or 0x17B4 <= codepoint <= 0x17B5
        or 0x180B <= codepoint <= 0x180F
        or 0x200B <= codepoint <= 0x200F
        or 0x202A <= codepoint <= 0x202E
        or 0x2060 <= codepoint <= 0x206F
        or codepoint == 0x3164
        or 0xFE00 <= codepoint <= 0xFE0F
        or codepoint == 0xFEFF
        or codepoint == 0xFFA0
        or 0xFFF0 <= codepoint <= 0xFFF8
        or 0x1BCA0 <= codepoint <= 0x1BCA3
        or 0x1D173 <= codepoint <= 0x1D17A
        or 0xE0000 <= codepoint <= 0xE0FFF
    )


def _visible_json_string(value: str) -> str:
    # JSON escaping first matches JSON.stringify: ordinary C0 controls become `\n`, `\t`, or
    # `\u00xx`; the second pass makes C1/Cf/Zl/Zp/default-ignorable characters visibly explicit.
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    out: list[str] = []
    for char in encoded:
        codepoint = ord(char)
        if (
            unicodedata.category(char) in {"Cc", "Cf", "Zl", "Zp"}
            or _default_ignorable(codepoint)
        ):
            if codepoint <= 0xFFFF:
                out.append(f"\\u{codepoint:04x}")
            else:
                adjusted = codepoint - 0x10000
                high = 0xD800 + (adjusted >> 10)
                low = 0xDC00 + (adjusted & 0x3FF)
                out.append(f"\\u{high:04x}\\u{low:04x}")
        else:
            out.append(char)
    return "".join(out)


def visible_stable_json(value: object) -> str:
    """Canonical JSON whose invisible/bidi controls are rendered as literal `\\uXXXX`.

    This is the approval digest preimage and the exact string shown by the device. To avoid
    Python/JavaScript number-format ambiguities, approval snapshots reject floats and integers
    outside JavaScript's safe range rather than displaying one value and authenticating another.
    """
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _visible_json_string(value)
    if isinstance(value, int):
        if abs(value) > (1 << 53) - 1:
            raise E2EControlError("approval JSON integer exceeds safe canonical range")
        return str(value)
    if isinstance(value, float):
        raise E2EControlError("approval JSON floats are not canonically supported")
    if isinstance(value, list):
        return "[" + ",".join(visible_stable_json(item) for item in value) + "]"
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise E2EControlError("approval JSON object keys must be strings")
        # JavaScript Array.sort compares UTF-16 code units, not Unicode scalar values.
        keys = sorted(
            value,
            key=lambda key: key.encode("utf-16-be", errors="surrogatepass"),
        )
        return (
            "{"
            + ",".join(
                _visible_json_string(key) + ":" + visible_stable_json(value[key])
                for key in keys
            )
            + "}"
        )
    raise E2EControlError("approval request is not canonical JSON")


def request_digest(session_key: bytes, value: object) -> str:
    """审批上下文的 keyed 摘要。

    摘要会经 Link B/server 原样回显，因此不能用裸 SHA-256：server 已知 requestId 后可对
    低熵命令/路径做字典猜测。这里复用 K_ctrl，并用独立 domain + 长度前缀避免与控制
    MAC 输入发生跨协议歧义；与三家 TS connector 逐位一致。
    """
    raw = visible_stable_json(value).encode("utf-8")
    domain = b"approval-request-v1"
    digest = hmac.new(
        derive_control_key(session_key),
        _field(domain) + _field(raw),
        hashlib.sha256,
    ).digest()
    return _b64url(digest)


def disable_receipt_mac_input(receipt: dict) -> bytes:
    """跨 Swift/Node/Python 固定的 E2E 关闭 release receipt 编码。"""
    ordered = (
        DISABLE_RECEIPT_MAGIC,
        b"1",
        b"session.e2e.disabled",
        receipt["sessionId"].encode("utf-8"),
        receipt["hermesSessionId"].encode("utf-8"),
        receipt["keyId"].encode("ascii"),
        receipt["intentDeviceId"].encode("utf-8"),
        receipt["intentMsgId"].encode("utf-8"),
        receipt["intentSeq"].encode("ascii"),
        receipt["receiptId"].encode("utf-8"),
    )
    return b"".join(_field(part) for part in ordered)


def validate_disable_receipt_shape(receipt: object) -> dict:
    if not isinstance(receipt, dict) or set(receipt) != {
        "v",
        "kind",
        "sessionId",
        "hermesSessionId",
        "keyId",
        "intentDeviceId",
        "intentMsgId",
        "intentSeq",
        "receiptId",
        "mac",
    }:
        raise E2EControlError("invalid disable receipt shape")
    if receipt.get("v") != 1 or receipt.get("kind") != "session.e2e.disabled":
        raise E2EControlError("unsupported disable receipt version or kind")
    for name in (
        "sessionId",
        "hermesSessionId",
        "keyId",
        "intentDeviceId",
        "intentMsgId",
        "receiptId",
    ):
        value = receipt.get(name)
        if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 512:
            raise E2EControlError(f"invalid disable receipt {name}")
    try:
        parsed_receipt_id = uuid.UUID(receipt["receiptId"], version=4)
    except (ValueError, AttributeError) as exc:
        raise E2EControlError("disable receipt id must be a canonical UUIDv4") from exc
    if str(parsed_receipt_id) != receipt["receiptId"]:
        raise E2EControlError("disable receipt id must be a canonical UUIDv4")
    _parse_u64(receipt.get("intentSeq"), "disable receipt intentSeq")
    _decode_b64url(receipt.get("keyId"), "disable receipt keyId", expected_bytes=32)
    mac = _decode_b64(receipt.get("mac"), "disable receipt mac", max_bytes=32)
    if len(mac) != 32:
        raise E2EControlError("invalid disable receipt MAC length")
    return receipt


def create_disable_receipt(
    session_key: bytes,
    intent: dict,
    *,
    receipt_id: str | None = None,
) -> dict:
    """为已经验证、持久化的 disable intent 签发不可伪造的 plaintext release receipt。"""
    receipt = {
        "v": 1,
        "kind": "session.e2e.disabled",
        "sessionId": intent.get("sessionId"),
        "hermesSessionId": intent.get("hermesSessionId"),
        "keyId": intent.get("keyId"),
        "intentDeviceId": intent.get("deviceId"),
        "intentMsgId": intent.get("msgId"),
        "intentSeq": intent.get("seq"),
        "receiptId": receipt_id or str(uuid.uuid4()),
        # Temporary canonical placeholder lets the exact shape validator run before signing.
        "mac": _b64(bytes(32)),
    }
    validate_disable_receipt_shape(receipt)
    if not hmac.compare_digest(receipt["keyId"], key_id(session_key)):
        raise E2EControlError("disable receipt intent does not bind current key")
    receipt["mac"] = _b64(
        hmac.new(
            derive_control_key(session_key),
            disable_receipt_mac_input(receipt),
            hashlib.sha256,
        ).digest()
    )
    return receipt


def verify_disable_receipt(
    session_key: bytes,
    receipt: object,
    *,
    expected_intent: dict | None = None,
) -> dict:
    """验证 receipt 的 MAC、当前 K_S 与原始设备 intent 绑定；成功返回原对象。"""
    value = validate_disable_receipt_shape(receipt)
    mac = _decode_b64(value.get("mac"), "disable receipt mac", max_bytes=32)
    if len(mac) != 32:
        raise E2EControlError("invalid disable receipt MAC length")
    if not hmac.compare_digest(value["keyId"], key_id(session_key)):
        raise E2EControlError("disable receipt key id mismatch")
    expected_mac = hmac.new(
        derive_control_key(session_key),
        disable_receipt_mac_input(value),
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(mac, expected_mac):
        raise E2EControlError("disable receipt MAC mismatch")
    if expected_intent is not None:
        bindings = {
            "sessionId": "sessionId",
            "hermesSessionId": "hermesSessionId",
            "keyId": "keyId",
            "intentDeviceId": "deviceId",
            "intentMsgId": "msgId",
            "intentSeq": "seq",
        }
        for receipt_field, intent_field in bindings.items():
            if value[receipt_field] != expected_intent.get(intent_field):
                raise E2EControlError("disable receipt intent mismatch")
    return value


def _strict_object(raw: bytes) -> dict:
    def pairs(items):
        out = {}
        for k, v in items:
            if k in out:
                raise E2EControlError(f"duplicate payload key: {k}")
            out[k] = v
        return out

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs)
    except E2EControlError:
        raise
    except Exception as exc:
        raise E2EControlError("payload is not UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise E2EControlError("payload must be a JSON object")
    return value


def _state_dir() -> str:
    return os.path.expanduser(os.environ.get("MACCHIATO_STATE_DIR", "").strip() or "~/.macchiato")


def control_store_path() -> str:
    return os.path.expanduser(
        os.environ.get("MACCHIATO_HERMES_E2E_CONTROL_STORE")
        or os.path.join(_state_dir(), "hermes-e2e-control.json")
    )


class E2EControlVerifier:
    def __init__(
        self,
        keys: E2EKeyStore,
        path: str | None = None,
        now_ms: Callable[[], int] | None = None,
    ):
        self._keys = keys
        self._path = path or control_store_path()
        self._now_ms = now_ms or (lambda: int(time.time() * 1000))
        self._lock = threading.Lock()
        self._poisoned = False
        process_lock = self._acquire_process_lock()
        try:
            self._floors, self._bindings = self._load()
        finally:
            self._release_process_lock(process_lock)

    def _acquire_process_lock(self) -> int:
        """跨进程互斥 replay snapshot 的 read→compare→persist 事务。

        `flock` 由内核随进程退出自动释放，不需要猜测/删除 stale lock；lock inode 固定留在
        同目录。权限或文件类型异常直接拒绝，避免跟随预置 symlink。
        """
        lock_path = self._path + ".lock"
        parent = os.path.dirname(lock_path) or "."
        os.makedirs(parent, mode=0o700, exist_ok=True)
        flags = os.O_RDWR | os.O_CREAT
        flags |= getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(lock_path, flags, 0o600)
        except OSError as exc:
            raise E2EControlError("cannot open E2E control replay lock") from exc
        try:
            st = os.fstat(fd)
            if (
                not stat.S_ISREG(st.st_mode)
                or st.st_nlink != 1
                or (hasattr(os, "getuid") and st.st_uid != os.getuid())
                or stat.S_IMODE(st.st_mode) & 0o077
            ):
                raise E2EControlError("unsafe E2E control replay lock file")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                if exc.errno in (errno.EACCES, errno.EAGAIN):
                    raise E2EControlError("E2E control replay store is busy") from exc
                raise
            os.ftruncate(fd, 0)
            os.write(fd, f"{os.getpid()}\n".encode("ascii"))
            os.fsync(fd)
            return fd
        except Exception:
            os.close(fd)
            raise

    @staticmethod
    def _release_process_lock(fd: int) -> None:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)

    @staticmethod
    def _validate_state(
        value: object,
    ) -> tuple[dict[str, dict[str, dict[str, int]]], dict[str, str]]:
        legacy = (
            isinstance(value, dict)
            and value.get("version") == 1
            and set(value) == {"version", "floors"}
        )
        current = (
            isinstance(value, dict)
            and value.get("version") == 2
            and set(value) == {"version", "bindings", "floors"}
        )
        if (
            not (legacy or current)
            or not isinstance(value.get("floors"), dict)
        ):
            raise E2EControlError("invalid replay state")
        out: dict[str, dict[str, dict[str, int]]] = {}
        for sid, by_key in value["floors"].items():
            if not isinstance(sid, str) or not sid or not isinstance(by_key, dict):
                raise E2EControlError("invalid replay session")
            out[sid] = {}
            for kid, by_device in by_key.items():
                if not isinstance(kid, str) or not kid or not isinstance(by_device, dict):
                    raise E2EControlError("invalid replay key")
                out[sid][kid] = {}
                for device, seq in by_device.items():
                    if not isinstance(device, str) or not device:
                        raise E2EControlError("invalid replay device")
                    out[sid][kid][device] = _parse_u64(seq, "stored seq")
        bindings: dict[str, str] = {}
        if current:
            raw_bindings = value.get("bindings")
            if not isinstance(raw_bindings, dict):
                raise E2EControlError("invalid public session bindings")
            for sid, public_session_id in raw_bindings.items():
                if (
                    not isinstance(sid, str)
                    or not sid
                    or len(sid.encode("utf-8")) > 512
                    or not isinstance(public_session_id, str)
                    or not public_session_id
                    or len(public_session_id.encode("utf-8")) > 512
                ):
                    raise E2EControlError("invalid public session binding")
                bindings[sid] = public_session_id
        return out, bindings

    def _read(self, path: str):
        try:
            with open(path, "rb") as f:
                raw = f.read(MAX_PAYLOAD * 8)
        except FileNotFoundError:
            return None
        try:
            return self._validate_state(json.loads(raw))
        except Exception as exc:
            raise E2EControlError(f"corrupt replay store {path}") from exc

    @staticmethod
    def _merge(
        states,
    ) -> tuple[dict[str, dict[str, dict[str, int]]], dict[str, str]]:
        merged: dict[str, dict[str, dict[str, int]]] = {}
        bindings: dict[str, str] = {}
        for state in states:
            if state is None:
                continue
            floors, state_bindings = state
            for sid, public_session_id in state_bindings.items():
                current = bindings.get(sid)
                if current is not None and current != public_session_id:
                    raise E2EControlError(
                        f"conflicting public session binding for wire session {sid}"
                    )
                bindings[sid] = public_session_id
            for sid, by_key in floors.items():
                dst_keys = merged.setdefault(sid, {})
                for kid, by_device in by_key.items():
                    dst_devices = dst_keys.setdefault(kid, {})
                    for device, seq in by_device.items():
                        dst_devices[device] = max(dst_devices.get(device, 0), seq)
        return merged, bindings

    def _load(
        self,
    ) -> tuple[dict[str, dict[str, dict[str, int]]], dict[str, str]]:
        # 写入顺序固定为 primary → backup。只有 primary 能证明最新已提交水位；若 primary
        # 缺失/损坏却直接从 backup 恢复，backup 可能恰是崩溃窗口里的旧一代，会重新放行 replay。
        try:
            primary = self._read(self._path)
        except E2EControlError as exc:
            raise E2EControlError("primary E2E control replay snapshot is invalid") from exc
        if primary is None:
            if os.path.lexists(self._path + ".bak"):
                raise E2EControlError(
                    "primary E2E control replay snapshot is missing while backup exists"
                )
            return {}, {}
        try:
            backup = self._read(self._path + ".bak")
        except E2EControlError:
            # primary 已经由原子 rename + fsync 提交，损坏的冗余副本可从它安全修复。
            backup = None
        merged_floors, merged_bindings = self._merge((primary, backup))
        # 两份有效时逐项取最大值；随后立即修复成相同 snapshot。
        self._persist(merged_floors, merged_bindings)
        return merged_floors, merged_bindings

    @staticmethod
    def _serialize(
        floors: dict[str, dict[str, dict[str, int]]],
        bindings: dict[str, str],
    ) -> bytes:
        encoded = {
            sid: {
                kid: {device: str(seq) for device, seq in sorted(by_device.items())}
                for kid, by_device in sorted(by_key.items())
            }
            for sid, by_key in sorted(floors.items())
        }
        return json.dumps(
            {
                "version": 2,
                "bindings": dict(sorted(bindings.items())),
                "floors": encoded,
            },
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")

    @staticmethod
    def _atomic_write(target: str, raw: bytes) -> None:
        parent = os.path.dirname(target) or "."
        os.makedirs(parent, mode=0o700, exist_ok=True)
        tmp = os.path.join(parent, f".{os.path.basename(target)}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
        fd = None
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb", closefd=True) as f:
                fd = None
                f.write(raw)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, target)
            dfd = os.open(parent, os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        finally:
            if fd is not None:
                os.close(fd)
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass

    def _persist(
        self,
        floors: dict[str, dict[str, dict[str, int]]],
        bindings: dict[str, str],
    ) -> None:
        raw = self._serialize(floors, bindings)
        self._atomic_write(self._path, raw)
        self._atomic_write(self._path + ".bak", raw)

    def verify_and_consume(self, envelope: object, expected_wire_session: str) -> tuple[str, dict]:
        if self._poisoned:
            raise E2EControlError("replay store is poisoned after a persistence failure")
        if not isinstance(envelope, dict) or set(envelope) != {
            "v",
            "sessionId",
            "hermesSessionId",
            "deviceId",
            "keyId",
            "msgId",
            "seq",
            "issuedAtMs",
            "expiresAtMs",
            "kind",
            "payloadB64",
            "mac",
        }:
            raise E2EControlError("invalid control envelope shape")
        if envelope.get("v") != 1:
            raise E2EControlError("unsupported control envelope version")
        for name in ("sessionId", "hermesSessionId", "deviceId", "keyId", "msgId", "kind"):
            value = envelope.get(name)
            if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 512:
                raise E2EControlError(f"invalid {name}")
        if envelope["hermesSessionId"] != expected_wire_session:
            raise E2EControlError("control wire session mismatch")
        if envelope["kind"] not in ALLOWED_KINDS:
            raise E2EControlError("unsupported control kind")

        seq = _parse_u64(envelope["seq"], "seq")
        issued = _parse_u64(envelope["issuedAtMs"], "issuedAtMs", allow_zero=True)
        expires = _parse_u64(envelope["expiresAtMs"], "expiresAtMs", allow_zero=True)
        now = self._now_ms()
        if expires <= issued or expires - issued > MAX_LIFETIME_MS:
            raise E2EControlError("invalid control lifetime")
        if issued > now + CLOCK_SKEW_MS or expires < now:
            raise E2EControlError("control envelope expired or issued in the future")

        payload_raw = _decode_b64(envelope["payloadB64"], "payloadB64", max_bytes=MAX_PAYLOAD)
        mac = _decode_b64(envelope["mac"], "mac", max_bytes=32)
        if len(mac) != 32:
            raise E2EControlError("invalid control MAC length")
        session_key = self._keys.require_key(expected_wire_session)
        expected_kid = key_id(session_key)
        if not hmac.compare_digest(envelope["keyId"], expected_kid):
            raise E2EControlError("control key id mismatch")
        expected_mac = hmac.new(
            derive_control_key(session_key),
            mac_input(envelope, payload_raw),
            hashlib.sha256,
        ).digest()
        if not hmac.compare_digest(mac, expected_mac):
            raise E2EControlError("control MAC mismatch")
        payload = _strict_object(payload_raw)

        with self._lock:
            process_lock = self._acquire_process_lock()
            try:
                # 不能只信构造时缓存：滚动更新或误启两个 connector 进程时，它们可能同时从
                # floor=0 起步。锁内重读并逐项取 max，才保证同一签帧全机只消费一次。
                disk_state = self._load()
                merged, bindings = self._merge(
                    ((self._floors, self._bindings), disk_state)
                )
                bound_public_session = bindings.get(expected_wire_session)
                if (
                    bound_public_session is not None
                    and bound_public_session != envelope["sessionId"]
                ):
                    raise E2EControlError(
                        "control public/wire session binding mismatch"
                    )
                current = (
                    merged.get(expected_wire_session, {})
                    .get(expected_kid, {})
                    .get(envelope["deviceId"], 0)
                )
                if seq <= current:
                    raise E2EControlError("replayed or out-of-order control envelope")
                next_floors = json.loads(json.dumps(merged))
                next_floors.setdefault(expected_wire_session, {}).setdefault(expected_kid, {})[
                    envelope["deviceId"]
                ] = seq
                next_bindings = dict(bindings)
                next_bindings[expected_wire_session] = envelope["sessionId"]
                try:
                    self._persist(next_floors, next_bindings)
                except Exception as exc:
                    self._poisoned = True
                    raise E2EControlError("failed to persist replay floor") from exc
                self._floors = next_floors
                self._bindings = next_bindings
            except E2EControlError:
                raise
            except Exception as exc:
                self._poisoned = True
                raise E2EControlError("failed to reload replay floor") from exc
            finally:
                self._release_process_lock(process_lock)
        return envelope["kind"], payload
