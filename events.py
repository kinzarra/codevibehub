"""Мероприятия клуба: /events/ (афиша) и /events/{slug} (страница мероприятия).

Источник правды — таблица events в Postgres (models.py); создаётся и правится через editor.py. Файлы events/*.json —
только «посев» для самой первой пустой БД.
Кнопка «Я пойду» и счётчики «Добавить в календарь» пишут в event_rsvps / event_calendar_clicks.
"""
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

import db
import notify
import storage
from auth import can_delete, can_edit, csrf_ok, page_ctx, session_user
from models import (
    Event,
    EventAgendaLike,
    EventAudiencePick,
    EventCalendarClick,
    EventRsvp,
)
from web import env

BASE_DIR = Path(__file__).parent
SEED_DIR = BASE_DIR / "events"
SITE_URL = "https://codevibehub.org"
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
VID_COOKIE = "cv_vid"

MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"]
WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
SEED_FIELDS = {c.name for c in Event.__table__.columns} - {"id", "created_at", "updated_at"}

SessionDep = Annotated[AsyncSession, Depends(db.get_session)]

router = APIRouter()


# ---------- посев из events/*.json ----------

async def seed_events() -> None:
    """Первый запуск на пустой БД: заводим мероприятия из events/*.json. Дальше ими управляет админка."""
    async with db.SessionLocal() as session:
        if await session.scalar(select(func.count()).select_from(Event)):
            return
        for path in sorted(SEED_DIR.glob("*.json")):
            if not SLUG_RE.match(path.stem):
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
            data["slug"] = path.stem
            data["starts_at"] = datetime.fromisoformat(data.pop("start"))
            data["ends_at"] = datetime.fromisoformat(data.pop("end"))
            session.add(Event(**{k: v for k, v in data.items() if k in SEED_FIELDS}))
        await session.commit()


# ---------- представление ----------

def _utc_stamp(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def speaker_photo_url(ev: Event, sp: dict) -> str | None:
    if not (sp.get("photo_key") and storage.configured()):
        return None
    return f"/media/events/{ev.slug}/speaker/{sp['id']}?v={int(ev.updated_at.timestamp())}"


def _view(ev: Event, going_count: int = 0, going: bool = False, votes: dict | None = None) -> dict:
    votes = votes or {}
    tz = ZoneInfo(ev.timezone)
    start, end = ev.starts_at.astimezone(tz), ev.ends_at.astimezone(tz)
    month = MONTHS[start.month - 1]
    return {
        "id": ev.id, "slug": ev.slug, "hashtag": ev.hashtag, "title": ev.title, "subtitle": ev.subtitle,
        "description": ev.description, "tz_label": ev.tz_label, "format": ev.format, "meet_url": ev.meet_url,
        "links": ev.links, "stats": ev.stats,
        "agenda": [{**a, "count": votes.get("ag", {}).get(a["id"], 0), "liked": a["id"] in votes.get("ag_mine", ())} for a in ev.agenda],
        "audience": [{**a, "count": votes.get("aud", {}).get(a["id"], 0), "mine": a["id"] in votes.get("aud_mine", ())} for a in ev.audience],
        "speakers": [{**sp, "photo_url": speaker_photo_url(ev, sp)} for sp in ev.speakers],
        "performers": [{"@type": "Person", "name": sp["name"]} for sp in ev.speakers],
        "start": start.isoformat(), "end": end.isoformat(),
        "start_dt": ev.starts_at, "end_dt": ev.ends_at,
        "url": f"/events/{ev.slug}", "abs_url": f"{SITE_URL}/events/{ev.slug}",
        "date_label": f"{WEEKDAYS[start.weekday()]}, {start.day} {month}",
        "time_label": f"{start:%H:%M}–{end:%H:%M}",
        "short_label": f"{start.day} {month} · {start:%H:%M}",
        "going_count": going_count, "going": going,
    }


def _gcal_url(v: dict) -> str:
    details = f"{v['subtitle']}\n\nСсылка на звонок: {v['meet_url']}\nСтраница: {v['abs_url']}"
    return "https://calendar.google.com/calendar/render?" + urlencode({
        "action": "TEMPLATE", "text": v["title"], "dates": f"{_utc_stamp(v['start_dt'])}/{_utc_stamp(v['end_dt'])}",
        "details": details, "location": v["meet_url"],
    }, quote_via=quote)


def _ics_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace(";", r"\;").replace(",", "\\,").replace("\r", "").replace("\n", "\\n")


# ---------- посетитель и запросы ----------

def _visitor(request: Request) -> uuid.UUID:
    try:
        return uuid.UUID(request.cookies.get(VID_COOKIE, ""))
    except ValueError:
        return uuid.uuid4()


def _with_cookie(response: Response, request: Request, vid: uuid.UUID) -> Response:
    if request.cookies.get(VID_COOKIE) != str(vid):
        response.set_cookie(VID_COOKIE, str(vid), max_age=365 * 24 * 3600, httponly=True, samesite="lax", secure=True)
    return response


async def _get_event(session: AsyncSession, slug: str) -> Event:
    ev = await session.scalar(select(Event).where(Event.slug == slug)) if SLUG_RE.match(slug) else None
    if ev is None:
        raise HTTPException(404, "Мероприятие не найдено")
    return ev


async def _rsvp_counts(session: AsyncSession) -> dict[uuid.UUID, int]:
    rows = await session.execute(select(EventRsvp.event_id, func.count()).group_by(EventRsvp.event_id))
    return {event_id: n for event_id, n in rows}


async def sitemap_urls() -> list[str]:
    async with db.SessionLocal() as session:
        slugs = (await session.scalars(select(Event.slug).order_by(Event.starts_at))).all()
    return [f"{SITE_URL}/events/"] + [f"{SITE_URL}/events/{s}" for s in slugs]


# ---------- страницы ----------

async def _votes(session: AsyncSession, ev: Event, user: dict | None) -> dict:
    """Счётчики «это я» и лайков по пунктам и то, что отметил текущий пользователь."""
    votes: dict = {}
    for key, model in (("aud", EventAudiencePick), ("ag", EventAgendaLike)):
        rows = await session.execute(select(model.item_id, func.count()).where(model.event_id == ev.id).group_by(model.item_id))
        votes[key] = dict(rows.all())
        mine = set()
        if user:
            mine = set((await session.scalars(select(model.item_id).where(model.event_id == ev.id, model.user_id == uuid.UUID(user["id"])))).all())
        votes[key + "_mine"] = mine
    return votes


@router.get("/events/", response_class=HTMLResponse, include_in_schema=False)
async def events_index(request: Request, session: SessionDep):
    now = datetime.now(timezone.utc)
    counts = await _rsvp_counts(session)
    events = [_view(e, counts.get(e.id, 0)) for e in (await session.scalars(select(Event).order_by(Event.starts_at))).all()]
    upcoming = [e for e in events if e["end_dt"] >= now]
    past = [e for e in reversed(events) if e["end_dt"] < now]
    html = env.get_template("events_list.html").render(upcoming=upcoming, past=past, site_url=SITE_URL, **page_ctx(request))
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


@router.get("/events/{slug}", response_class=HTMLResponse, include_in_schema=False)
async def event_page(slug: str, request: Request, session: SessionDep):
    ev = await _get_event(session, slug)
    vid = _visitor(request)
    count = await session.scalar(select(func.count()).select_from(EventRsvp).where(EventRsvp.event_id == ev.id))
    going = await session.scalar(
        select(EventRsvp.id).where(EventRsvp.event_id == ev.id, EventRsvp.visitor_id == vid)) is not None
    ctx = page_ctx(request)
    v = _view(ev, count, going, await _votes(session, ev, ctx["user"]))
    # Кнопка «Редактировать» — только тем, кто реально может править это мероприятие. Это лишь подсказка в интерфейсе:
    # настоящая защита стоит на самих маршрутах /events/<slug>/edit (editor.py), прячем кнопку не ради безопасности.
    user = ctx["user"]
    can_edit_event = bool(user and can_edit(user["email"], ev))
    org_role = ("owner" if can_delete(user["email"], ev) else "coauthor") if can_edit_event else None
    html = env.get_template("event.html").render(e=v, site_url=SITE_URL, can_edit_event=can_edit_event, org_role=org_role, **ctx)
    return HTMLResponse(html, headers={"Cache-Control": "no-store", "Vary": "Cookie"})  # счётчики и отметки — персональные


# ---------- «Это я» в «Для кого» и лайки программы: только для вошедших через Google ----------

KINDS = {"audience": (EventAudiencePick, "audience"), "agenda": (EventAgendaLike, "agenda")}


async def _toggle_item(request: Request, session: AsyncSession, slug: str, kind: str, item_id: str):
    user = session_user(request)
    if not user:
        return JSONResponse({"login": f"/login?next=/events/{slug}"}, status_code=401, headers={"Cache-Control": "no-store"})
    if not csrf_ok(request, request.headers.get("x-csrf", "")):
        raise HTTPException(403, "Страница устарела, обновите её")
    ev = await _get_event(session, slug)
    model, field = KINDS[kind]
    if not any(i.get("id") == item_id for i in getattr(ev, field)):
        raise HTTPException(404, "Пункт не найден")
    uid = uuid.UUID(user["id"])
    inserted = await session.scalar(
        insert(model).values(event_id=ev.id, user_id=uid, item_id=item_id)
        .on_conflict_do_nothing(index_elements=["event_id", "user_id", "item_id"]).returning(model.id))
    on = inserted is not None
    if not on:  # повторное нажатие снимает отметку
        await session.execute(delete(model).where(model.event_id == ev.id, model.user_id == uid, model.item_id == item_id))
    await session.commit()
    count = await session.scalar(select(func.count()).select_from(model).where(model.event_id == ev.id, model.item_id == item_id))
    if on:
        item = next(i for i in getattr(ev, field) if i.get("id") == item_id)
        what = f"♥ лайк пункту программы «{notify.esc(item.get('title'))}»" if kind == "agenda" else f"🙋 «это я»: {notify.esc(item.get('text'))}"
        notify.send(f"{what}\n{notify.esc(user['name'])} ({notify.esc(user['email'])}) · всего {count}\n{notify.event_link(ev)}")
    return JSONResponse({"on": on, "count": count}, headers={"Cache-Control": "no-store"})


@router.post("/api/events/{slug}/audience/{item_id}", include_in_schema=False)
async def toggle_audience(slug: str, item_id: str, request: Request, session: SessionDep):
    return await _toggle_item(request, session, slug, "audience", item_id)


@router.post("/api/events/{slug}/agenda/{item_id}", include_in_schema=False)
async def toggle_agenda_like(slug: str, item_id: str, request: Request, session: SessionDep):
    return await _toggle_item(request, session, slug, "agenda", item_id)


# ---------- «Я пойду» ----------

@router.post("/api/events/{slug}/rsvp", include_in_schema=False)
async def toggle_rsvp(slug: str, request: Request, session: SessionDep):
    """Переключатель: первое нажатие — отметка, повторное — снятие. Возвращает {going, count}."""
    ev = await _get_event(session, slug)
    vid = _visitor(request)
    inserted = await session.scalar(
        insert(EventRsvp).values(event_id=ev.id, visitor_id=vid)
        .on_conflict_do_nothing(index_elements=["event_id", "visitor_id"]).returning(EventRsvp.id))
    going = inserted is not None
    if not going:
        await session.execute(delete(EventRsvp).where(EventRsvp.event_id == ev.id, EventRsvp.visitor_id == vid))
    await session.commit()
    count = await session.scalar(select(func.count()).select_from(EventRsvp).where(EventRsvp.event_id == ev.id))
    if going:
        notify.send(f"✅ Кто-то нажал «Я пойду» · всего {count}\n{notify.event_link(ev)}")
    return _with_cookie(JSONResponse({"going": going, "count": count}, headers={"Cache-Control": "no-store"}), request, vid)


# ---------- «Добавить в календарь»: считаем на сервере, поэтому работает и без JS ----------

async def _count_click(session: AsyncSession, ev: Event, kind: str, vid: uuid.UUID) -> None:
    session.add(EventCalendarClick(event_id=ev.id, kind=kind, visitor_id=vid))
    await session.commit()
    where = "Google Calendar" if kind == "google" else "календарь (.ics)"
    notify.send(f"📅 Кто-то добавил в {where}\n{notify.event_link(ev)}")


@router.get("/events/{slug}/calendar/google", include_in_schema=False)
async def calendar_google(slug: str, request: Request, session: SessionDep):
    ev = await _get_event(session, slug)
    vid = _visitor(request)
    await _count_click(session, ev, "google", vid)
    resp = RedirectResponse(_gcal_url(_view(ev)), status_code=302, headers={"Cache-Control": "no-store"})
    return _with_cookie(resp, request, vid)


@router.get("/events/{slug}/calendar.ics", include_in_schema=False)
async def calendar_ics(slug: str, request: Request, session: SessionDep):
    ev = await _get_event(session, slug)
    vid = _visitor(request)
    await _count_click(session, ev, "ics", vid)
    v = _view(ev)
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Code Vibe//Events//RU", "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        f"UID:{ev.slug}@codevibehub.org",
        f"DTSTAMP:{_utc_stamp(datetime.now(timezone.utc))}",
        f"DTSTART:{_utc_stamp(ev.starts_at)}",
        f"DTEND:{_utc_stamp(ev.ends_at)}",
        f"SUMMARY:{_ics_escape(ev.title)}",
        f"DESCRIPTION:{_ics_escape(ev.subtitle + chr(10) + chr(10) + v['abs_url'])}",
        f"LOCATION:{_ics_escape(ev.meet_url)}",
        f"URL:{v['abs_url']}",
        "END:VEVENT", "END:VCALENDAR",
    ]
    resp = Response("\r\n".join(lines) + "\r\n", media_type="text/calendar; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{ev.slug}.ics"', "Cache-Control": "no-store"})
    return _with_cookie(resp, request, vid)


# ---------- фото спикеров из S3 (бакет остаётся приватным, отдаём через приложение) ----------

@router.get("/media/events/{slug}/speaker/{sid}", include_in_schema=False)
async def speaker_photo(slug: str, sid: str, session: SessionDep):
    ev = await _get_event(session, slug)
    key = next((sp.get("photo_key") for sp in ev.speakers if sp.get("id") == sid), None)
    if not (key and storage.configured()):
        raise HTTPException(404)
    found = await run_in_threadpool(storage.get_object, key)
    if found is None:
        raise HTTPException(404)
    body, content_type = found
    return Response(body, media_type=content_type, headers={"Cache-Control": "public, max-age=86400"})
