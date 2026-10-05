import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import db

STATIC_DIR = Path(__file__).parent / "static"
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


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/healthz", include_in_schema=False)
async def healthz():
    return {"status": "ok", "db": "ok" if await db.ping() else "unavailable"}


# TODO(form): заглушка. Реализация регистрации на Google Meet делается отдельно.
# Контракт для фронта: POST /api/register, JSON-тело, ответ JSON.
# Сессия БД: `session: AsyncSession = Depends(db.get_session)`, модели — от db.Base.
@app.post("/api/register")
def register():
    return JSONResponse({"detail": "Registration is not implemented yet"}, status_code=501)
