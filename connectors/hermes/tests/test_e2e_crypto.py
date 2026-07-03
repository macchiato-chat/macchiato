"""e2e_crypto 回歸測試 —— 封裝/解封、內容加解密往返、錯鑰失敗、多設備。

跨平台向量（iOS 對齊用）：本測只驗 Python 自洽往返；iOS 端應另用「連接器產出的固定密文」
做解密向量測試，確認三端格式逐位一致。
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import e2e_crypto as ec  # noqa: E402


class E2ECryptoTest(unittest.TestCase):
    def test_wrap_unwrap_roundtrip(self):
        k_s = ec.new_session_key()
        self.assertEqual(len(k_s), 32)
        priv, pub = ec.gen_device_keypair()
        sealed = ec.wrap_key(k_s, pub)
        self.assertEqual(ec.unwrap_key(sealed, priv), k_s)  # 設備解出同一把 K_S

    def test_content_roundtrip(self):
        k_s = ec.new_session_key()
        msg = "敏感對話內容 🔒 with emoji + 多語"
        blob = ec.encrypt(k_s, msg)
        self.assertNotIn(msg, ec._b64d(blob).decode("latin-1"))  # 密文不含明文
        self.assertEqual(ec.decrypt(k_s, blob), msg)

    def test_wrong_key_fails(self):
        k_s = ec.new_session_key()
        blob = ec.encrypt(k_s, "secret")
        from cryptography.exceptions import InvalidTag
        with self.assertRaises(InvalidTag):
            ec.decrypt(ec.new_session_key(), blob)  # 別的 K_S 解不開

    def test_wrong_device_cannot_unwrap(self):
        k_s = ec.new_session_key()
        _, pub_a = ec.gen_device_keypair()
        priv_b, _ = ec.gen_device_keypair()
        sealed = ec.wrap_key(k_s, pub_a)  # 封給設備 A
        from cryptography.exceptions import InvalidTag
        with self.assertRaises(InvalidTag):
            ec.unwrap_key(sealed, priv_b)  # 設備 B 解不開

    def test_multi_device_same_key(self):
        # 同一把 K_S 封給兩台設備 → 兩台都解出同一把（多設備：iPhone+iPad）
        k_s = ec.new_session_key()
        priv1, pub1 = ec.gen_device_keypair()
        priv2, pub2 = ec.gen_device_keypair()
        self.assertEqual(ec.unwrap_key(ec.wrap_key(k_s, pub1), priv1), k_s)
        self.assertEqual(ec.unwrap_key(ec.wrap_key(k_s, pub2), priv2), k_s)

    def test_nondeterministic_but_decryptable(self):
        # 每次封裝/加密用隨機 ephemeral/nonce → 密文每次不同，但都能解
        k_s = ec.new_session_key()
        priv, pub = ec.gen_device_keypair()
        s1, s2 = ec.wrap_key(k_s, pub), ec.wrap_key(k_s, pub)
        self.assertNotEqual(s1, s2)
        self.assertEqual(ec.unwrap_key(s1, priv), ec.unwrap_key(s2, priv))
        b1, b2 = ec.encrypt(k_s, "x"), ec.encrypt(k_s, "x")
        self.assertNotEqual(b1, b2)
        self.assertEqual(ec.decrypt(k_s, b1), ec.decrypt(k_s, b2))

    def test_format_lengths(self):
        k_s = ec.new_session_key()
        _, pub = ec.gen_device_keypair()
        sealed = ec._b64d(ec.wrap_key(k_s, pub))
        self.assertEqual(len(sealed), 32 + 12 + 32 + 16)  # e_pub + nonce + (K_S 32B 密文 + 16B tag)
        blob = ec._b64d(ec.encrypt(k_s, "ab"))
        self.assertEqual(len(blob), 12 + 2 + 16)  # nonce + 明文 2B + tag


if __name__ == "__main__":
    unittest.main()
