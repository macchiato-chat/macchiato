"""§19 per-session E2E 密碼原語（見 docs/e2e.md）。

跨平台對齊 iOS CryptoKit：**X25519 ECDH + HKDF-SHA256 + AES-256-GCM**，不依賴 libsodium
特有的 sealed box，CryptoKit 的 Curve25519.KeyAgreement / HKDF<SHA256> / AES.GCM 可逐位實現。

格式（base64 字符串為協議邊界；內部 bytes）：
  封裝 wrap_key →  sealed = b64( e_pub[32] ‖ nonce[12] ‖ AES-256-GCM_ct(含 16B tag) )
  內容 encrypt  →  blob   = b64( nonce[12] ‖ AES-256-GCM_ct )
  HKDF: info=b"macchiato-e2e-wrap-v1"、salt = e_pub‖recipient_pub、length=32。
  AES-GCM aad=None（K_S 每會話一把，天然防跨會話重放）。
"""

import base64
import os

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

WRAP_INFO = b"macchiato-e2e-wrap-v1"
_RAW = serialization.Encoding.Raw


def _b64e(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def _b64d(s: str) -> bytes:
    return base64.b64decode(s)


def _pub_raw(pub: X25519PublicKey) -> bytes:
    return pub.public_bytes(_RAW, serialization.PublicFormat.Raw)


def _priv_raw(priv: X25519PrivateKey) -> bytes:
    return priv.private_bytes(_RAW, serialization.PrivateFormat.Raw, serialization.NoEncryption())


def _hkdf(shared: bytes, salt: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=WRAP_INFO).derive(shared)


# ── 會話密鑰 ──────────────────────────────────────────────────────────────
def new_session_key() -> bytes:
    """生成一把 AES-256 會話密鑰 K_S（32 bytes）。"""
    return AESGCM.generate_key(bit_length=256)


# ── 封裝 K_S 給某設備（連接器側做）────────────────────────────────────────
def wrap_key(k_s: bytes, recipient_pub_b64: str) -> str:
    """把 K_S 用收件設備的 X25519 公鑰封裝（ECIES）。server 中轉但解不開。"""
    P = _b64d(recipient_pub_b64)
    pub = X25519PublicKey.from_public_bytes(P)
    e_priv = X25519PrivateKey.generate()
    e_pub = _pub_raw(e_priv.public_key())
    wk = _hkdf(e_priv.exchange(pub), e_pub + P)
    nonce = os.urandom(12)
    ct = AESGCM(wk).encrypt(nonce, k_s, None)
    return _b64e(e_pub + nonce + ct)


def unwrap_key(sealed_b64: str, recipient_priv_raw: bytes) -> bytes:
    """設備側用自己 X25519 私鑰解出 K_S（連接器不做，這裡供測試/參考）。"""
    blob = _b64d(sealed_b64)
    e_pub, nonce, ct = blob[:32], blob[32:44], blob[44:]
    priv = X25519PrivateKey.from_private_bytes(recipient_priv_raw)
    P = _pub_raw(priv.public_key())
    wk = _hkdf(priv.exchange(X25519PublicKey.from_public_bytes(e_pub)), e_pub + P)
    return AESGCM(wk).decrypt(nonce, ct, None)


# ── 內容塊加解密（用 K_S）─────────────────────────────────────────────────
def encrypt(k_s: bytes, plaintext: str) -> str:
    nonce = os.urandom(12)
    ct = AESGCM(k_s).encrypt(nonce, plaintext.encode("utf-8"), None)
    return _b64e(nonce + ct)


def decrypt(k_s: bytes, blob_b64: str) -> str:
    blob = _b64d(blob_b64)
    nonce, ct = blob[:12], blob[12:]
    return AESGCM(k_s).decrypt(nonce, ct, None).decode("utf-8")


# ── 設備密鑰對（測試用；真設備在 iOS Secure Enclave 生成）─────────────────
def gen_device_keypair() -> tuple[bytes, str]:
    """返回 (private_raw_bytes, public_b64)。"""
    priv = X25519PrivateKey.generate()
    return _priv_raw(priv), _b64e(_pub_raw(priv.public_key()))
