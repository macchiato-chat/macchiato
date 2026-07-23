"""§19 per-session E2E 密鑰管理（連接器側，見 docs/e2e.md）。

職責：持有各 E2E 會話的會話密鑰 K_S、封裝給設備、加解密內容。
K_S 存 `~/.macchiato/e2e.json`（0600，在用戶自己的機器上）。**某 hermesSessionId 在 store 里 = 該會話已開 E2E。**
"""

import base64
import binascii
import fcntl
import hashlib
import json
import os
import stat
import sys
import threading
import uuid
from copy import deepcopy

import e2e_crypto as ec

# #309 多 profile 實例:落在每實例 STATE_DIR 下(K_S 各實例獨立;默認 ~/.macchiato 零遷移)。
_STATE_DIR = os.path.expanduser(os.environ.get("MACCHIATO_STATE_DIR", "").strip() or "~/.macchiato")
E2E_STORE = os.path.expanduser(os.environ.get("MACCHIATO_E2E_STORE") or os.path.join(_STATE_DIR, "e2e.json"))
_PENDING_DISABLE_PREFIX = "\0macchiato:pending-disable-v2:"
_PENDING_DISABLE_MARKER = hashlib.sha256(b"macchiato-e2e-pending-disable-v2").digest()
_PROTECTED_PREFIX = "\0macchiato:protected-v1:"
_PROTECTED_MARKER = hashlib.sha256(b"macchiato-e2e-protected-v1").digest()
_DISABLE_INTENT_KEYS = {
    "v",
    "sessionId",
    "hermesSessionId",
    "deviceId",
    "keyId",
    "msgId",
    "seq",
}
_DISABLE_RECEIPT_KEYS = {
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
}


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _protected_key(sid: str) -> str:
    encoded = base64.urlsafe_b64encode(sid.encode("utf-8")).decode("ascii").rstrip("=")
    return _PROTECTED_PREFIX + encoded


def _protected_sid(key: str) -> str:
    encoded = key[len(_PROTECTED_PREFIX):]
    if not encoded:
        raise ValueError("protected metadata missing session id")
    try:
        raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        sid = raw.decode("utf-8")
    except (ValueError, UnicodeDecodeError, binascii.Error) as exc:
        raise ValueError("protected metadata session id is not canonical base64url") from exc
    if (
        not sid
        or base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=") != encoded
    ):
        raise ValueError("protected metadata session id is not canonical base64url")
    return sid


def _pending_disable_key(state: dict) -> str:
    encoded = base64.urlsafe_b64encode(_canonical_json(state)).decode("ascii").rstrip("=")
    return _PENDING_DISABLE_PREFIX + encoded


def _pending_disable_state(key: str) -> dict:
    encoded = key[len(_PENDING_DISABLE_PREFIX):]
    if not encoded:
        raise ValueError("pending-disable metadata missing state")
    try:
        raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        state = json.loads(raw)
    except (ValueError, UnicodeDecodeError, binascii.Error, json.JSONDecodeError) as exc:
        raise ValueError("pending-disable metadata is not canonical base64url JSON") from exc
    if (
        base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=") != encoded
        or _canonical_json(state) != raw
        or not isinstance(state, dict)
        or set(state) != {"v", "intent", "receipt"}
        or state["v"] != 1
    ):
        raise ValueError("pending-disable metadata is not canonical")
    intent = state["intent"]
    if not isinstance(intent, dict) or set(intent) != _DISABLE_INTENT_KEYS or intent["v"] != 1:
        raise ValueError("pending-disable intent has invalid shape")
    for name in _DISABLE_INTENT_KEYS - {"v"}:
        value = intent[name]
        if not isinstance(value, str) or not value:
            raise ValueError(f"pending-disable intent has invalid {name}")
    if (
        not intent["seq"].isascii()
        or not intent["seq"].isdigit()
        or intent["seq"] == "0"
        or (len(intent["seq"]) > 1 and intent["seq"][0] == "0")
    ):
        raise ValueError("pending-disable intent has invalid seq")
    receipt = state["receipt"]
    if receipt is not None:
        if (
            not isinstance(receipt, dict)
            or set(receipt) != _DISABLE_RECEIPT_KEYS
            or receipt["v"] != 1
            or receipt["kind"] != "session.e2e.disabled"
        ):
            raise ValueError("pending-disable receipt has invalid shape")
        for name in _DISABLE_RECEIPT_KEYS - {"v"}:
            value = receipt[name]
            if not isinstance(value, str) or not value:
                raise ValueError(f"pending-disable receipt has invalid {name}")
        if (
            receipt["sessionId"] != intent["sessionId"]
            or receipt["hermesSessionId"] != intent["hermesSessionId"]
            or receipt["keyId"] != intent["keyId"]
            or receipt["intentDeviceId"] != intent["deviceId"]
            or receipt["intentMsgId"] != intent["msgId"]
            or receipt["intentSeq"] != intent["seq"]
        ):
            raise ValueError("pending-disable receipt does not bind its intent")
    return state


class E2EKeyStore:
    def __init__(self, path: str = E2E_STORE):
        self._path = path
        self._lock = threading.Lock()
        self._keys: dict[str, bytes] = {}  # hermesSessionId -> K_S(32B)
        self._pending_disable: dict[str, dict] = {}
        # server 的 e2e:true 只能把会话加入保护域，绝不能靠后续 e2e:false/omission 删除。
        # 即使 K_S 丢失也要持续 quarantine，避免把密文/控制误走 legacy 明文路径。
        self._protected: set[str] = set()
        self._disk_digest: bytes | None = None
        self._poisoned = False
        self._load()

    def _load(self) -> None:
        process_lock = self._acquire_process_lock()
        try:
            self._load_unlocked()
        finally:
            self._release_process_lock(process_lock)

    def _load_unlocked(self) -> None:
        """#241 fail-closed:e2e.json 損壞絕不能靜默回空——is_e2e 全 False 會讓原 E2E
        會話的 live 事件**明文直發 server**,違背 E2E 承諾。主檔壞/缺 → 試 .bak(恢復後
        立即重建主檔);兩檔都壞 → 拒啟。確認放棄密鑰可手動刪 e2e.json(+.bak) 後重啟,
        相關會話從此按明文處理。"""
        for path in (self._path, self._path + ".bak"):
            try:
                with open(path, "rb") as f:
                    raw = f.read()
                d = json.loads(raw)
                if not isinstance(d, dict):
                    raise ValueError("E2E store root must be an object")
                keys: dict[str, bytes] = {}
                pending_disable: dict[str, dict] = {}
                protected: set[str] = set()
                for stored_sid, encoded in d.items():
                    if not isinstance(stored_sid, str) or not isinstance(encoded, str):
                        raise ValueError("E2E store entry must be string:string")
                    value = base64.b64decode(encoded, validate=True)
                    if stored_sid.startswith(_PROTECTED_PREFIX):
                        sid = _protected_sid(stored_sid)
                        if value != _PROTECTED_MARKER or sid in protected:
                            raise ValueError("invalid or duplicate protected metadata")
                        protected.add(sid)
                        continue
                    if stored_sid.startswith(_PENDING_DISABLE_PREFIX):
                        state = _pending_disable_state(stored_sid)
                        sid = state["intent"]["hermesSessionId"]
                        if value != _PENDING_DISABLE_MARKER or sid in pending_disable:
                            raise ValueError("invalid or duplicate pending-disable metadata")
                        pending_disable[sid] = state
                        continue
                    if not stored_sid or len(value) != 32:
                        raise ValueError(f"bad K_S entry for {stored_sid!r}: {len(value)} bytes")
                    keys[stored_sid] = value
                if not set(pending_disable).issubset(keys):
                    raise ValueError("pending-disable metadata has no corresponding K_S")
                for sid, state in pending_disable.items():
                    expected_key_id = base64.urlsafe_b64encode(
                        hashlib.sha256(keys[sid]).digest()
                    ).decode("ascii").rstrip("=")
                    if state["intent"]["keyId"] != expected_key_id:
                        raise ValueError("pending-disable metadata key id mismatch")
                self._keys = keys
                self._pending_disable = pending_disable
                self._protected = protected
                repaired = self._serialized_snapshot()
                if path != self._path:
                    print(f"[e2e] 主檔壞/缺,已從 .bak 恢復 {len(keys)} 把密鑰", file=sys.stderr)
                    try:
                        os.unlink(self._path)  # 移走損壞主檔——別讓 _save 的輪替把它蓋進 .bak(唯一好備份)
                    except FileNotFoundError:
                        pass
                    self._write_snapshot_pair(repaired)
                else:
                    # 旧实现只信 valid primary，并完全忽略 stale/corrupt backup。旧版
                    # backup 本来就可能落后一代：若随后 primary 损坏，重启会恢复旧 K_S /
                    # protection floor，甚至把会话重新走明文。构造时已持有跨进程锁，故把
                    # 当前 primary 解析出的权威状态 canonical 地同步到两份；写失败则拒启。
                    self._write_snapshot_pair(repaired)
                self._disk_digest = hashlib.sha256(repaired).digest()
                return
            except FileNotFoundError:
                continue
            except (ValueError, binascii.Error, json.JSONDecodeError) as exc:
                print(f"[e2e] {path} 損壞:{exc!r}", file=sys.stderr)
                continue
        if os.path.exists(self._path) or os.path.exists(self._path + ".bak"):
            raise RuntimeError(
                "e2e.json 及其 .bak 均損壞——拒絕啟動(fail-closed):繼續跑會把 E2E 會話明文發往 "
                "server。如確認放棄這些密鑰,手動刪除 e2e.json 與 e2e.json.bak 後重啟"
                "(相關會話將按明文處理,歷史密文不可再解)。"
            )
        self._keys = {}  # 全新安裝
        self._pending_disable = {}
        self._protected = set()
        self._disk_digest = None

    def _serialized_snapshot(self) -> bytes:
        serialized = {
            sid: base64.b64encode(k).decode("ascii")
            for sid, k in self._keys.items()
        }
        for state in self._pending_disable.values():
            serialized[_pending_disable_key(state)] = base64.b64encode(
                _PENDING_DISABLE_MARKER
            ).decode("ascii")
        for sid in self._protected:
            serialized[_protected_key(sid)] = base64.b64encode(
                _PROTECTED_MARKER
            ).decode("ascii")
        return json.dumps(
            serialized,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")

    def _write_snapshot_pair(self, raw: bytes) -> None:
        # primary 与 backup 都写同一已 fsync snapshot。这样 save 返回（plaintext release
        # 才允许发送）即代表 intent/receipt 真正 durable；崩溃窗口至多保留旧 K_S，不会把
        # 已释放 plaintext 的 receipt 静默回滚掉。
        self._atomic_write(self._path, raw)
        self._atomic_write(self._path + ".bak", raw)

    def _save(self) -> None:
        self._assert_usable()
        raw = self._serialized_snapshot()
        process_lock = self._acquire_process_lock()
        try:
            try:
                with open(self._path, "rb") as f:
                    current_digest = hashlib.sha256(f.read()).digest()
            except FileNotFoundError:
                current_digest = None
            if current_digest != self._disk_digest:
                raise RuntimeError(
                    "E2E keystore changed in another process; refusing stale snapshot overwrite"
                )
            self._write_snapshot_pair(raw)
            self._disk_digest = hashlib.sha256(raw).digest()
        except Exception:
            # 全量快照的提交结果一旦不确定，本进程不能再凭 stale 内存判断某会话是明文。
            self._poisoned = True
            raise
        finally:
            self._release_process_lock(process_lock)

    def _acquire_process_lock(self) -> int:
        lock_path = self._path + ".lock"
        parent = os.path.dirname(lock_path) or "."
        os.makedirs(parent, mode=0o700, exist_ok=True)
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(lock_path, flags, 0o600)
        try:
            st = os.fstat(fd)
            if (
                not stat.S_ISREG(st.st_mode)
                or st.st_nlink != 1
                or (hasattr(os, "getuid") and st.st_uid != os.getuid())
                or stat.S_IMODE(st.st_mode) & 0o077
            ):
                raise RuntimeError("unsafe E2E keystore process lock")
            fcntl.flock(fd, fcntl.LOCK_EX)
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
    def _atomic_write(target: str, raw: bytes) -> None:
        parent = os.path.dirname(target) or "."
        os.makedirs(parent, mode=0o700, exist_ok=True)
        tmp = os.path.join(
            parent,
            f".{os.path.basename(target)}.{os.getpid()}.{uuid.uuid4().hex}.tmp",
        )
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        flags |= getattr(os, "O_NOFOLLOW", 0)
        fd = None
        try:
            fd = os.open(tmp, flags, 0o600)
            st = os.fstat(fd)
            if (
                not stat.S_ISREG(st.st_mode)
                or st.st_nlink != 1
                or (hasattr(os, "getuid") and st.st_uid != os.getuid())
                or stat.S_IMODE(st.st_mode) & 0o077
            ):
                raise RuntimeError("unsafe E2E keystore temporary file")
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

    # ── 狀態 ──────────────────────────────────────────────────────────────
    def _assert_usable(self) -> None:
        if self._poisoned:
            raise RuntimeError(
                "E2E keystore is poisoned after an uncertain/concurrent persistence result"
            )

    def is_e2e(self, sid: str) -> bool:
        with self._lock:
            # poisoned 時由 is_protected 把所有會話提升為 quarantine；這裡不能讓 stale K_S
            # 繼續被當成可安全收發的當前 epoch。
            return not self._poisoned and sid in self._keys

    def is_protected(self, sid: str) -> bool:
        """本地有 K_S 或曾由 server-positive ready 提升过的会话都必须走 fail-closed。"""
        with self._lock:
            return self._poisoned or sid in self._keys or sid in self._protected

    def protected_session_ids(self) -> set[str]:
        """返回当前可定位的保护域；poisoned 时调用方还必须停止全局内容输出。"""
        with self._lock:
            self._assert_usable()
            return set(self._keys).union(self._protected)

    def protect_sessions(self, session_ids: set[str]) -> None:
        """单调持久化 server-positive floor；server omission/false 永远不能降级。"""
        with self._lock:
            self._assert_usable()
            if any(not isinstance(sid, str) or not sid for sid in session_ids):
                raise ValueError("invalid protected session id")
            added = session_ids - self._protected
            if not added:
                return
            self._protected.update(added)
            try:
                self._save()
            except Exception:
                self._protected.difference_update(added)
                raise

    def require_key(self, sid: str) -> bytes:
        """返回既有 K_S；控制认证等安全边界绝不能在缺钥时偷偷创建新钥。"""
        with self._lock:
            self._assert_usable()
            key = self._keys.get(sid)
            if key is None:
                raise KeyError(f"no E2E key for session {sid}")
            return bytes(key)

    def get_or_create_key(self, sid: str) -> bytes:
        """返回該會話 K_S；首次（開啟 E2E）即生成並持久化。"""
        with self._lock:
            self._assert_usable()
            if sid in self._pending_disable:
                # plaintext release 已经离机或仍可能离机时，绝不能把同一 K_S 当作一次
                # “重新开启”的新 epoch 继续封装。必须先用认证 receipt 结算旧 epoch。
                raise RuntimeError(
                    "cannot reuse E2E key while authenticated disable is pending"
                )
            if sid not in self._keys:
                self._keys[sid] = ec.new_session_key()
                self._protected.add(sid)
                try:
                    self._save()
                except Exception:
                    self._keys.pop(sid, None)
                    self._protected.discard(sid)
                    raise
            return self._keys[sid]

    def begin_disable(self, sid: str, envelope: dict) -> None:
        """持久记录已由设备签名授权的 disable intent；ACK 前必须成功落盘。"""
        with self._lock:
            self._assert_usable()
            key = self._keys.get(sid)
            if key is None:
                raise KeyError(f"no E2E key for session {sid}")
            intent = {
                "v": 1,
                "sessionId": envelope.get("sessionId"),
                "hermesSessionId": envelope.get("hermesSessionId"),
                "deviceId": envelope.get("deviceId"),
                "keyId": envelope.get("keyId"),
                "msgId": envelope.get("msgId"),
                "seq": envelope.get("seq"),
            }
            # 复用 metadata parser 做 exact/canonical 校验，并绑定当前 K_S。
            state = {"v": 1, "intent": intent, "receipt": None}
            _pending_disable_state(_pending_disable_key(state))
            expected_key_id = base64.urlsafe_b64encode(
                hashlib.sha256(key).digest()
            ).decode("ascii").rstrip("=")
            if intent["hermesSessionId"] != sid or intent["keyId"] != expected_key_id:
                raise ValueError("disable intent does not bind current session key")
            previous = self._pending_disable.get(sid)
            if previous == state:
                return
            if previous is not None and previous["receipt"] is not None:
                raise RuntimeError("disable release receipt already issued")
            self._pending_disable[sid] = state
            try:
                self._save()
            except Exception:
                if previous is None:
                    self._pending_disable.pop(sid, None)
                else:
                    self._pending_disable[sid] = previous
                raise

    def has_pending_disable(self, sid: str) -> bool:
        with self._lock:
            self._assert_usable()
            return sid in self._pending_disable and sid in self._keys

    def pending_disable(self, sid: str) -> dict | None:
        with self._lock:
            self._assert_usable()
            state = self._pending_disable.get(sid)
            return deepcopy(state) if state is not None and sid in self._keys else None

    def pending_disable_sessions(self) -> set[str]:
        with self._lock:
            self._assert_usable()
            return set(self._pending_disable).intersection(self._keys)

    def save_disable_receipt(self, sid: str, receipt: dict) -> None:
        """plaintext 快照离开本机前持久化 release receipt；失败则绝不发送。"""
        with self._lock:
            self._assert_usable()
            previous = self._pending_disable.get(sid)
            if previous is None or sid not in self._keys:
                raise RuntimeError(f"no authenticated pending disable for session {sid}")
            next_state = deepcopy(previous)
            next_state["receipt"] = deepcopy(receipt)
            _pending_disable_state(_pending_disable_key(next_state))
            if previous["receipt"] == receipt:
                return
            if previous["receipt"] is not None:
                raise RuntimeError("cannot replace an issued disable release receipt")
            self._pending_disable[sid] = next_state
            try:
                self._save()
            except Exception:
                self._pending_disable[sid] = previous
                raise

    def cancel_disable(self, sid: str) -> None:
        """尚未释放 plaintext 时可撤销 intent；receipt 已签发后必须保留并重试。"""
        with self._lock:
            self._assert_usable()
            previous = self._pending_disable.get(sid)
            if previous is None:
                return
            if previous["receipt"] is not None:
                raise RuntimeError("cannot cancel disable after release receipt was issued")
            self._pending_disable.pop(sid)
            try:
                self._save()
            except Exception:
                self._pending_disable[sid] = previous
                raise

    def complete_disable(self, sid: str, receipt: dict) -> None:
        """只在 connector-authenticated receipt 获提交确认后原子删 K_S。"""
        self._complete_disable(sid, receipt, retain_protection=False)

    def complete_disable_for_reenable(self, sid: str, receipt: dict) -> None:
        """结算旧 disable epoch，但为同一事务中的 re-enable 保留 protection floor。

        server 的 pending-enable 不是独立可信证据：调用方必须先验过同包携带、由旧 K_S
        认证且绑定本地 intent 的 receipt。这样 K1 会被不可逆退休，随后 wrap 只会生成 K2。
        """
        self._complete_disable(sid, receipt, retain_protection=True)

    def _complete_disable(
        self, sid: str, receipt: dict, *, retain_protection: bool
    ) -> None:
        with self._lock:
            self._assert_usable()
            previous = self._pending_disable.get(sid)
            if previous is None or sid not in self._keys:
                raise RuntimeError(f"no authenticated pending disable for session {sid}")
            if previous["receipt"] != receipt:
                raise RuntimeError("disable completion receipt does not match persisted release")
            key = self._keys.pop(sid)
            self._pending_disable.pop(sid)
            was_protected = sid in self._protected
            if retain_protection:
                self._protected.add(sid)
            else:
                self._protected.discard(sid)
            try:
                self._save()
            except Exception:
                self._keys[sid] = key
                self._pending_disable[sid] = previous
                if was_protected:
                    self._protected.add(sid)
                else:
                    self._protected.discard(sid)
                raise

    # ── 密鑰分發 ──────────────────────────────────────────────────────────
    def wrap_for_devices(self, sid: str, devices: list) -> list:
        """把 K_S 封裝給每台設備公鑰 → [{deviceId, sealed}]。壞公鑰跳過。"""
        k_s = self.get_or_create_key(sid)
        out = []
        for d in devices or []:
            dev_id, pub = d.get("deviceId"), d.get("pubKey")
            if not dev_id or not pub:
                continue
            try:
                out.append({"deviceId": dev_id, "sealed": ec.wrap_key(k_s, pub)})
            except Exception:
                pass  # 公鑰格式壞 → 跳過該設備
        return out

    # ── 內容加解密（供 mirror/tui/prompt 接線用）──────────────────────────
    def encrypt_content(self, sid: str, obj) -> str:
        """把消息內容對象（如 {text, reasoning, tools}）序列化後加密為密文塊（base64）。"""
        return self.encrypt_serialized_content(
            sid,
            json.dumps(obj, ensure_ascii=False),
        )

    def encrypt_serialized_content(self, sid: str, plaintext: str) -> str:
        """加密已完成序列化的 JSON；供需先按最终 plaintext 做字節闸门的调用方使用。"""
        return ec.encrypt(self.get_or_create_key(sid), plaintext)

    def decrypt_content(self, sid: str, blob_b64: str):
        """解密密文塊還原內容對象。會話未開 E2E（無 K_S）→ KeyError。"""
        k_s = self._keys.get(sid)
        if k_s is None:
            raise KeyError(f"no E2E key for session {sid}")
        return json.loads(ec.decrypt(k_s, blob_b64))

    # ── 純文本加解密（prompt.submit 入站解密用）───────────────────────────
    def encrypt_text(self, sid: str, text: str) -> str:
        return ec.encrypt(self.get_or_create_key(sid), text)

    def decrypt_text(self, sid: str, blob_b64: str) -> str:
        k_s = self._keys.get(sid)
        if k_s is None:
            raise KeyError(f"no E2E key for session {sid}")
        return ec.decrypt(k_s, blob_b64)
