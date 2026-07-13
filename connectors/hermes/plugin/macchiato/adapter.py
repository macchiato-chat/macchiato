"""Macchiato 平台適配器 —— 把 Macchiato 註冊成 Hermes 的一個渠道（§17）。

薄殼設計：本適配器**不維持長連接**，每次 ``send`` 通過本地 unix socket 把
``{chatId, text}`` 交給同機的 macchiato 連接器（它有已認證的 Link B），由連接器經
Link B 把 ``connector_push`` 投遞給 Macchiato server，再推送給用戶。

**出站專用**：入站（你在 Macchiato 說話 → agent）已由連接器 spawn 的 tui_gateway 承擔，
不在此重做。註冊本平台的意義是：給 Macchiato 一個 Hermes 渠道身份（channel id），使
agent 能**主動 / 延遲投遞**回 Macchiato（提醒 / cron / Libra 主動找你 / 系統通知）——
否則 Macchiato 走 tui_gateway 無 channel id、agent 發不回來。

純 stdlib（asyncio unix socket），無第三方依賴。
"""

import asyncio
import json
import logging
import os
from typing import Any, Dict, Optional

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, SendResult

logger = logging.getLogger(__name__)

# 連接器監聽的本地 unix socket（連接器側 asyncio.start_unix_server）。
PUSH_SOCK = os.path.expanduser(os.environ.get("MACCHIATO_PUSH_SOCK", "~/.macchiato/push.sock"))
SEND_TIMEOUT_S = 10.0

# 裸 `deliver=macchiato` / send_message 的 home 目標 chat_id 來源：Hermes 用 **env var**
# （經 PlatformEntry.cron_deliver_env_var 指向），而非 config 的 home_channel。server 把
# "home" 映射到用戶的「主動消息」收件箱。設默認、允許真 env var 覆蓋。
HOME_CHAT_ENV = "MACCHIATO_HOME_CHAT_ID"
os.environ.setdefault(HOME_CHAT_ENV, "home")


def check_macchiato_requirements() -> bool:
    """依賴自檢：純 stdlib，恆 True。"""
    return True


def _is_connected(config: PlatformConfig) -> bool:
    """連接器 socket 在 = 可投遞（給 `hermes platforms` / cron 探活用）。"""
    return os.path.exists(PUSH_SOCK)


async def _push_to_connector(
    chat_id: str,
    content: str,
    reply_to: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """通過 unix socket 把一條投遞請求交給 macchiato 連接器，返回連接器的 ack。"""
    req: Dict[str, Any] = {"chatId": chat_id, "text": content}
    if reply_to:
        req["replyTo"] = reply_to
    if metadata:
        req["metadata"] = metadata
    payload = (json.dumps(req, ensure_ascii=False) + "\n").encode("utf-8")

    reader, writer = await asyncio.wait_for(
        asyncio.open_unix_connection(PUSH_SOCK), timeout=SEND_TIMEOUT_S
    )
    try:
        writer.write(payload)
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout=SEND_TIMEOUT_S)
        return json.loads(line.decode("utf-8")) if line else {}
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass


class MacchiatoAdapter(BasePlatformAdapter):
    """把主動消息經本地連接器投遞到 Macchiato。"""

    MAX_MESSAGE_LENGTH = 8000  # Macchiato 無硬限制；給個寬鬆上限

    def __init__(self, config: PlatformConfig):
        # Platform("macchiato") 觸發枚舉 _missing_ 動態建成員（無需改 Hermes 源碼）。
        super().__init__(config, Platform("macchiato"))

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        # 薄殼：不維持長連接，投遞時即連 socket。標記為已連接以便 gateway 路由投遞。
        # is_reconnect：Hermes 0.18.0 起 gateway 一律以 connect(is_reconnect=...) 呼叫
        # （gateway/run.py），缺這個 kwarg 會 TypeError → 平台永遠卡 retrying。帶預設值
        # 向後相容 0.17；薄殼無長連接，重連與首連無差別，值本身用不上。
        self._mark_connected()
        logger.info("[macchiato] adapter ready (push via %s)", PUSH_SOCK)
        return True

    async def disconnect(self) -> None:
        self._mark_disconnected()

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if len(content) > self.MAX_MESSAGE_LENGTH:
            content = content[: self.MAX_MESSAGE_LENGTH - 1] + "…"
        try:
            ack = await _push_to_connector(chat_id, content, reply_to, metadata)
        except (FileNotFoundError, ConnectionRefusedError) as exc:
            # 連接器沒在跑 / socket 不在 → 瞬時錯，可重試。
            return SendResult(success=False, error=f"connector unreachable: {exc}", retryable=True)
        except asyncio.TimeoutError:
            return SendResult(success=False, error="connector timeout", retryable=True)
        except Exception as exc:
            logger.error("[macchiato] send failed: %r", exc)
            return SendResult(success=False, error=str(exc))

        if ack.get("ok"):
            return SendResult(success=True, message_id=ack.get("messageId"))
        return SendResult(
            success=False,
            error=ack.get("error") or "push rejected",
            retryable=bool(ack.get("retryable")),
        )

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id or "Macchiato", "type": "channel"}


def _build_adapter(config: PlatformConfig) -> MacchiatoAdapter:
    return MacchiatoAdapter(config)


async def _standalone_send(
    pconfig,
    chat_id: str,
    message: str,
    *,
    thread_id: Optional[str] = None,
    media_files: Optional[list] = None,
    force_document: bool = False,
) -> Dict[str, Any]:
    """無 live adapter 時（cron 獨立進程）的投遞路徑 —— 同樣交給連接器。

    被 ``tools/send_message_tool`` 在 gateway runner 不在本進程時調用（cron 常見）。
    """
    try:
        ack = await _push_to_connector(
            chat_id, message, metadata={"thread_id": thread_id} if thread_id else None
        )
    except Exception as exc:
        return {"error": str(exc)}
    if ack.get("ok"):
        return {"success": True, "message_id": ack.get("messageId")}
    return {"error": ack.get("error") or "push rejected"}


def register(ctx) -> None:
    """插件入口 —— Hermes 插件系統發現本目錄後調用。"""
    ctx.register_platform(
        name="macchiato",
        label="Macchiato",
        adapter_factory=_build_adapter,
        check_fn=check_macchiato_requirements,
        is_connected=_is_connected,
        # cron 獨立進程（無 live adapter）也能投遞 —— 否則 deliver=macchiato 會「No live adapter」。
        standalone_sender_fn=_standalone_send,
        # 使 macchiato 成為合法 cron 投遞目標 + 解析裸 `deliver=macchiato` 的 home chat_id
        # （否則 _is_known_delivery_platform=False → 「no delivery target resolved」）。
        cron_deliver_env_var=HOME_CHAT_ENV,
        max_message_length=MacchiatoAdapter.MAX_MESSAGE_LENGTH,
        emoji="☕",
        allow_update_command=True,
        platform_hint="You are reaching the user via Macchiato.",
    )
