import json
import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    PlainTextResponse,
    RedirectResponse,
    Response,
)
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

import auth
import db
import editor
import events
import live
import models  # noqa: F401 — модели должны быть импортированы до db.init_db()
from security import STRICT_PATHS, SecurityMiddleware

STATIC_DIR = Path(__file__).parent / "static"
SITE_URL = "https://codevibehub.org"
log = logging.getLogger("codevibehub")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Лендинг должен открываться даже без БД — поэтому ошибку только логируем.
    try:
        await db.init_db()
        await events.seed_events()
    except Exception:
        log.exception("Database init failed")
    yield
    await db.engine.dispose()


app = FastAPI(title="CodeVibeHub", docs_url=None, redoc_url=None, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.include_router(live.router)  # WebSocket /ws/live — живой слой лендинга
app.include_router(auth.router)  # /login, /auth/*: вход через Google (для всех посетителей)
app.include_router(editor.router)  # /my/events, /events/new, /events/<slug>/edit — до events.router, иначе /events/new съест {slug}
app.include_router(events.router)  # /events/ — афиша и страницы мероприятий (events/*.json)


if auth.configured():
    _https = auth.base_url().startswith("https://")
    app.add_middleware(
        SessionMiddleware,
        secret_key=os.environ["SESSION_SECRET"],
        session_cookie="__Host-session" if _https else "session",  # __Host-: только Secure, без Domain, Path=/
        https_only=_https,
        same_site="lax",
        max_age=24 * 3600,  # сутки: вход через Google быстрый, а права организатора дороже удобства
    )
app.add_middleware(SecurityMiddleware)  # добавлен последним = самый внешний: заголовки и лимит тела на всех ответах


@app.middleware("http")
async def redirect_www(request: Request, call_next):
    host = request.headers.get("host", "")
    if host == "www.codevibehub.org":  # только свой домен: иначе Host: www.evil.com дал бы открытый редирект
        url = request.url.replace(scheme="https", netloc=host.removeprefix("www."))
        return RedirectResponse(str(url), status_code=301)
    return await call_next(request)


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/robots.txt", include_in_schema=False)
def robots():
    return PlainTextResponse(f"User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /login\nDisallow: /my/\nDisallow: /events/new\nDisallow: /events/*/edit\nDisallow: /ws/\nDisallow: /events/*/calendar\n\nSitemap: {SITE_URL}/sitemap.xml\n")


async def events_sitemap_urls() -> list[str]:
    try:
        return await events.sitemap_urls()
    except Exception:  # БД недоступна — sitemap всё равно отдаём, без мероприятий
        log.exception("Sitemap: events unavailable")
        return []


@app.get("/sitemap.xml", include_in_schema=False)
async def sitemap():
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"  <url><loc>{SITE_URL}/</loc></url>\n"
        + "".join(f"  <url><loc>{url}</loc></url>\n" for url in await events_sitemap_urls())
        + "</urlset>\n"
    )
    return Response(xml, media_type="application/xml")


# Google Analytics: ID счётчика из GA_MEASUREMENT_ID (G-XXXXXXX). Без него скрипт пустой — нет ни GA, ни баннера.
# Сам код и баннер согласия — static/analytics.js; здесь подставляем ID и пути, где GA не грузим (строгий CSP).
GA_ID = os.environ.get("GA_MEASUREMENT_ID", "").strip()
_GA_JS = (
    (STATIC_DIR / "analytics.js").read_text(encoding="utf-8")
    .replace("__GA_ID__", json.dumps(GA_ID)).replace("__SKIP__", json.dumps(STRICT_PATHS.pattern))
    if re.fullmatch(r"G-[A-Z0-9]{4,16}", GA_ID) else ""
)


@app.get("/analytics.js", include_in_schema=False)
def analytics():
    return Response(_GA_JS, media_type="text/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/healthz", include_in_schema=False)
async def healthz():
    return {"status": "ok", "db": "ok" if await db.ping() else "unavailable"}


# TODO(form): заглушка. Реализация регистрации на Google Meet делается отдельно.
# Контракт для фронта: POST /api/register, JSON-тело, ответ JSON.
# Сессия БД: `session: AsyncSession = Depends(db.get_session)`, модели — от db.Base.
@app.post("/api/register")
def register():
    return JSONResponse({"detail": "Registration is not implemented yet"}, status_code=501)
