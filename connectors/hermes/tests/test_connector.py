"""connector 回歸測試 —— 純函數 + 健壯性（附件 / GC / 鏡像 nack）。

Hermes 相關（compat / extract_media）的用 skipUnless 守衛，無 Hermes 也能跑前半。
"""

import importlib.util
import os
import sys
import tempfile
import time
import unittest
from collections import deque

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import connector  # noqa: E402

HAS_HERMES = (
    importlib.util.find_spec("gateway") is not None
    and importlib.util.find_spec("hermes_state") is not None
)


class _NoE2E:
    """非 E2E 樁：所有會話都不是 E2E（讓 dispatch 走明文路徑）。"""

    def is_e2e(self, sid):
        return False


class ConnectorPureTest(unittest.TestCase):
    def test_sanitize_filename(self):
        self.assertEqual(connector._sanitize_filename("/a/b c.png"), "b_c.png")
        self.assertEqual(connector._sanitize_filename(""), "attachment")
        self.assertEqual(connector._sanitize_filename("../../etc/passwd"), "passwd")

    def test_read_media_file(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "x.png")
        with open(p, "wb") as f:
            f.write(b"\x89PNG" + b"0" * 20)
        pl = connector._read_media_file(p)
        self.assertEqual(pl["kind"], "image")
        self.assertEqual(pl["name"], "x.png")
        self.assertEqual(pl["mime"], "image/png")
        self.assertTrue(pl["data_b64"])
        # 超過上限 → None
        big = os.path.join(d, "big.bin")
        with open(big, "wb") as f:
            f.write(b"0" * (int(connector.MEDIA_MAX) + 1))
        self.assertIsNone(connector._read_media_file(big))
        # 不存在 → None
        self.assertIsNone(connector._read_media_file(os.path.join(d, "nope")))

    def test_gc_attachments(self):
        d = tempfile.mkdtemp()
        orig = (connector.ATTACH_DIR, connector.ATTACH_TTL_S)
        connector.ATTACH_DIR, connector.ATTACH_TTL_S = d, 1
        try:
            sub = os.path.join(d, "a")
            os.makedirs(sub)
            old = os.path.join(sub, "old.png")
            with open(old, "w") as f:
                f.write("x")
            os.utime(old, (time.time() - 100, time.time() - 100))
            new = os.path.join(sub, "new.png")
            with open(new, "w") as f:
                f.write("y")
            self.assertEqual(connector._gc_attachments(), 1)
            self.assertFalse(os.path.exists(old))
            self.assertTrue(os.path.exists(new))
        finally:
            connector.ATTACH_DIR, connector.ATTACH_TTL_S = orig

    def test_materialize_attachment_via_file_url(self):
        d = tempfile.mkdtemp()
        src = os.path.join(d, "src.png")
        with open(src, "wb") as f:
            f.write(b"\x89PNG" + b"0" * 10)
        orig = connector.ATTACH_DIR
        connector.ATTACH_DIR = os.path.join(d, "att")
        try:
            ref = {"id": "x1", "kind": "image", "name": "hi.png",
                   "mime": "image/png", "url": "file://" + src}
            path = connector._materialize_attachment(ref)
            self.assertTrue(os.path.exists(path))
            self.assertEqual(os.path.basename(path), "hi.png")
        finally:
            connector.ATTACH_DIR = orig

    def _voice_dispatch(self, transcribe_result):
        """跑一次帶 audio 附件的 prompt.submit dispatch，返回 (sent_msgs, submitted)。STT 用樁。"""
        import asyncio
        import json

        class FakeGw:
            def __init__(self):
                self.submitted = []

            async def submit_prompt(self, sid, text):
                self.submitted.append((sid, text))
                return {"status": "streaming"}

        c = connector.Connector.__new__(connector.Connector)
        c.gw = FakeGw()
        c.agent_link_id = "al1"
        c._fwd = {"s1": "real1"}  # _ensure_session 直接命中、不碰 gateway
        c._rev = {}
        sent = []

        async def fake_send(msg):
            sent.append(msg)

        c._send = fake_send
        orig = connector._transcribe_attachment
        connector._transcribe_attachment = lambda ref: transcribe_result
        try:
            raw = json.dumps({
                "t": "tui", "sessionId": "s1",
                "frame": {"jsonrpc": "2.0", "method": "prompt.submit", "params": {
                    "session_id": "s1", "text": "",
                    "attachments": [{"id": "a1", "kind": "audio", "name": "v.wav",
                                     "mime": "audio/wav", "url": "file:///x"}],
                }},
            })
            asyncio.run(c._on_server_msg(raw))
        finally:
            connector._transcribe_attachment = orig
        return sent, c.gw.submitted

    def test_voice_dispatch_transcribed(self):
        # 轉錄成功 → 回填 voice_transcript（帶文字）+ 用轉錄文字提交 agent。
        sent, submitted = self._voice_dispatch({"text": "把端口改成 8080"})
        vt = [m for m in sent if m.get("t") == "voice_transcript"]
        self.assertEqual(len(vt), 1)
        self.assertEqual(vt[0]["attachmentId"], "a1")
        self.assertEqual(vt[0]["sessionId"], "s1")
        self.assertEqual(vt[0]["text"], "把端口改成 8080")
        self.assertNotIn("error", vt[0])
        self.assertEqual(submitted, [("real1", "把端口改成 8080")])

    def test_voice_dispatch_empty_skips_agent(self):
        # 轉錄為空（STT 不可用）→ 回填帶 error，但**不**提交 agent（server 已落兜底）。
        sent, submitted = self._voice_dispatch({"text": "", "error": "stt_unavailable: x"})
        vt = [m for m in sent if m.get("t") == "voice_transcript"]
        self.assertEqual(len(vt), 1)
        self.assertEqual(vt[0]["text"], "")
        self.assertEqual(vt[0]["error"], "stt_unavailable: x")
        self.assertEqual(submitted, [])

    def test_mirror_nack_rewind(self):
        c = connector.Connector.__new__(connector.Connector)
        c._mirror_st = {"baseline": 100, "sessions": {"s1": 150, "s2": 200}}
        c._mirror_rewind = deque([(5, {"s1": 120}), (6, {"s2": 180})])
        c._last_error = None
        c._save_mirror_state = lambda st: None
        c._mirror_handle_nack(5)
        self.assertEqual(c._mirror_st["sessions"]["s1"], 120)  # 回退
        self.assertEqual(c._mirror_st["sessions"]["s2"], 200)  # 不動
        self.assertEqual(c._last_error, "mirror_nack: batch 5")
        c._mirror_handle_nack(999)  # 未知批 → no-op
        self.assertEqual(c._mirror_st["sessions"]["s1"], 120)

    def test_advance_mirror_driven(self):
        import asyncio
        import sqlite3
        import backfill
        d = tempfile.mkdtemp()
        db = os.path.join(d, "state.db")
        con = sqlite3.connect(db)
        con.executescript(
            "CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, title TEXT,"
            " started_at REAL, message_count INTEGER, archived INTEGER);"
            "CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT,"
            " content TEXT, reasoning TEXT, tool_calls TEXT, tool_call_id TEXT,"
            " timestamp REAL, finish_reason TEXT);"
        )
        con.execute("INSERT INTO sessions VALUES('d1','discord','x',1,2,0)")
        con.executemany(
            "INSERT INTO messages(id,session_id,role,content,timestamp) VALUES(?,?,?,?,?)",
            [(10, "d1", "user", "a", 1), (11, "d1", "assistant", "b", 2)],
        )
        con.commit()
        con.close()
        orig = backfill.STATE_DB
        backfill.STATE_DB = db
        try:
            c = connector.Connector.__new__(connector.Connector)
            c._mirror_st = {"baseline": 0, "sessions": {}}
            c._save_mirror_state = lambda st: None
            asyncio.run(c._advance_mirror_driven(["d1"]))
            self.assertEqual(c._mirror_st["sessions"]["d1"], 11)  # 推到 d1 max（修 A：防重啟重發）
        finally:
            backfill.STATE_DB = orig

    def test_mirror_loop_smoke_no_crash(self):
        # 跑一輪 _mirror_loop（normal + cron 兩條分支都有真批次），斷言發出 mirror_append、不崩。
        # 正是 2026-06-24 那個 NameError（錯位代碼在 send 後崩、任務靜默退出）會被此測抓到的場景。
        import asyncio
        import sqlite3
        import backfill
        d = tempfile.mkdtemp()
        db = os.path.join(d, "state.db")
        con = sqlite3.connect(db)
        con.executescript(
            "CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, title TEXT,"
            " started_at REAL, message_count INTEGER, archived INTEGER);"
            "CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT,"
            " content TEXT, reasoning TEXT, tool_calls TEXT, tool_call_id TEXT,"
            " timestamp REAL, finish_reason TEXT);"
        )
        con.execute("INSERT INTO sessions VALUES('d1','discord','chat',1,1,0)")
        con.execute("INSERT INTO sessions VALUES('c1','cron','每日快報 · Jun 24 07:01',1,2,0)")
        con.executemany(
            "INSERT INTO messages(id,session_id,role,content,timestamp,finish_reason) VALUES(?,?,?,?,?,?)",
            [(10, "c1", "user", "[cron]", 1, None),
             (11, "c1", "assistant", "報告內容", 1, "stop"),
             (12, "d1", "user", "你好", 1, None)],
        )
        con.commit()
        con.close()
        orig_db, orig_poll = backfill.STATE_DB, connector.MIRROR_POLL_S
        backfill.STATE_DB = db
        connector.MIRROR_POLL_S = 0.02  # 加速輪詢
        sent = []
        try:
            c = connector.Connector.__new__(connector.Connector)
            c.ws = object()  # 非 None
            c.agent_link_id = "al1"
            c._rev = {}
            c._fwd = {}
            c._mirror_st = None
            c._e2e = _NoE2E()
            c._mirror_batch_id = 0
            c._mirror_rewind = deque(maxlen=64)
            c._mirror_last_run = None
            c._load_mirror_state = lambda: {"baseline": 9, "sessions": {}}  # baseline 9 → 10-12 是新的
            c._save_mirror_state = lambda st: None

            async def fake_send(msg):
                sent.append(msg)

            c._send = fake_send

            async def run_briefly():
                task = asyncio.create_task(c._mirror_loop())
                await asyncio.sleep(0.2)
                task.cancel()
                try:
                    await task  # 若循環崩了（任務帶異常退出），這裡會 raise → 測試失敗
                except asyncio.CancelledError:
                    pass

            asyncio.run(run_briefly())
        finally:
            backfill.STATE_DB, connector.MIRROR_POLL_S = orig_db, orig_poll
        appends = [m for m in sent if m.get("t") == "mirror_append"]
        self.assertTrue(appends, "未發出 mirror_append（可能崩在 send 之前）")
        hsids = {s["hermesSessionId"] for m in appends for s in m["sessions"]}
        self.assertIn("d1", hsids)  # normal 分支
        self.assertIn("cron:每日快報", hsids)  # cron 分支

    def test_mirror_e2e_selfdriven_uses_persistent_sid(self):
        # §19 回歸：自驅 E2E 會話（state.db id = Hermes 運行時 real ≠ server 持久化 sid）。
        # K_S 按持久化 sid 鍵控；mirror loop 必須把 real→sid 映射回去判 E2E + 加密 + 標識，
        # 否則 is_e2e(real)=False → 被當「非 E2E 自驅」跳過 → 消息既不 live（被抑制）也不 mirror →
        # 永久丟失。本測在修復前會紅（漏發），修復後綠（用持久化 sid 加密投遞）。
        import asyncio
        import sqlite3
        import backfill
        from e2e_keys import E2EKeyStore
        d = tempfile.mkdtemp()
        db = os.path.join(d, "state.db")
        con = sqlite3.connect(db)
        con.executescript(
            "CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, title TEXT,"
            " started_at REAL, message_count INTEGER, archived INTEGER);"
            "CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT,"
            " content TEXT, reasoning TEXT, tool_calls TEXT, tool_call_id TEXT,"
            " timestamp REAL, finish_reason TEXT);"
        )
        # state.db 會話 id = 運行時 "real1"（session.create 分配）；server 持久化 sid = "srv1"
        con.execute("INSERT INTO sessions VALUES('real1','discord','My chat',1,2,0)")
        con.executemany(
            "INSERT INTO messages(id,session_id,role,content,timestamp,finish_reason) VALUES(?,?,?,?,?,?)",
            [(20, "real1", "user", "秘密消息", 1, None),
             (21, "real1", "assistant", "回覆", 1, "stop")],
        )
        con.commit()
        con.close()

        store = E2EKeyStore(path=os.path.join(d, "e2e.json"))
        store.get_or_create_key("srv1")  # iOS 開 E2E 時連接器生成的 K_S（按 server 持久化 sid）

        orig_db, orig_poll = backfill.STATE_DB, connector.MIRROR_POLL_S
        backfill.STATE_DB = db
        connector.MIRROR_POLL_S = 0.02
        sent = []
        try:
            c = connector.Connector.__new__(connector.Connector)
            c.ws = object()
            c.agent_link_id = "al1"
            c._rev = {"real1": "srv1"}  # 運行時 id → 持久化 sid（自驅映射）
            c._fwd = {"srv1": "real1"}
            c._mirror_st = None
            c._e2e = store
            c._mirror_batch_id = 0
            c._mirror_rewind = deque(maxlen=64)
            c._mirror_last_run = None
            c._load_mirror_state = lambda: {"baseline": 19, "sessions": {}}  # 20-21 是新的
            c._save_mirror_state = lambda st: None

            async def fake_send(msg):
                sent.append(msg)

            c._send = fake_send

            async def run_briefly():
                task = asyncio.create_task(c._mirror_loop())
                await asyncio.sleep(0.2)
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

            asyncio.run(run_briefly())
        finally:
            backfill.STATE_DB, connector.MIRROR_POLL_S = orig_db, orig_poll

        entries = [s for m in sent if m.get("t") == "mirror_append" for s in m["sessions"]]
        self.assertTrue(entries, "E2E 自驅會話被漏發（回歸 bug：用 real 判 is_e2e → 跳過）")
        # 用 server 持久化 sid 標識（不是運行時 real1），否則 server 落成重複新會話
        self.assertEqual({e["hermesSessionId"] for e in entries}, {"srv1"})
        entry = entries[0]
        self.assertTrue(entry.get("e2e"))
        msg0 = entry["messages"][0]
        self.assertNotIn("text", msg0)  # 不洩明文
        self.assertIn("enc", msg0)
        # 密文用「持久化 sid 的 K_S」可解回原文（= iOS 持有的同一把）
        self.assertEqual(store.decrypt_content("srv1", msg0["enc"])["text"], "秘密消息")
        # 標題也加密、可解
        self.assertNotEqual(entry["title"], "My chat")
        self.assertEqual(store.decrypt_text("srv1", entry["title"]), "My chat")

    def test_gateway_restart_keeps_e2e_watermark(self):
        # §19 回歸：gateway 重啟推進「自驅會話」水位線防 live 重發——但 E2E 自驅會話靠 mirror 投遞，
        # 絕不能推進（會丟重啟前未鏡像的消息）。斷言 E2E 會話被排除出 driven。
        import asyncio
        captured = {}

        class _E2E:
            def is_e2e(self, sid):
                return sid == "srvE"  # 持久化 sid「srvE」是 E2E

        c = connector.Connector.__new__(connector.Connector)
        c._e2e = _E2E()
        c._rev = {"realE": "srvE", "realD": "srvD"}  # 一個 E2E、一個非 E2E 自驅
        c._fwd = {"srvE": "realE", "srvD": "realD"}
        c._pending_interrupt = set()

        async def fake_advance(sids):
            captured["sids"] = list(sids)

        c._advance_mirror_driven = fake_advance
        # _on_gateway_restart 起一個 create_task → 需在事件循環內跑
        async def run():
            c._on_gateway_restart()
            await asyncio.sleep(0)  # 讓 create_task 跑一輪
        asyncio.run(run())

        driven = set(captured.get("sids", []))
        self.assertNotIn("realE", driven)  # E2E 運行時 id 不推進
        self.assertNotIn("srvE", driven)   # E2E 持久化 id 不推進
        self.assertIn("realD", driven)     # 非 E2E 自驅照常推進（防 live 重發）

    def test_pending_interrupt_compensation(self):
        # 中斷早於會話映射到達 → 記為 pending、不丟；隨後 prompt.submit 建映射後一起取消。
        import asyncio
        import json

        class MockGW:
            def __init__(self):
                self.interrupts = []
                self.submits = []

            async def request(self, method, params):
                if method == "session.resume":
                    raise connector.GatewayError(404, "session not found")  # 逼走 create 路徑
                return {}

            async def create_session(self, **kw):
                return {"session_id": "real-s1"}

            async def submit_prompt(self, sid, text):
                self.submits.append((sid, text))
                return {"status": "streaming"}

            async def interrupt(self, sid):
                self.interrupts.append(sid)
                return {}

        c = connector.Connector.__new__(connector.Connector)
        c.gw = MockGW()
        c._fwd = {}
        c._rev = {}
        c._pending_interrupt = set()
        c._e2e = _NoE2E()

        def tui(method, **params):
            return json.dumps({"t": "tui", "sessionId": "s1",
                               "frame": {"method": method, "params": {"session_id": "s1", **params}}})

        # ① interrupt 早到（s1 未映射）→ pending、尚未取消
        asyncio.run(c._on_server_msg(tui("session.interrupt")))
        self.assertIn("s1", c._pending_interrupt)
        self.assertEqual(c.gw.interrupts, [])

        # ② prompt.submit → 建映射 + 提交 + 補償取消
        asyncio.run(c._on_server_msg(tui("prompt.submit", text="hi")))
        self.assertEqual(c.gw.submits, [("real-s1", "hi")])
        self.assertEqual(c.gw.interrupts, ["real-s1"])      # 早到中斷被補償施加
        self.assertNotIn("s1", c._pending_interrupt)        # 已清

        # ③ 已映射時 interrupt 仍走常規路徑（直接施加）
        asyncio.run(c._on_server_msg(tui("session.interrupt")))
        self.assertEqual(c.gw.interrupts, ["real-s1", "real-s1"])

    def test_steer_on_busy_session(self):
        # 回合進行中（submit_prompt 返回 4009 busy）→ 連接器改 steer 注入跟進消息，不丟（方案 D）。
        import asyncio
        import json

        class MockGW:
            def __init__(self):
                self.submits = []
                self.steers = []

            async def request(self, method, params):
                if method == "session.resume":
                    raise connector.GatewayError(404, "not found")
                return {}

            async def create_session(self, **kw):
                return {"session_id": "real-s1"}

            async def submit_prompt(self, sid, text):
                self.submits.append((sid, text))
                raise connector.GatewayError(4009, "session busy")  # 模擬回合進行中

            async def steer(self, sid, text):
                self.steers.append((sid, text))
                return {"status": "queued"}

            async def interrupt(self, sid):
                return {}

        c = connector.Connector.__new__(connector.Connector)
        c.gw = MockGW()
        c._fwd = {}
        c._rev = {}
        c._pending_interrupt = set()
        c._e2e = _NoE2E()
        msg = json.dumps({"t": "tui", "sessionId": "s1",
                          "frame": {"method": "prompt.submit",
                                    "params": {"session_id": "s1", "text": "跟進消息"}}})
        asyncio.run(c._on_server_msg(msg))
        self.assertEqual(c.gw.submits, [("real-s1", "跟進消息")])  # 先試常規 submit
        self.assertEqual(c.gw.steers, [("real-s1", "跟進消息")])   # busy → 改 steer 注入，不丟

    def test_e2e_prompt_decrypted(self):
        # §19：E2E 會話的 prompt.submit 帶密文 → 連接器解密後再提交 agent。
        import asyncio
        import json
        import e2e_keys
        store = e2e_keys.E2EKeyStore(path=os.path.join(tempfile.mkdtemp(), "e2e.json"))
        store.get_or_create_key("s1")  # 開啟 s1 的 E2E
        cipher = store.encrypt_text("s1", "祕密提問")  # 模擬 iOS 加密的 prompt

        class MockGW:
            def __init__(self):
                self.submits = []

            async def request(self, method, params):
                if method == "session.resume":
                    return {"session_id": "s1"}  # resume 返回 s1
                return {}

            async def submit_prompt(self, sid, text):
                self.submits.append((sid, text))
                return {}

            async def interrupt(self, sid):
                return {}

            async def steer(self, sid, text):
                return {}

        c = connector.Connector.__new__(connector.Connector)
        c.gw = MockGW()
        c._fwd = {}
        c._rev = {}
        c._pending_interrupt = set()
        c._e2e = store
        msg = json.dumps({"t": "tui", "sessionId": "s1",
                          "frame": {"method": "prompt.submit",
                                    "params": {"session_id": "s1", "text": cipher}}})
        asyncio.run(c._on_server_msg(msg))
        self.assertEqual(c.gw.submits, [("s1", "祕密提問")])  # agent 收到的是解密後明文，非密文

    def test_mirror_entry_e2e_encrypts(self):
        # §19 方案 A：_mirror_entry 對 E2E 會話加密標題 + 內容、打 e2e；非 E2E 明文直出。
        import e2e_keys
        store = e2e_keys.E2EKeyStore(path=os.path.join(tempfile.mkdtemp(), "e2e.json"))
        store.get_or_create_key("s1")  # s1 開 E2E；s2 沒開
        c = connector.Connector.__new__(connector.Connector)
        c._e2e = store
        msgs = [{"role": "agent", "text": "祕密回覆", "reasoning": "想了想", "tools": None, "createdAt": 1}]
        # 非 E2E：明文直出
        plain = c._mirror_entry("s2", "標題", "discord", False, msgs, False)
        self.assertNotIn("e2e", plain)
        self.assertEqual(plain["title"], "標題")
        self.assertEqual(plain["messages"][0]["text"], "祕密回覆")
        # E2E：加密
        enc = c._mirror_entry("s1", "標題", "discord", False, msgs, True)
        self.assertTrue(enc["e2e"])
        m0 = enc["messages"][0]
        self.assertNotIn("text", m0)                                      # 內容不留明文
        self.assertEqual(m0["role"], "agent")                            # role 是明文元數據
        self.assertEqual(store.decrypt_text("s1", enc["title"]), "標題")   # 標題可解密還原
        body = store.decrypt_content("s1", m0["enc"])
        self.assertEqual(body["text"], "祕密回覆")
        self.assertEqual(body["reasoning"], "想了想")

    def test_mirror_title_only_update(self):
        # Hermes 回合後才取名、之後無新消息 → 連接器發「純標題更新」（空消息），不被遺漏。
        import asyncio
        import sqlite3
        import backfill
        d = tempfile.mkdtemp()
        db = os.path.join(d, "state.db")
        con = sqlite3.connect(db)
        con.executescript(
            "CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, title TEXT,"
            " started_at REAL, message_count INTEGER, archived INTEGER);"
            "CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT,"
            " content TEXT, reasoning TEXT, tool_calls TEXT, tool_call_id TEXT,"
            " timestamp REAL, finish_reason TEXT);"
        )
        con.execute("INSERT INTO sessions VALUES('d1','discord','Hermes 取的真標題',1,1,0)")
        con.execute("INSERT INTO messages(id,session_id,role,content,timestamp) VALUES(10,'d1','user','hi',1)")
        con.commit()
        con.close()
        orig_db, orig_poll = backfill.STATE_DB, connector.MIRROR_POLL_S
        backfill.STATE_DB = db
        connector.MIRROR_POLL_S = 0.02
        sent = []
        try:
            c = connector.Connector.__new__(connector.Connector)
            c.ws = object()
            c.agent_link_id = "al1"
            c._rev = {}
            c._fwd = {}
            c._mirror_st = None
            c._e2e = _NoE2E()
            c._mirror_batch_id = 0
            c._mirror_rewind = deque(maxlen=64)
            c._mirror_last_run = None
            # d1 已鏡像過（在 wm）：水位線=10（無新消息）；titles 無記錄 → 模擬升級前積壓的卡住會話
            c._load_mirror_state = lambda: {"baseline": 9, "sessions": {"d1": 10}, "titles": {}}
            c._save_mirror_state = lambda st: None

            async def fake_send(msg):
                sent.append(msg)

            c._send = fake_send

            async def run_briefly():
                task = asyncio.create_task(c._mirror_loop())
                await asyncio.sleep(0.15)
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

            asyncio.run(run_briefly())
        finally:
            backfill.STATE_DB, connector.MIRROR_POLL_S = orig_db, orig_poll
        d1 = [s for m in sent if m.get("t") == "mirror_append"
              for s in m["sessions"] if s["hermesSessionId"] == "d1"]
        self.assertTrue(d1, "純標題更新未發出")
        self.assertEqual(d1[0]["title"], "Hermes 取的真標題")  # 發了真標題
        self.assertEqual(d1[0]["messages"], [])                # 純標題更新：空消息

    def test_mirror_skips_fwd_driven_session(self):
        # 續聊 Discord 會話：resume 返回**運行時 id**（進 _rev 鍵），消息落**持久化 id**（進 _fwd 鍵）。
        # 鏡像必須對「在 _fwd 但不在 _rev」的持久化會話也跳過，否則 = 直接路徑 + 鏡像雙投 → 重複。
        import asyncio
        import sqlite3
        import backfill
        d = tempfile.mkdtemp()
        db = os.path.join(d, "state.db")
        con = sqlite3.connect(db)
        con.executescript(
            "CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, title TEXT,"
            " started_at REAL, message_count INTEGER, archived INTEGER);"
            "CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT,"
            " content TEXT, reasoning TEXT, tool_calls TEXT, tool_call_id TEXT,"
            " timestamp REAL, finish_reason TEXT);"
        )
        con.execute("INSERT INTO sessions VALUES('d1','discord','chat',1,1,0)")  # 持久化會話
        con.execute("INSERT INTO messages(id,session_id,role,content,timestamp) VALUES(12,'d1','user','hi',1)")
        con.commit()
        con.close()
        orig_db, orig_poll = backfill.STATE_DB, connector.MIRROR_POLL_S
        backfill.STATE_DB = db
        connector.MIRROR_POLL_S = 0.02
        sent = []
        try:
            c = connector.Connector.__new__(connector.Connector)
            c.ws = object()
            c.agent_link_id = "al1"
            # 模擬續聊：持久化 id d1 是 _fwd 鍵；運行時 id 是 _rev 鍵（resume 返回的、≠ d1）
            c._fwd = {"d1": "runtime-x"}
            c._rev = {"runtime-x": "d1"}
            c._mirror_st = None
            c._e2e = _NoE2E()
            c._mirror_batch_id = 0
            c._mirror_rewind = deque(maxlen=64)
            c._mirror_last_run = None
            c._load_mirror_state = lambda: {"baseline": 9, "sessions": {}, "titles": {}}
            c._save_mirror_state = lambda st: None

            async def fake_send(msg):
                sent.append(msg)

            c._send = fake_send

            async def run_briefly():
                task = asyncio.create_task(c._mirror_loop())
                await asyncio.sleep(0.15)
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

            asyncio.run(run_briefly())
        finally:
            backfill.STATE_DB, connector.MIRROR_POLL_S = orig_db, orig_poll
        d1 = [s for m in sent if m.get("t") == "mirror_append"
              for s in m["sessions"] if s["hermesSessionId"] == "d1"]
        self.assertEqual(d1, [], "續聊會話 d1 在 _fwd 卻被鏡像了 → 重複投遞 bug")


@unittest.skipUnless(HAS_HERMES, "Hermes 未安裝（gateway / hermes_state）")
class HermesDependentTest(unittest.TestCase):
    def test_compat_check_all_pass(self):
        r = connector._check_hermes_compat()
        self.assertIsNotNone(r["hermes_version"])
        for k, v in r["checks"].items():
            self.assertIs(v, True, f"{k}: {v}")

    def test_extract_media_files(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "report.png")
        with open(p, "wb") as f:
            f.write(b"\x89PNG" + b"0" * 30)
        self.assertIn(p, connector._extract_media_files(f"see MEDIA:{p} done"))


if __name__ == "__main__":
    unittest.main()
