"""backfill 回歸測試 —— 對著合成 state.db（臨時庫），不碰真實 ~/.hermes/state.db。

跑：cd services/hermes-connector && <hermes-venv>/bin/python -m unittest discover -s tests -v
"""

import asyncio
import os
import sqlite3
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import backfill  # noqa: E402


def _build_db(path: str) -> None:
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE sessions(
          id TEXT PRIMARY KEY, source TEXT, title TEXT, started_at REAL,
          message_count INTEGER, archived INTEGER);
        CREATE TABLE messages(
          id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
          reasoning TEXT, tool_calls TEXT, tool_call_id TEXT, timestamp REAL, finish_reason TEXT);
        """
    )
    M = ("INSERT INTO messages(id,session_id,role,content,reasoning,tool_calls,"
         "tool_call_id,timestamp,finish_reason) VALUES(?,?,?,?,?,?,?,?,?)")
    # s1：discord 對話（sender-tag + 工具調用 + 最終文字）
    con.execute("INSERT INTO sessions VALUES('s1','discord','Aaron 分析',1000,4,0)")
    con.executemany(M, [
        (1, "s1", "user", "[briansun] 你好", None, None, None, 1000, None),
        (2, "s1", "assistant", "我幫你查", "想一下",
         '[{"id":"t1","name":"search","input":{"q":"x"}}]', None, 1001, "tool_calls"),
        (3, "s1", "tool", '{"output":"結果數據"}', None, None, "t1", 1002, None),
        (4, "s1", "assistant", "查到了：xyz", None, None, None, 1003, "stop"),
    ])
    # s2：用戶向 cron
    con.execute("INSERT INTO sessions VALUES('s2','cron','每日加密市場快報 · Jun 23 07:01',2000,2,0)")
    con.executemany(M, [
        (5, "s2", "user", "[cron prompt]", None, None, None, 2000, None),
        (6, "s2", "assistant", "加密快報：BTC 漲了", None, None, None, 2001, "stop"),
    ])
    # s3：系統 cron（應排除）
    con.execute("INSERT INTO sessions VALUES('s3','cron','hermes-auto-update · Jun 23 03:00',3000,2,0)")
    con.executemany(M, [
        (7, "s3", "user", "x", None, None, None, 3000, None),
        (8, "s3", "assistant", "[SILENT]", None, None, None, 3001, "stop"),
    ])
    con.commit()
    con.close()


class BackfillTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.db = os.path.join(cls.tmp, "state.db")
        _build_db(cls.db)
        cls._orig = backfill.STATE_DB
        backfill.STATE_DB = cls.db

    @classmethod
    def tearDownClass(cls):
        backfill.STATE_DB = cls._orig

    # ---- 純函數 ----
    def test_strip_sender_tag(self):
        self.assertEqual(backfill._strip_sender_tag("[briansun] 你好"), "你好")
        voice = "[The user sent a voice message~ ...]"  # 含空格 → 不剝
        self.assertEqual(backfill._strip_sender_tag(voice), voice)
        self.assertEqual(backfill._strip_sender_tag("沒標籤"), "沒標籤")

    def test_keepable(self):
        self.assertTrue(backfill.keepable("discord", "Aaron 分析"))
        self.assertFalse(backfill.keepable("cron", "x"))
        self.assertFalse(backfill.keepable("scheduled", "x"))
        self.assertFalse(backfill.keepable("discord", "running as a scheduled cron"))

    def test_parse_tool_calls(self):
        raw = '[{"id":"t1","name":"search","input":{"q":"x"}}]'
        out = backfill._parse_tool_calls(raw, {"t1": '{"output":"ok"}'})
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["callId"], "t1")
        self.assertEqual(out[0]["name"], "search")
        self.assertEqual(out[0]["state"], "ok")
        self.assertEqual(backfill._parse_tool_calls(raw, {"t1": '{"error":"boom"}'})[0]["state"], "error")
        self.assertEqual(backfill._parse_tool_calls("不是 json", {}), [])
        self.assertEqual(backfill._parse_tool_calls(None, {}), [])

    def test_cron_routing(self):
        self.assertEqual(backfill.cron_feed_target("cron", "每日加密市場快報 · Jun 23"), "每日加密市場快報")
        self.assertIsNone(backfill.cron_feed_target("cron", "hermes-auto-update · Jun 23"))
        self.assertIsNone(backfill.cron_feed_target("discord", "x"))
        self.assertEqual(backfill._job_name("A · Jun 23 07:01"), "A")

    # ---- DB-backed ----
    def test_read_messages_folds_tools_and_strips(self):
        con = backfill._connect()
        try:
            msgs = backfill._read_messages(con, "s1")
        finally:
            con.close()
        self.assertEqual([m["role"] for m in msgs], ["user", "agent", "agent"])
        self.assertEqual(msgs[0]["text"], "你好")  # [briansun] 已剝
        self.assertEqual(msgs[1]["reasoning"], "想一下")
        self.assertEqual(len(msgs[1]["tools"]), 1)
        self.assertEqual(msgs[1]["tools"][0]["output"], '{"output":"結果數據"}')
        self.assertEqual(msgs[2]["text"], "查到了：xyz")

    def test_cron_feed_sessions(self):
        con = backfill._connect()
        try:
            feeds = {f["hermesSessionId"]: f for f in backfill._cron_feed_sessions(con)}
        finally:
            con.close()
        self.assertIn("cron:每日加密市場快報", feeds)
        self.assertNotIn("cron:hermes-auto-update", feeds)  # 系統 cron 排除
        f = feeds["cron:每日加密市場快報"]
        self.assertEqual(f["source"], "cron_feed")
        self.assertEqual([m["text"] for m in f["messages"]], ["加密快報：BTC 漲了"])
        self.assertNotIn("tools", f["messages"][0])  # 純文字

    def test_enumerate_includes_discord_and_cronfeed_not_raw_cron(self):
        hsids = {s["hermesSessionId"] for s in asyncio.run(backfill.enumerate_importable())}
        self.assertIn("s1", hsids)  # discord
        self.assertNotIn("s2", hsids)  # 原始 cron 不作普通導入
        self.assertIn("cron:每日加密市場快報", hsids)  # 但作為 feed

    def test_tail_session_increment_settle_idempotent(self):
        msgs, wm = asyncio.run(backfill.tail_session("s1", 0))
        self.assertEqual([m["role"] for m in msgs], ["user", "agent", "agent"])
        self.assertEqual(wm, 4)  # cover 含工具結果行 id3 + 末條 id4
        self.assertEqual(asyncio.run(backfill.tail_session("s1", wm))[0], [])  # 冪等

    def _set_id4(self, finish, ts):
        con = sqlite3.connect(self.db)
        con.execute("UPDATE messages SET finish_reason=?, timestamp=? WHERE id=4", (finish, ts))
        con.commit()
        con.close()

    def test_tail_holds_recent_inflight(self):
        # 末條仍在調工具 + 時間戳=現在 → 應被 hold
        self._set_id4("tool_calls", time.time())
        try:
            msgs, wm = asyncio.run(backfill.tail_session("s1", 0))
            self.assertEqual([m["role"] for m in msgs], ["user", "agent"])  # 末條被 hold
            self.assertLess(wm, 4)
        finally:
            self._set_id4("stop", 1003)

    def test_tail_force_settles_stale_inflight(self):
        # 末條 tool_calls 但時間戳很舊（>STALE_TURN_S）→ 強制結算（修 C，防卡死）
        self._set_id4("tool_calls", 100)
        try:
            msgs, wm = asyncio.run(backfill.tail_session("s1", 0))
            self.assertEqual(len(msgs), 3)  # 末條也結算了
            self.assertEqual(wm, 4)
        finally:
            self._set_id4("stop", 1003)

    def test_current_max_id(self):
        self.assertEqual(asyncio.run(backfill.current_max_id()), 8)


if __name__ == "__main__":
    unittest.main()
