"""§19 per-session E2E 密鑰管理（連接器側，見 docs/e2e.md）。

職責：持有各 E2E 會話的會話密鑰 K_S、封裝給設備、加解密內容。
K_S 存 `~/.macchiato/e2e.json`（0600，在用戶自己的機器上）。**某 hermesSessionId 在 store 里 = 該會話已開 E2E。**
"""

import base64
import json
import os
import threading

import e2e_crypto as ec

E2E_STORE = os.path.expanduser(os.environ.get("MACCHIATO_E2E_STORE", "~/.macchiato/e2e.json"))


class E2EKeyStore:
    def __init__(self, path: str = E2E_STORE):
        self._path = path
        self._lock = threading.Lock()
        self._keys: dict[str, bytes] = {}  # hermesSessionId -> K_S(32B)
        self._load()

    def _load(self) -> None:
        try:
            with open(self._path) as f:
                d = json.load(f)
            self._keys = {sid: base64.b64decode(k) for sid, k in d.items()}
        except (FileNotFoundError, ValueError, json.JSONDecodeError):
            self._keys = {}

    def _save(self) -> None:
        os.makedirs(os.path.dirname(self._path), exist_ok=True)
        tmp = self._path + ".tmp"
        with open(tmp, "w") as f:
            json.dump({sid: base64.b64encode(k).decode("ascii") for sid, k in self._keys.items()}, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self._path)  # 原子替換

    # ── 狀態 ──────────────────────────────────────────────────────────────
    def is_e2e(self, sid: str) -> bool:
        return sid in self._keys

    def get_or_create_key(self, sid: str) -> bytes:
        """返回該會話 K_S；首次（開啟 E2E）即生成並持久化。"""
        with self._lock:
            if sid not in self._keys:
                self._keys[sid] = ec.new_session_key()
                self._save()
            return self._keys[sid]

    def remove(self, sid: str) -> None:
        """關閉 E2E：刪該會話 K_S（會話回明文路徑；server 側密封包由 server 清）。無則 no-op。"""
        with self._lock:
            if sid in self._keys:
                del self._keys[sid]
                self._save()

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
        return ec.encrypt(self.get_or_create_key(sid), json.dumps(obj, ensure_ascii=False))

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
