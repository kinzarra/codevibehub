"""Защитные заголовки, строгий CSP, лимит тела, доступ только через Cloudflare и лимит частоты запросов.

Схема прода: браузер → Cloudflare → :8080 (HTTP). Порт открыт в интернет, поэтому приложение само отклоняет
запросы не из сетей Cloudflare (кроме /healthz) и берёт IP посетителя только из CF-Connecting-IP —
подделать его, обойдя Cloudflare, нельзя. Uvicorn запускается без --proxy-headers: заголовки разбираем здесь.
"""
import os
import re
import time
from ipaddress import ip_address, ip_network

from starlette.exceptions import HTTPException

MAX_BODY = 16 * 1024 * 1024  # фото до 5 МБ + форма; больше не принимаем

# https://www.cloudflare.com/ips/ — список меняется редко; при изменении обновить здесь.
CLOUDFLARE_NETS = [ip_network(n) for n in (
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
    "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
    "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
    "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
    "2a06:98c0::/29", "2c0f:f248::/32",
)]
OPEN_PATHS = {"/healthz"}  # проверка деплоя ходит напрямую на :8080

# Анонимные записи в БД и вход: не больше RATE_BURST подряд и RATE_PER_SEC в среднем с одного IP.
_LIMITED = re.compile(r"^/(api/|auth/|events/[^/]+/calendar)")
RATE_BURST, RATE_PER_SEC = 30, 0.5
MAX_TRACKED_IPS = 50_000

# Страницы входа и редактирования: на них никогда нет чужих скриптов, поэтому CSP строгий.
STRICT_PATHS = re.compile(r"^/(login|no-access|my/|events/new$|events/[^/]+/(edit|insights)$)")
_STRICT_CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
               "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; "
               "frame-ancestors 'none'; base-uri 'self'; object-src 'none'")
_BASE_CSP = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'"  # публичные страницы: защита от кликджекинга
_HEADERS = [
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"strict-origin-when-cross-origin"),
    (b"x-frame-options", b"DENY"),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=(), payment=()"),
]


def _peer_kind(host: str) -> str:
    """cloudflare | local (свой хост, docker-сеть) | other."""
    try:
        ip = ip_address(host)
    except ValueError:
        return "other"
    if any(ip in net for net in CLOUDFLARE_NETS):
        return "cloudflare"
    return "local" if ip.is_private or ip.is_loopback else "other"


class RateLimiter:
    """Token bucket на IP в памяти: процесс uvicorn один."""

    def __init__(self):
        self.buckets: dict[str, tuple[float, float]] = {}

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        tokens, stamp = self.buckets.get(key, (RATE_BURST, now))
        tokens = min(RATE_BURST, tokens + (now - stamp) * RATE_PER_SEC)
        if len(self.buckets) >= MAX_TRACKED_IPS and key not in self.buckets:
            self._prune(now)
        if tokens < 1:
            self.buckets[key] = (tokens, now)
            return False
        self.buckets[key] = (tokens - 1, now)
        return True

    def _prune(self, now: float) -> None:
        full = RATE_BURST / RATE_PER_SEC  # за это время любой бакет наполняется заново — его можно забыть
        self.buckets = {k: v for k, v in self.buckets.items() if now - v[1] < full}
        if len(self.buckets) >= MAX_TRACKED_IPS:  # флуд с множества IP: память важнее точности
            self.buckets.clear()


class SecurityMiddleware:
    """Чистый ASGI-middleware: не буферизует тело и не ломает WebSocket."""

    def __init__(self, app):
        self.app = app
        self.prod = os.environ.get("PUBLIC_BASE_URL", "").startswith("https://")
        self.limiter = RateLimiter()

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)

        headers = dict(scope["headers"])
        kind = _peer_kind((scope.get("client") or ("", 0))[0])
        if kind == "other" and self.prod and scope["path"] not in OPEN_PATHS:
            return await self._reject(scope, send, 403, "Forbidden")  # прямой заход на :8080 в обход Cloudflare
        if kind != "other":  # заголовкам прокси верим только от самого прокси
            real_ip = headers.get(b"cf-connecting-ip", b"").decode("latin-1").strip()
            if _valid_ip(real_ip):
                scope["client"] = (real_ip, 0)
            if headers.get(b"x-forwarded-proto") == b"https":
                scope["scheme"] = "wss" if scope["type"] == "websocket" else "https"

        if scope["type"] == "websocket":
            return await self.app(scope, receive, send)

        if _LIMITED.match(scope["path"]) and not self.limiter.allow(scope["client"][0] if scope.get("client") else ""):
            return await self._reject(scope, send, 429, "Слишком много запросов, попробуйте через минуту")

        length = headers.get(b"content-length", b"")
        if length.isdigit() and int(length) > MAX_BODY:
            return await self._reject(scope, send, 413, "Слишком большой запрос")
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > MAX_BODY:  # и когда Content-Length не указан (chunked)
                    raise HTTPException(413, "Слишком большой запрос")
            return message

        csp = _STRICT_CSP if STRICT_PATHS.match(scope["path"]) else _BASE_CSP

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                have = {k for k, _ in message["headers"]}
                extra = [*_HEADERS, (b"content-security-policy", csp.encode())]
                if self.prod:
                    extra.append((b"strict-transport-security", b"max-age=31536000"))
                message["headers"] = [*message["headers"], *[h for h in extra if h[0] not in have]]
            await send(message)

        await self.app(scope, limited_receive, send_with_headers)

    @staticmethod
    async def _reject(scope, send, status: int, text: str):
        if scope["type"] == "websocket":
            return await send({"type": "websocket.close", "code": 1008})
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"text/plain; charset=utf-8"), *_HEADERS]})
        await send({"type": "http.response.body", "body": text.encode()})


def _valid_ip(value: str) -> bool:
    try:
        ip_address(value)
        return True
    except ValueError:
        return False
