import logging
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

import db
import live

STATIC_DIR = Path(__file__).parent / "static"
SITE_URL = "https://codevibehub.org"
log = logging.getLogger("codevibehub")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Лендинг должен открываться даже без БД — поэтому ошибку только логируем.
    try:
        await db.init_db()
    except Exception:
        log.exception("Database init failed")
    yield
    await db.engine.dispose()


app = FastAPI(title="CodeVibeHub", docs_url=None, redoc_url=None, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.include_router(live.router)  # WebSocket /ws/live — живой слой лендинга


@app.middleware("http")
async def redirect_www(request: Request, call_next):
    host = request.headers.get("host", "")
    if host.startswith("www."):
        url = request.url.replace(scheme="https", netloc=host.removeprefix("www."))
        return RedirectResponse(str(url), status_code=301)
    return await call_next(request)


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/robots.txt", include_in_schema=False)
def robots():
    return PlainTextResponse(f"User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /ws/\n\nSitemap: {SITE_URL}/sitemap.xml\n")


@app.get("/sitemap.xml", include_in_schema=False)
def sitemap():
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"  <url><loc>{SITE_URL}/</loc></url>\n"
        "</urlset>\n"
    )
    return Response(xml, media_type="application/xml")


@app.get("/healthz", include_in_schema=False)
async def healthz():
    return {"status": "ok", "db": "ok" if await db.ping() else "unavailable"}


# TODO(form): заглушка. Реализация регистрации на Google Meet делается отдельно.
# Контракт для фронта: POST /api/register, JSON-тело, ответ JSON.
# Сессия БД: `session: AsyncSession = Depends(db.get_session)`, модели — от db.Base.
@app.post("/api/register")
def register():
    return JSONResponse({"detail": "Registration is not implemented yet"}, status_code=501)
