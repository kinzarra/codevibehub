"""Поиск встречи в Google Calendar по ссылке Meet: из самой ссылки дату не достать, в ней только код комнаты.

Нужен токен с правом calendar.readonly (его выдаёт отдельное согласие, см. auth.py) и включённый в проекте
Google Cloud «Google Calendar API».
"""
import asyncio
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx

API = "https://www.googleapis.com/calendar/v3"
MEET_RE = re.compile(r"meet\.google\.com/([a-z]{3}-[a-z]{4}-[a-z]{3})\b", re.IGNORECASE)
EVENT_FIELDS = "items(summary,description,location,hangoutLink,start,end,conferenceData/entryPoints/uri)"


class NeedsAuth(Exception):
    """Токен просрочен или права не выданы."""


class ApiDisabled(Exception):
    """В проекте Google Cloud не включён Calendar API."""


def meet_code(url: str) -> str | None:
    m = MEET_RE.search(url or "")
    return m.group(1).lower() if m else None


def match_events(items: list[dict], code: str, fallback_tz: str | None = None) -> list[dict]:
    """Выбирает события, где встречается код комнаты; события на весь день (без времени) пропускает."""
    found = []
    for item in items:
        texts = [item.get("hangoutLink", ""), item.get("location", ""), item.get("description", "")]
        texts += [e.get("uri", "") for e in item.get("conferenceData", {}).get("entryPoints", [])]
        if not any(code in (t or "").lower() for t in texts):
            continue
        start, end = item.get("start", {}), item.get("end", {})
        if "dateTime" not in start or "dateTime" not in end:
            continue
        found.append({
            "start": datetime.fromisoformat(start["dateTime"]),
            "end": datetime.fromisoformat(end["dateTime"]),
            "timezone": start.get("timeZone") or fallback_tz,
            "title": item.get("summary", ""),
        })
    return found


async def _get(client: httpx.AsyncClient, url: str, params: dict) -> dict:
    r = await client.get(url, params=params)
    if r.status_code == 401:
        raise NeedsAuth
    if r.status_code == 403:
        reasons = {e.get("reason") for e in r.json().get("error", {}).get("errors", [])}
        if reasons & {"accessNotConfigured", "SERVICE_DISABLED"} or "has not been used" in r.text:
            raise ApiDisabled
        raise NeedsAuth
    r.raise_for_status()
    return r.json()


async def find_meet_event(access_token: str, code: str) -> dict | None:
    """Ближайшая по времени встреча с этим Meet-кодом среди всех календарей пользователя."""
    now = datetime.now(timezone.utc)
    params = {"timeMin": (now - timedelta(days=1)).isoformat(), "timeMax": (now + timedelta(days=540)).isoformat(),
              "singleEvents": "true", "orderBy": "startTime", "maxResults": "250", "fields": EVENT_FIELDS}
    async with httpx.AsyncClient(headers={"Authorization": f"Bearer {access_token}"}, timeout=10) as client:
        cals = (await _get(client, f"{API}/users/me/calendarList",
                           {"minAccessRole": "reader", "maxResults": "50", "fields": "items(id,timeZone)"})).get("items", [])

        async def one(cal: dict) -> list[dict]:
            data = await _get(client, f"{API}/calendars/{quote(cal['id'], safe='')}/events", params)
            return match_events(data.get("items", []), code, cal.get("timeZone"))

        found = [e for chunk in await asyncio.gather(*(one(c) for c in cals[:30])) for e in chunk]
    return min(found, key=lambda e: e["start"]) if found else None
