#!/usr/bin/env python3
"""#950（父 #926）`ThreadRegistry` —— 四家連接器共用的「對話 ↔ 執行線程」別名表（Python 版）。

TS 真源在 `packages/connector-core/src/threads/registry.ts`；hermes 連接器是 Python，進不了那個
包，所以這裡是**逐條對齊的移植**（同樣的三個不變式、同樣的 fail-closed、同樣的落盤形狀）。
改任何一邊都要同步改另一邊——四家語義不一致 ＝ 同一個 bug 在某一家復活。

## 為什麼要有它

每家 agent 的**執行產物**都會增殖或輪換：hermes 上下文壓縮換一個 `sessions.id`、codex 子 agent
從父線程 fork 出新 rollout、OpenClaw 會話重置換一份 transcript、CC 的 `--resume` 另起一檔。我們卻
把「一段對話」的身份直接定義成了這個執行產物的 id，於是同一段對話要麼在列表裡長出好幾行
（噪音），要麼被劈成兩條、原來那條靜默停更（**用戶會以為歷史丟了**，更傷）。

hermes 這一家具體的病：`_compression_root()` 每輪都**現算**血緣。父會話那幾行一旦從 state.db
消失（用戶清庫、換 profile、上游裁舊會話），同一條壓縮子會話就會解出另一個根 → 上報身份靜默
輪換 → server 另起一行 + K_S 按舊鍵存着查不到（#807）。登記過的線程一律用**登記時確立**的身份。

## 三個不變式

- **I1**：每條 thread 恰好屬於一個 conversation。
- **I2**：conversation 的**上報身份**（wire identity）在首次確立後**永不輪換**。
- **I3**：歷代 threadId 全部永久保留為別名，只增不刪。

## fail-closed（照抄 openclaw #347）

`history_trusted` 只有兩個來源：快照裡**顯式**寫着 `true`，或調用方在能證明「此刻沒有任何東西
可丟」時顯式 `adopt_history(True)`。缺字段、解析失敗、舊 schema 一律 `False`，而 `False` 時
`aliases_for()` 恆返回空 —— **別名歷史不可信就不得按新身份上報，維持舊身份。**

## 本模塊**不做**什麼

不落盤、不認識 state.db 的任何結構。持久化由連接器把 `to_json()` 塞進既有的 `mirror.json`
（原子寫 + `.bak` 輪替都已經存在，再造一份只會多一處不一致）。
"""

from __future__ import annotations


class ThreadRegistryParseError(Exception):
    """快照非法（調用方應按「空 + 不可信」繼續，絕不可當成「沒有別名」放行）。"""


class ThreadRegistry:
    """conversationId → 歷代 threadId（有序、去重）。構造函數私有，走 `empty()` / `parse()`。"""

    def __init__(self, threads: dict | None = None, trusted: bool = False) -> None:
        self._by_conversation: dict[str, list[str]] = {}
        self._conversation_by_thread: dict[str, str] = {}
        for conversation_id, thread_ids in (threads or {}).items():
            self._by_conversation[conversation_id] = list(thread_ids)
            for t in thread_ids:
                self._conversation_by_thread[t] = conversation_id
        # 只認顯式的 True。缺字段 / 舊 schema / None 一律不可信。
        self._trusted = trusted is True

    # ── 構造 ──────────────────────────────────────────────────────────────
    @staticmethod
    def empty() -> "ThreadRegistry":
        """全新的表：空且**不可信**（還沒人證明過它涵蓋完整歷史）。"""
        return ThreadRegistry()

    @staticmethod
    def parse(raw) -> "ThreadRegistry":
        """嚴格解析持久化快照。形狀不對就拋——調用方應接住後退回 `empty()`（空且不可信），
        **絕不可**把「解析失敗」當成「這個對話沒有別名」，那正是 #347 要防的那一刀。"""
        if raw is None:
            return ThreadRegistry.empty()
        if not isinstance(raw, dict):
            raise ThreadRegistryParseError("thread registry 快照必須是對象")
        threads: dict[str, list[str]] | None = None
        if raw.get("threads") is not None:
            node = raw["threads"]
            if not isinstance(node, dict):
                raise ThreadRegistryParseError("thread registry threads 必須是對象")
            threads = {}
            seen: set[str] = set()
            for conversation_id, value in node.items():
                if not conversation_id or not isinstance(conversation_id, str):
                    raise ThreadRegistryParseError("thread registry 的 conversationId 為空")
                if not isinstance(value, list) or any(
                    not isinstance(v, str) or not v for v in value
                ):
                    raise ThreadRegistryParseError(
                        f"thread registry {conversation_id} 的線程表非法"
                    )
                if len(set(value)) != len(value):
                    raise ThreadRegistryParseError(
                        f"thread registry {conversation_id} 的線程 id 重複"
                    )
                # I1：一條 thread 只能屬於一個 conversation；跨對話重複 ＝ 表已經壞了，
                # 不許靜默取一個。
                for t in value:
                    if t in seen:
                        raise ThreadRegistryParseError(f"thread {t} 同時屬於多個 conversation")
                    seen.add(t)
                threads[conversation_id] = list(value)
        trusted_raw = raw.get("aliasHistoryTrusted")
        if trusted_raw is not None and not isinstance(trusted_raw, bool):
            raise ThreadRegistryParseError("thread registry aliasHistoryTrusted 必須是布爾")
        if trusted_raw is True and threads is None:
            # 聲稱「歷史完整」卻沒有別名表 —— 自相矛盾，按不可信處理。
            raise ThreadRegistryParseError("thread registry 聲稱歷史可信但沒有 threads 字段")
        return ThreadRegistry(threads or {}, trusted_raw is True)

    # ── 查詢 ──────────────────────────────────────────────────────────────
    @property
    def history_trusted(self) -> bool:
        """別名歷史是否涵蓋此表建立以來的完整歷史（見模塊 docstring 的 fail-closed）。"""
        return self._trusted

    def conversation_of(self, thread_id: str):
        """這條線程屬於哪段對話（未登記 → None）。"""
        return self._conversation_by_thread.get(thread_id)

    def wire_identity_of(self, conversation_id: str):
        """該對話**首次確立**的身份（I2）：上報給 server 的 `hermesSessionId`、E2E 的 K_S
        鍵都用它。源系統換了 id 也**映射而不是另建**。"""
        threads = self._by_conversation.get(conversation_id)
        return threads[0] if threads else None

    def current_thread_of(self, conversation_id: str):
        """該對話當前活躍的線程（末位 ＝ 最近一次 record 的）。"""
        threads = self._by_conversation.get(conversation_id)
        return threads[-1] if threads else None

    def threads_of(self, conversation_id: str) -> list:
        """該對話的歷代全部線程（只讀副本）。"""
        return list(self._by_conversation.get(conversation_id, ()))

    def aliases_for(self, thread_id: str) -> list:
        """與 `thread_id` 同屬一段對話的**其它**線程 id，**首次確立的那個排在最前**。

        **歷史不可信時恆為空** —— 這是 fail-closed 那道閘的落點：拿不到別名，調用方就查不到
        舊鍵、也就不會按新身份上報，只能維持舊身份（老行為），而不是落進 #807 那條
        「connector-ahead 永久不可恢復」。
        """
        if not self._trusted:
            return []
        conversation_id = self._conversation_by_thread.get(thread_id)
        if conversation_id is None:
            return []
        return [t for t in self._by_conversation.get(conversation_id, ()) if t != thread_id]

    def identity_alias_resolver(self):
        """交給 `E2EKeyStore.set_identity_aliases()` 的解析器：身份換成對話身份之後，存量會話的
        K_S 還壓在舊鍵（threadId）下，直查必然 miss。

        只在 `history_trusted` 時給候選；否則空列表 ＝ keystore 行為與今天逐字節一致。
        """
        return self.aliases_for

    # ── 變更 ──────────────────────────────────────────────────────────────
    def adopt_history(self, can_adopt: bool) -> bool:
        """聲明別名歷史完整。**只有調用方能判斷**這一點：它要能證明此刻沒有任何東西可丟
        （判據＝零受保護 E2E 會話 ∧ 已套用權威 server 快照）。
        `can_adopt` 為假時不做任何事——一旦是 False 就必須持久 False，不許自升。"""
        if not can_adopt or self._trusted:
            return False
        self._trusted = True
        return True

    def record(self, conversation_id: str, thread_id: str) -> bool:
        """記一條「這條線程屬於這段對話」。返回是否發生變化（調用方據此決定要不要落盤）。

        **必須在讀/發這條新線程的內容之前先持久化**：崩在中間會讓別名丟失一環，而
        `history_trusted` 是持久 True 的——丟了就再也發現不了。
        """
        if not conversation_id or not thread_id:
            raise ValueError("ThreadRegistry.record: 空的 conversationId/threadId")
        owner = self._conversation_by_thread.get(thread_id)
        if owner is not None and owner != conversation_id:
            # I1 被打破 ＝ 上游給的血緣自相矛盾。響亮失敗，不要靜默改歸屬：那會把一條會話的
            # 全部消息搬到另一條下面。
            raise ValueError(
                f"ThreadRegistry: thread {thread_id} 已屬於 conversation {owner}，"
                f"拒絕改掛到 {conversation_id}"
            )
        threads = self._by_conversation.get(conversation_id)
        if threads is None:
            self._by_conversation[conversation_id] = [thread_id]
            self._conversation_by_thread[thread_id] = conversation_id
            return True
        if thread_id in threads:
            return False
        threads.append(thread_id)
        self._conversation_by_thread[thread_id] = conversation_id
        return True

    # ── 落盤 ──────────────────────────────────────────────────────────────
    def to_json(self) -> dict:
        """落盤形狀。`aliasHistoryTrusted` 一律顯式寫出，缺字段等於不可信。"""
        return {
            "threads": {c: list(t) for c, t in self._by_conversation.items()},
            "aliasHistoryTrusted": self._trusted,
        }


def merge_snapshot(disk, memory: dict) -> dict:
    """落盤投影 ＝ 盤上已有的 ∪ 內存真源（**只增不刪**，I3）。

    為什麼不是直接覆蓋：連接器有 15 分鐘試用期自動回退，**磁盤 schema 一個字節都不能動、也不能
    讓任何一條路徑把既有別名寫沒**——回退後的舊版本讀不到別名 ＝ identity 不可信 ＝ E2E 全凍結。
    快照解析失敗時（`ThreadRegistry.parse` 拋）內存那份是空且不可信的，這裡仍把盤上的原樣留住：
    數據照留、歷史降級成持久不可信，而不是靜默丟掉別人的別名。
    """
    out: dict[str, list[str]] = {}
    disk_threads = disk.get("threads") if isinstance(disk, dict) else None
    for source in (disk_threads, memory.get("threads")):
        if not isinstance(source, dict):
            continue
        for conversation_id, threads in source.items():
            if not isinstance(conversation_id, str) or not isinstance(threads, list):
                continue
            merged = out.setdefault(conversation_id, [])
            for t in threads:
                if isinstance(t, str) and t and t not in merged:
                    merged.append(t)
    return {"threads": out, "aliasHistoryTrusted": memory.get("aliasHistoryTrusted") is True}
