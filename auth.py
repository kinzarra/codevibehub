"""Вход через Google (для всех посетителей) и права на создание мероприятий.

Любой человек с подтверждённым Google-аккаунтом может войти: ему доступны отметки «это я» и лайки на страницах
мероприятий. Создавать и править мероприятия могут только email из ADMIN_EMAILS (перечень через запятую). Позже,
когда создавать смогут все вошедшие, менять нужно только can_create() и can_edit(): у каждого мероприятия уже
есть owner_email.
Переменные: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET, PUBLIC_BASE_URL (https://codevibehub.org;
локально http://localhost:8000), ADMIN_EMAILS. Без первых четырёх вход отключён (/login отвечает 404).
"""
import hmac
import os
import secrets
import time
from datetime import datetime, timezone
from functools import lru_cache
from typing import Annotated

from authlib.integrations.starlette_client import OAuth, OAuthError
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import select

import db
import notify
from models import Event, User
from web import env

REQUIRED = ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET", "PUBLIC_BASE_URL")
CALENDAR_SCOPE = "openid email https://www.googleapis.com/auth/calendar.readonly"
router = APIRouter(include_in_schema=False)

# Токены доступа к Google Calendar живут только в памяти сервера (воркер один) и не попадают в cookie браузера.
_calendar_tokens: dict[str, tuple[str, float]] = {}


def calendar_token(user: dict) -> str | None:
    token, exp = _calendar_tokens.get(user["id"], (None, 0))
    return token if token and exp > time.time() + 30 else None


def forget_calendar_token(user: dict) -> None:
    _calendar_tokens.pop(user["id"], None)


def configured() -> bool:
    # короткий SESSION_SECRET подбирается перебором, а им подписана сессия: с ним вход не включаем
    return all(os.environ.get(k) for k in REQUIRED) and len(os.environ["SESSION_SECRET"]) >= 32


def base_url() -> str:
    return os.environ["PUBLIC_BASE_URL"].rstrip("/")


def norm_email(email: str | None) -> str:
    """Один и тот же Google-аккаунт может быть записан по-разному: у gmail.com точки и «+метка» не важны.
    Сравниваем только нормализованные адреса (для других доменов только регистр: правила алиасов у них свои)."""
    email = (email or "").strip().lower()
    local, _, domain = email.partition("@")
    if domain in ("gmail.com", "googlemail.com"):
        local, domain = local.split("+", 1)[0].replace(".", ""), "gmail.com"
    return f"{local}@{domain}" if domain else email


def admin_emails() -> set[str]:
    return {norm_email(e) for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}


# ---------- права (единственное место, которое поменяется, когда создавать смогут все) ----------
# Роли: администратор (ADMIN_EMAILS) · владелец (создал мероприятие, пока он администратор) · соавтор (добавлен владельцем).

def is_admin(email: str) -> bool:
    return norm_email(email) in admin_emails()


def can_create(email: str) -> bool:
    return is_admin(email)  # сейчас: только ADMIN_EMAILS


def is_owner(email: str, event: Event) -> bool:
    return can_create(email) and event.owner_email is not None and norm_email(event.owner_email) == norm_email(email)


def is_coauthor(email: str, event: Event) -> bool:
    mail = norm_email(email)
    return any(norm_email(c.get("email")) == mail for c in (event.coauthors or []))


def can_edit(email: str, event: Event) -> bool:
    """Править содержимое и смотреть отметки: администратор, владелец, соавтор."""
    return is_admin(email) or is_owner(email, event) or is_coauthor(email, event)


def can_delete(email: str, event: Event) -> bool:
    """Удалять мероприятие и менять соавторов: только администратор и владелец. Соавтор — нет."""
    return is_admin(email) or is_owner(email, event)


# ---------- сессия ----------

def session_user(request: Request) -> dict | None:
    """Вошедший пользователь или None. Работает и когда вход не настроен (сессии тогда нет вообще)."""
    user = (request.scope.get("session") or {}).get("user")
    return user if isinstance(user, dict) and user.get("id") and user.get("email") else None  # старый формат сессии = не вошёл


def require_login(request: Request) -> dict:
    if not configured():
        raise HTTPException(404)
    user = session_user(request)
    if not user:
        raise HTTPException(303, headers={"Location": "/login?next=" + request.url.path})
    return user


def require_creator(request: Request) -> dict:
    user = require_login(request)
    if not can_create(user["email"]):  # права перечитываем на каждый запрос: убрали из списка — доступ пропал сразу
        raise HTTPException(303, headers={"Location": "/no-access"})
    return user


LoginDep = Annotated[dict, Depends(require_login)]
CreatorDep = Annotated[dict, Depends(require_creator)]


def csrf_token(request: Request) -> str:
    return request.session.setdefault("csrf", secrets.token_urlsafe(24))


def csrf_ok(request: Request, sent: str) -> bool:
    return bool(sent) and hmac.compare_digest(sent, request.session.get("csrf", ""))


async def check_csrf(request: Request):
    """Возвращает уже прочитанную форму: тело запроса читается один раз."""
    form = await request.form()
    if not csrf_ok(request, str(form.get("csrf", ""))):
        raise HTTPException(403, "Форма устарела. Обновите страницу и повторите.")
    return form


def page_ctx(request: Request) -> dict:
    """Что нужно шапке любой страницы: кто вошёл, csrf (только вошедшим) и можно ли создавать мероприятия."""
    user = session_user(request)
    return {"user": user, "csrf": csrf_token(request) if user else "",
            "can_create": bool(user and can_create(user["email"])), "login_enabled": configured(), "path": request.url.path}


def render(request: Request, name: str, **ctx) -> HTMLResponse:
    return HTMLResponse(env.get_template(name).render(**page_ctx(request), **ctx), headers={"Cache-Control": "no-store"})


def _safe_next(path: str | None) -> str:
    return path if path and path.startswith("/") and not path.startswith("//") and "\\" not in path else "/events/"


# ---------- Google ----------

@lru_cache
def _google():
    oauth = OAuth()
    return oauth.register(
        name="google",
        client_id=os.environ["GOOGLE_CLIENT_ID"],
        client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )


@router.get("/login", response_class=HTMLResponse)
async def login(request: Request):
    if not configured():
        raise HTTPException(404)
    return render(request, "login.html", denied=request.query_params.get("denied"),
                  next=_safe_next(request.query_params.get("next")))


@router.get("/no-access", response_class=HTMLResponse)
async def no_access(request: Request):
    return render(request, "no_access.html")


@router.get("/auth/google")
async def auth_google(request: Request):
    if not configured():
        raise HTTPException(404)
    request.session["next"] = _safe_next(request.query_params.get("next"))
    request.session["oauth_purpose"] = "login"
    return await _google().authorize_redirect(request, f"{base_url()}/auth/callback")


@router.get("/auth/calendar")
async def auth_calendar(request: Request, user: CreatorDep):
    """Отдельное согласие на чтение календаря: только организаторам и только когда нажали «Подтянуть дату»."""
    request.session["oauth_purpose"] = "calendar"
    return await _google().authorize_redirect(
        request, f"{base_url()}/auth/callback", scope=CALENDAR_SCOPE, login_hint=user["email"])


_POPUP = ('<!doctype html><meta charset="utf-8"><title>Google</title><body style="font:16px system-ui;padding:32px">'
          '{msg}<script>if(window.opener){{window.opener.postMessage({{type:"{kind}"}},location.origin);window.close()}}'
          '</script>')


async def _upsert_user(email: str, name: str) -> User:
    async with db.SessionLocal() as session:
        user = await session.scalar(select(User).where(User.email == email))
        is_new = user is None
        if is_new:
            user = User(email=email, name=name)
            session.add(user)
        else:
            user.name = name or user.name
            user.last_login_at = datetime.now(timezone.utc)
        await session.commit()
        if is_new:
            notify.send(f"👤 Новый пользователь: {notify.esc(name)} ({notify.esc(email)})")
        return user


@router.get("/auth/callback")
async def auth_callback(request: Request):
    if not configured():
        raise HTTPException(404)
    purpose = request.session.pop("oauth_purpose", "login")
    try:
        token = await _google().authorize_access_token(request)
    except OAuthError:
        if purpose == "calendar":
            return HTMLResponse(_POPUP.format(msg="Доступ к календарю не выдан. Окно можно закрыть.", kind="gcal-fail"))
        return RedirectResponse("/login?denied=oauth", status_code=303)
    info = token.get("userinfo") or {}
    email = (info.get("email") or "").lower()
    verified = bool(info.get("email_verified")) and bool(email)

    if purpose == "calendar":
        me = (session_user(request) or {}).get("email")
        if not (verified and can_create(email) and email == me):
            return HTMLResponse(_POPUP.format(msg="Вы выбрали другой Google-аккаунт. Окно можно закрыть.", kind="gcal-fail"))
        _calendar_tokens[session_user(request)["id"]] = (token["access_token"], float(token.get("expires_at") or time.time() + 3000))
        return HTMLResponse(_POPUP.format(msg="Готово, окно можно закрыть.", kind="gcal-ok"))

    nxt = _safe_next(request.session.get("next"))
    request.session.clear()  # новая сессия после входа
    if not verified:
        return RedirectResponse("/login?denied=unverified", status_code=303)
    user = await _upsert_user(email, info.get("name") or email.split("@")[0])
    request.session["user"] = {"id": str(user.id), "email": email, "name": user.name}
    request.session["csrf"] = secrets.token_urlsafe(24)
    return RedirectResponse(nxt, status_code=303)


@router.post("/logout")
async def logout(request: Request, user: LoginDep):
    form = await request.form()
    if not csrf_ok(request, str(form.get("csrf", ""))):
        raise HTTPException(403, "Форма устарела. Обновите страницу и повторите.")
    forget_calendar_token(user)
    request.session.clear()
    return RedirectResponse(_safe_next(str(form.get("next", ""))), status_code=303)
