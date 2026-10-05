"""Создание и правка мероприятий: /my/events, /events/new, /events/<slug>/edit.

Форма — JS-редактор со «стикерами» (static/editor/editor.js): простые поля приходят обычными полями формы,
цифры, программа, «для кого», ссылки и спикеры — одним JSON в поле payload, фото спикеров — файлами photo_<id>.
Права — в auth.py (can_create / can_edit).
"""
import json
import logging
import re
import secrets
from datetime import datetime, timezone
from typing import Annotated
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.datastructures import UploadFile

import db
import gcal
import storage
from auth import (
    CreatorDep,
    LoginDep,
    calendar_token,
    can_delete,
    can_edit,
    check_csrf,
    forget_calendar_token,
    norm_email,
    render,
)
from events import SLUG_RE, speaker_photo_url
from models import (
    Event,
    EventAgendaLike,
    EventAudiencePick,
    EventCalendarClick,
    EventRsvp,
    User,
)

MAX_PHOTO = 5 * 1024 * 1024
LIMITS = {"coauthors": 10, "stats": 8, "agenda": 12, "audience": 14, "links": 12, "speakers": 10, "speaker_links": 8}
RESERVED_SLUGS = {"new"}
HASHTAG_RE = re.compile(r"^[\w-]{1,30}$")
SID_RE = re.compile(r"^[0-9a-f]{8}$")
EMAIL_RE = re.compile(r"^[^@\s,;<>]{1,64}@[^@\s,;<>]{1,190}\.[^@\s,;<>]{2,}$")
PLAIN = ("slug", "title", "subtitle", "description", "hashtag", "timezone", "start", "end", "tz_label", "format", "meet_url")
DEFAULTS = {"hashtag": "вебинар", "timezone": "Asia/Nicosia", "tz_label": "Кипр / МСК", "format": "Онлайн · Google Meet"}

log = logging.getLogger("codevibehub.audit")
router = APIRouter(include_in_schema=False)
SessionDep = Annotated[AsyncSession, Depends(db.get_session)]


# ---------- разбор формы ----------

def _s(v, limit: int) -> str:
    return str(v).strip()[:limit] if isinstance(v, (str, int, float)) else ""


def _item_id(raw, seen: set) -> str:
    """Стабильный id пункта: к нему привязаны отметки пользователей, поэтому правка текста их не сбрасывает."""
    sid = raw if isinstance(raw, str) and SID_RE.match(raw) and raw not in seen else secrets.token_hex(4)
    seen.add(sid)
    return sid


def _dicts(v) -> list[dict]:
    return [i for i in v if isinstance(i, dict)] if isinstance(v, list) else []


def _url(value: str, what: str, errors: list[str]) -> str | None:
    p = urlparse(value)
    if p.scheme not in ("http", "https") or not p.netloc:
        errors.append(f"{what}: нужна ссылка вида https://…")
        return None
    return value


def _links(v, what: str, limit: int, errors: list[str]) -> list[dict]:
    out = []
    for item in _dicts(v)[:limit]:
        url = _s(item.get("url"), 500)
        if not url:
            continue
        if _url(url, what, errors):
            label = _s(item.get("label"), 40) or urlparse(url).netloc.removeprefix("www.")
            out.append({"label": label, "url": url})
    return out


def _parse(form, creating: bool, existing: Event | None, actor: str) -> tuple[dict, dict, dict, list[str]]:
    """-> (значения для повторного показа формы, поля модели, фото {id спикера: файл}, ошибки)."""
    errors: list[str] = []
    raw = {k: str(form.get(k, "")).strip() for k in PLAIN}
    try:
        payload = json.loads(str(form.get("payload") or "{}"))
    except ValueError:
        payload = None
    if not isinstance(payload, dict):
        payload = {}
        errors.append("Не удалось прочитать форму. Обновите страницу.")
    data: dict = {}

    if creating:
        if not SLUG_RE.match(raw["slug"]) or len(raw["slug"]) > 80 or raw["slug"] in RESERVED_SLUGS:
            errors.append("Адрес страницы: латиница в нижнем регистре, цифры и дефис, например my-webinar")
        data["slug"] = raw["slug"]
    for key, label, limit in (("title", "Название", 200), ("subtitle", "Подзаголовок", 600), ("description", "Описание для поиска", 400)):
        if not raw[key]:
            errors.append(f"{label}: обязательное поле")
        elif len(raw[key]) > limit:
            errors.append(f"{label}: не длиннее {limit} символов")
        data[key] = raw[key]

    tags = list(dict.fromkeys(t.strip().lstrip("#") for t in raw["hashtag"].split(",") if t.strip()))
    tag = ",".join(tags)
    if any(not HASHTAG_RE.fullmatch(t) for t in tags) or len(tag) > 40:
        errors.append("Стикеры: буквы, цифры, дефис или подчёркивание; до 30 символов каждый, до 40 вместе")
    raw["hashtag"], data["hashtag"] = tag, tag[:40]
    data["tz_label"], data["format"] = raw["tz_label"][:40], raw["format"][:80] or DEFAULTS["format"]

    tz = None
    try:
        tz = ZoneInfo(raw["timezone"])
        data["timezone"] = raw["timezone"]
    except (ZoneInfoNotFoundError, ValueError):
        errors.append("Часовой пояс: нужен идентификатор вроде Asia/Nicosia или Europe/Moscow")
    try:
        start, end = datetime.fromisoformat(raw["start"]), datetime.fromisoformat(raw["end"])
        if tz:
            data["starts_at"], data["ends_at"] = start.replace(tzinfo=tz), end.replace(tzinfo=tz)
            if data["ends_at"] <= data["starts_at"]:
                errors.append("Время окончания должно быть позже начала")
    except ValueError:
        errors.append("Начало и конец: укажите дату и время")
    data["meet_url"] = _url(raw["meet_url"], "Ссылка на звонок", errors) if raw["meet_url"] else None
    if not raw["meet_url"]:
        errors.append("Ссылка на звонок: обязательное поле")

    stats = []
    for i in _dicts(payload.get("stats"))[:LIMITS["stats"]]:
        value, label = _s(i.get("value"), 20), _s(i.get("label"), 80)
        if value or label:
            if not (value and label):
                errors.append("Цифры: у каждой нужны и значение, и подпись")
            stats.append({"value": value, "label": label})
    agenda, seen = [], set()
    for i in _dicts(payload.get("agenda"))[:LIMITS["agenda"]]:
        title, text = _s(i.get("title"), 120), _s(i.get("text"), 500)
        if title or text:
            if not title:
                errors.append("Программа: у каждого пункта нужен заголовок")
            agenda.append({"id": _item_id(i.get("id"), seen), "title": title, "text": text})
    audience, seen = [], set()
    for i in _dicts(payload.get("audience"))[:LIMITS["audience"]]:
        text = _s(i.get("text"), 200)
        if text:
            audience.append({"id": _item_id(i.get("id"), seen), "text": text})
    links = _links(payload.get("links"), "Ссылки", LIMITS["links"], errors)

    old = {sp.get("id"): sp for sp in (existing.speakers if existing else [])}
    speakers, photos, seen = [], {}, set()
    for i in _dicts(payload.get("speakers"))[:LIMITS["speakers"]]:
        sid = i.get("id") if isinstance(i.get("id"), str) and SID_RE.match(i["id"]) and i["id"] not in seen else secrets.token_hex(4)
        seen.add(sid)
        name = _s(i.get("name"), 120)
        if not name:
            errors.append("Спикеры: у каждого нужно имя")
        photo_key = None if i.get("remove_photo") else old.get(sid, {}).get("photo_key")
        speakers.append({"id": sid, "name": name, "role": _s(i.get("role"), 160), "bio": _s(i.get("bio"), 1200),
                         "links": _links(i.get("links"), f"Ссылки спикера {name}", LIMITS["speaker_links"], errors),
                         "photo_key": photo_key})
        f = form.get(f"photo_{i.get('id')}")
        if isinstance(f, UploadFile) and f.filename:
            photos[sid] = f

    # соавторы: email Google-аккаунта; сравниваем в нормализованном виде (у gmail точки и «+метка» не важны)
    old_co = {norm_email(c.get("email")): c for c in (existing.coauthors if existing else [])}
    coauthors, seen_mail = [], set()
    raw_co = payload.get("coauthors")
    for item in (raw_co if isinstance(raw_co, list) else [])[:LIMITS["coauthors"] + 5]:
        mail = norm_email(_s(item, 254))
        if not mail or mail in seen_mail:
            continue
        if not EMAIL_RE.match(mail):
            errors.append(f"Соавторы: «{_s(item, 60)}» не похоже на email")
            continue
        seen_mail.add(mail)
        coauthors.append(old_co.get(mail) or {"email": mail, "added_by": norm_email(actor),
                                              "added_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    if len(coauthors) > LIMITS["coauthors"]:
        errors.append(f"Соавторов не больше {LIMITS['coauthors']}")

    data.update(stats=stats, agenda=agenda, audience=audience, links=links, speakers=speakers, coauthors=coauthors)
    initial = {**{k: raw[k] for k in PLAIN}, "stats": stats, "agenda": agenda, "audience": audience, "links": links,
               "coauthors": [c["email"] for c in coauthors],
               "speakers": [{**sp, "photo_url": speaker_photo_url(existing, sp) if existing else None} for sp in speakers]}
    return initial, data, photos, errors


def _photo_type(data: bytes) -> tuple[str, str] | None:
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg", "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png", "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp", "image/webp"
    return None


async def _save_photos(slug: str, speakers: list[dict], photos: dict) -> list[str]:
    """Кладёт загруженные фото в S3 и прописывает ключи. Возвращает предупреждения (мероприятие сохраняется в любом случае)."""
    warnings = []
    for sp in speakers:
        upload = photos.get(sp["id"])
        if upload is None:
            continue
        body = await upload.read()
        kind = _photo_type(body)
        if len(body) > MAX_PHOTO:
            warnings.append(f"Фото «{sp['name']}» больше 5 МБ, не загружено.")
        elif kind is None:
            warnings.append(f"Фото «{sp['name']}»: нужен JPG, PNG или WebP, не загружено.")
        elif not storage.configured():
            warnings.append("S3 не настроен на сервере, фото не загружены.")
        else:
            key = f"events/{slug}/speakers/{sp['id']}{kind[0]}"
            try:
                await run_in_threadpool(storage.put_object, key, body, kind[1])
                sp["photo_key"] = key
            except Exception:  # noqa: BLE001 — отказ S3 не должен терять сохранённое мероприятие
                warnings.append(f"S3 отклонил фото «{sp['name']}» (проверьте права ключа).")
    return warnings


def _initial_from_event(e: Event) -> dict:
    tz = ZoneInfo(e.timezone)
    return {
        "slug": e.slug, "title": e.title, "subtitle": e.subtitle, "description": e.description, "hashtag": e.hashtag,
        "timezone": e.timezone, "start": e.starts_at.astimezone(tz).strftime("%Y-%m-%dT%H:%M"),
        "end": e.ends_at.astimezone(tz).strftime("%Y-%m-%dT%H:%M"), "tz_label": e.tz_label, "format": e.format,
        "meet_url": e.meet_url, "stats": e.stats, "agenda": e.agenda, "audience": e.audience, "links": e.links,
        "coauthors": [c["email"] for c in e.coauthors],
        "speakers": [{**sp, "photo_url": speaker_photo_url(e, sp)} for sp in e.speakers],
    }


def _form_page(request: Request, initial: dict, errors: list[str], creating: bool, event: Event | None = None,
               manage_coauthors: bool = True):
    return render(request, "event_form.html", initial={**DEFAULTS, **{k: v for k, v in initial.items() if v != ""}},
                  errors=errors, creating=creating, event=event, manage_coauthors=manage_coauthors)


async def _load(session: AsyncSession, slug: str, user: dict, need: str = "edit") -> Event:
    """Находит мероприятие и проверяет право: edit — править и смотреть отметки, delete — удалять и менять соавторов."""
    ev = await session.scalar(select(Event).where(Event.slug == slug)) if SLUG_RE.match(slug) else None
    if ev is None:
        raise HTTPException(404, "Мероприятие не найдено")
    allowed = can_delete(user["email"], ev) if need == "delete" else can_edit(user["email"], ev)
    if not allowed:
        raise HTTPException(303, headers={"Location": "/no-access"})
    return ev


# ---------- мои мероприятия ----------

@router.get("/my/events", response_class=HTMLResponse)
async def my_events(request: Request, user: LoginDep, session: SessionDep):
    rsvps = dict((await session.execute(select(EventRsvp.event_id, func.count()).group_by(EventRsvp.event_id))).all())
    clicks: dict = {}
    for event_id, kind, n in (await session.execute(
            select(EventCalendarClick.event_id, EventCalendarClick.kind, func.count())
            .group_by(EventCalendarClick.event_id, EventCalendarClick.kind))).all():
        clicks.setdefault(event_id, {})[kind] = n
    rows = []
    for e in (await session.scalars(select(Event).order_by(Event.starts_at.desc()))).all():
        if not can_edit(user["email"], e):
            continue
        local = e.starts_at.astimezone(ZoneInfo(e.timezone))
        rows.append({"e": e, "when": f"{local:%d.%m.%Y %H:%M} · {e.tz_label}", "rsvp": rsvps.get(e.id, 0),
                     "can_delete": can_delete(user["email"], e),
                     "gcal": clicks.get(e.id, {}).get("google", 0), "ics": clicks.get(e.id, {}).get("ics", 0)})
    return render(request, "my_events.html", rows=rows, flash=request.session.pop("flash", None))


# ---------- создание ----------

@router.get("/events/new", response_class=HTMLResponse)
async def new_form(request: Request, user: CreatorDep):
    return _form_page(request, {}, [], True)


@router.post("/events/new")
async def create(request: Request, user: CreatorDep, session: SessionDep):
    form = await check_csrf(request)
    initial, data, photos, errors = _parse(form, creating=True, existing=None, actor=user["email"])
    if not errors and await session.scalar(select(Event.id).where(Event.slug == data["slug"])):
        errors.append("Мероприятие с таким адресом уже есть")
    if errors:
        return _form_page(request, initial, errors, True)
    warnings = await _save_photos(data["slug"], data["speakers"], photos)
    session.add(Event(**data, owner_email=user["email"]))
    await session.commit()
    log.info("event created: slug=%s by=%s coauthors=%s", data["slug"], user["email"], [c["email"] for c in data["coauthors"]])
    request.session["flash"] = " ".join(["Мероприятие создано.", *warnings])
    return RedirectResponse("/my/events", status_code=303)


# ---------- правка и удаление ----------

@router.get("/events/{slug}/edit", response_class=HTMLResponse)
async def edit_form(slug: str, request: Request, user: LoginDep, session: SessionDep):
    ev = await _load(session, slug, user)
    return _form_page(request, _initial_from_event(ev), [], False, ev, manage_coauthors=can_delete(user["email"], ev))


@router.post("/events/{slug}/edit")
async def update(slug: str, request: Request, user: LoginDep, session: SessionDep):
    ev = await _load(session, slug, user)
    form = await check_csrf(request)
    manage = can_delete(user["email"], ev)
    initial, data, photos, errors = _parse(form, creating=False, existing=ev, actor=user["email"])
    initial["slug"] = ev.slug
    if not manage:  # соавтор правит содержимое, но не раздаёт доступ: список соавторов не трогаем, что бы ни пришло в форме
        data.pop("coauthors")
        initial["coauthors"] = [c["email"] for c in ev.coauthors]
        errors = [e for e in errors if not e.startswith("Соавтор")]
    if errors:
        return _form_page(request, initial, errors, False, ev, manage_coauthors=manage)
    warnings = await _save_photos(ev.slug, data["speakers"], photos)
    before = {c["email"] for c in ev.coauthors}
    for key, value in data.items():
        setattr(ev, key, value)
    await session.commit()
    after = {c["email"] for c in ev.coauthors}
    log.info("event updated: slug=%s by=%s role=%s", ev.slug, user["email"], "owner" if manage else "coauthor")
    if before != after:
        log.warning("coauthors changed: slug=%s by=%s added=%s removed=%s", ev.slug, user["email"], sorted(after - before), sorted(before - after))
    request.session["flash"] = " ".join(["Сохранено.", *warnings])
    return RedirectResponse("/my/events", status_code=303)


@router.post("/events/{slug}/delete")
async def remove(slug: str, request: Request, user: LoginDep, session: SessionDep):
    ev = await _load(session, slug, user, need="delete")
    await check_csrf(request)
    await session.execute(delete(Event).where(Event.id == ev.id))  # отметки и клики удаляются каскадом
    await session.commit()
    log.warning("event DELETED: slug=%s by=%s", ev.slug, user["email"])
    request.session["flash"] = f"Мероприятие «{ev.title}» удалено."
    return RedirectResponse("/my/events", status_code=303)


# ---------- «Подтянуть дату по ссылке на звонок» ----------

@router.get("/api/meet-lookup")
async def meet_lookup(request: Request, user: CreatorDep, url: str = "", tz: str = ""):
    code = gcal.meet_code(url)
    if not code:
        return JSONResponse({"error": "bad_link"})
    token = calendar_token(user)
    if not token:
        return JSONResponse({"needs_auth": True})
    try:
        found = await gcal.find_meet_event(token, code)
    except gcal.NeedsAuth:
        forget_calendar_token(user)
        return JSONResponse({"needs_auth": True})
    except gcal.ApiDisabled:
        return JSONResponse({"error": "api_disabled"})
    except Exception:  # noqa: BLE001 — сеть или Google недоступны: покажем общую ошибку
        return JSONResponse({"error": "failed"})
    if found is None:
        return JSONResponse({"found": False})
    zone = next((z for z in (found["timezone"], tz) if z and _valid_tz(z)), "UTC")
    fmt = "%Y-%m-%dT%H:%M"
    return JSONResponse({"found": True, "timezone": zone, "title": found["title"],
                         "start": found["start"].astimezone(ZoneInfo(zone)).strftime(fmt),
                         "end": found["end"].astimezone(ZoneInfo(zone)).strftime(fmt)})


def _valid_tz(name: str) -> bool:
    try:
        ZoneInfo(name)
        return True
    except (ZoneInfoNotFoundError, ValueError):
        return False


# ---------- кто что отметил ----------

@router.get("/events/{slug}/insights", response_class=HTMLResponse)
async def insights(slug: str, request: Request, user: LoginDep, session: SessionDep):
    ev = await _load(session, slug, user)

    async def by_item(model) -> dict[str, list[User]]:
        rows = await session.execute(select(model.item_id, User).join(User, User.id == model.user_id)
                                     .where(model.event_id == ev.id).order_by(model.created_at))
        out: dict[str, list[User]] = {}
        for item_id, u in rows.all():
            out.setdefault(item_id, []).append(u)
        return out

    picks, likes = await by_item(EventAudiencePick), await by_item(EventAgendaLike)
    audience = [{"text": a["text"], "users": picks.get(a["id"], [])} for a in ev.audience]
    agenda = [{"text": a["title"], "users": likes.get(a["id"], [])} for a in ev.agenda]
    people = {u.id: u for lst in (*picks.values(), *likes.values()) for u in lst}
    return render(request, "insights.html", e=ev, audience=audience, agenda=agenda, people=len(people),
                  can_manage=can_delete(user["email"], ev))
