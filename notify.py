"""Уведомления организаторам в Telegram: календарь, «Я пойду», новые пользователи, лайки и «это я».

Переменные: TELEGRAM_BOT_TOKEN (от @BotFather), TELEGRAM_CHAT_ID (личка, группа или канал, где бот — участник).
Без них уведомления выключены. Отправка — в фоне: запрос посетителя не ждёт Telegram и не падает из-за него.
"""
import asyncio
import html
import logging
import os
import time
from collections import deque

import httpx

log = logging.getLogger("codevibehub.notify")
MAX_PER_MINUTE = 20  # лимит Telegram для группы; накрутку счётчиков в чат не пересылаем
SITE_URL = "https://codevibehub.org"

_sent: deque[float] = deque()
_tasks: set[asyncio.Task] = set()  # держим ссылки, иначе задачу может собрать GC до отправки
_dropped = 0


def configured() -> bool:
    return bool(os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID"))


def esc(value) -> str:
    return html.escape(str(value or ""), quote=False)


def event_link(ev) -> str:
    return f'<a href="{SITE_URL}/events/{esc(ev.slug)}">{esc(ev.title)}</a>'


def send(text: str) -> None:
    """Ставит сообщение (HTML Telegram, значения — через esc()) в очередь отправки. Никогда не бросает исключений."""
    global _dropped
    if not configured():
        return
    now = time.monotonic()
    while _sent and now - _sent[0] > 60:
        _sent.popleft()
    if len(_sent) >= MAX_PER_MINUTE:
        _dropped += 1
        return
    if _dropped:
        text += f"\n\n<i>…и ещё {_dropped} уведомл. пропущено (больше {MAX_PER_MINUTE} в минуту)</i>"
        _dropped = 0
    _sent.append(now)
    try:
        task = asyncio.get_running_loop().create_task(_post(text))
    except RuntimeError:
        return
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def _post(text: str) -> None:
    url = f"https://api.telegram.org/bot{os.environ['TELEGRAM_BOT_TOKEN']}/sendMessage"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(url, json={"chat_id": os.environ["TELEGRAM_CHAT_ID"], "text": text,
                                             "parse_mode": "HTML", "disable_web_page_preview": True})
        if r.status_code != 200:
            log.warning("telegram: %s %s", r.status_code, r.text[:200])
    except Exception:  # сеть или Telegram недоступны: уведомление теряем, сайт работает
        log.warning("telegram: send failed", exc_info=True)
