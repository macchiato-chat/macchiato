"""e2e_keys 回歸測試 —— 持鑰/封裝/內容加解密/持久化。"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import e2e_crypto as ec  # noqa: E402
import e2e_keys  # noqa: E402


class E2EKeyStoreTest(unittest.TestCase):
    def _store(self):
        path = os.path.join(tempfile.mkdtemp(), "e2e.json")
        return e2e_keys.E2EKeyStore(path=path), path

    def test_enable_and_is_e2e(self):
        s, _ = self._store()
        self.assertFalse(s.is_e2e("d1"))
        k = s.get_or_create_key("d1")  # 開啟 E2E
        self.assertEqual(len(k), 32)
        self.assertTrue(s.is_e2e("d1"))
        self.assertEqual(s.get_or_create_key("d1"), k)  # 同會話同一把

    def test_wrap_for_devices_then_unwrap(self):
        s, _ = self._store()
        priv1, pub1 = ec.gen_device_keypair()
        priv2, pub2 = ec.gen_device_keypair()
        wrapped = s.wrap_for_devices("d1", [{"deviceId": "A", "pubKey": pub1},
                                            {"deviceId": "B", "pubKey": pub2}])
        self.assertEqual({w["deviceId"] for w in wrapped}, {"A", "B"})
        k = s.get_or_create_key("d1")
        sealed = {w["deviceId"]: w["sealed"] for w in wrapped}
        self.assertEqual(ec.unwrap_key(sealed["A"], priv1), k)  # 兩台都解出同一把 K_S
        self.assertEqual(ec.unwrap_key(sealed["B"], priv2), k)

    def test_wrap_skips_bad_pubkey(self):
        s, _ = self._store()
        _, pub = ec.gen_device_keypair()
        wrapped = s.wrap_for_devices("d1", [{"deviceId": "A", "pubKey": pub},
                                            {"deviceId": "B", "pubKey": "!!notbase64x25519"}])
        self.assertEqual([w["deviceId"] for w in wrapped], ["A"])  # 壞公鑰跳過

    def test_content_roundtrip(self):
        s, _ = self._store()
        obj = {"text": "祕密", "reasoning": "想了想", "tools": [{"name": "search"}]}
        blob = s.encrypt_content("d1", obj)
        self.assertEqual(s.decrypt_content("d1", blob), obj)

    def test_decrypt_without_key_raises(self):
        s, _ = self._store()
        with self.assertRaises(KeyError):
            s.decrypt_content("nope", "x")

    def test_text_roundtrip(self):
        s, _ = self._store()
        s.get_or_create_key("d1")
        blob = s.encrypt_text("d1", "純文本祕密")
        self.assertEqual(s.decrypt_text("d1", blob), "純文本祕密")

    def test_persistence(self):
        s, path = self._store()
        k = s.get_or_create_key("d1")
        # 重新從同一文件加載 → 密鑰還在
        s2 = e2e_keys.E2EKeyStore(path=path)
        self.assertTrue(s2.is_e2e("d1"))
        self.assertEqual(s2.get_or_create_key("d1"), k)
        self.assertEqual(oct(os.stat(path).st_mode)[-3:], "600")  # 0600 權限


if __name__ == "__main__":
    unittest.main()
