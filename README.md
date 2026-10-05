# CodeVibeHub — лендинг

Одностраничный промо-лендинг с регистрацией на встречу в Google Meet.
Домен: https://codevibehub.org

## Стек

- FastAPI + uvicorn (`main.py`) — отдаёт статику и API
- PostgreSQL через SQLAlchemy async + asyncpg (`db.py`), DSN в `POSTGRES_DSN`
- `static/index.html`, `static/styles.css` — лендинг без сборки
- Docker Compose, сервер `root@157.180.81.21`, каталог `/opt/codevibehub`

## Локальный запуск

```bash
uv venv --python 3.12 .venv            # системный python3 (3.8) слишком старый
uv pip install -r requirements.txt
cp .env.example .env                   # и вписать свой POSTGRES_DSN
.venv/bin/uvicorn main:app --reload --env-file .env    # http://127.0.0.1:8000
```

## Процесс разработки

`main` защищена: прямой push запрещён, изменения — только через Pull Request.

```bash
git checkout -b feature/xyz
# ...коммиты...
git push -u origin feature/xyz   # затем открыть PR в main на GitHub
```

- **CI** (`.github/workflows/ci.yml`) — на каждый PR: ruff, smoke-тест с Postgres, сборка Docker-образа.
- **Deploy** (`.github/workflows/deploy.yml`) — после merge в `main`: `./deploy.sh` от пользователя
  `deploy` по SSH (секрет `DEPLOY_SSH_KEY`), затем проверка `/healthz`. Можно запустить вручную
  (Actions → Deploy → Run workflow).

## Живой лендинг

`live.py` — WebSocket `/ws/live`: посетители видят курсоры, следы и разрезы букв друг друга.
Состояние в памяти процесса, поэтому uvicorn должен работать **одним воркером**. Обратный прокси
перед контейнером должен пропускать WebSocket (заголовки `Upgrade`/`Connection`), иначе лендинг
работает как обычно, но без живого слоя. Клиент — `static/landing/live.js`, работает только при `<body data-landing>`.

## Деплой

Обычно — автоматически после merge. Вручную (нужен SSH-доступ под `deploy`):

```bash
./deploy.sh
```

rsync в `/opt/codevibehub` + `docker compose -p codevibehub up -d --build`.
Контейнер слушает `:8080` на хосте. `.env` не синхронизируется — на сервере свой
`/opt/codevibehub/.env` с `POSTGRES_DSN`. БД — в Postgres-контейнере `irm-db-1`
(сеть `irm_internal`), база `vibecode`. Порты 80/443 на сервере заняты Caddy другого
проекта (irm) — его не трогаем.

## Cloudflare

1. DNS → `A  codevibehub.org → 157.180.81.21`, Proxied (оранжевое облако).
   Опционально `CNAME www → codevibehub.org`, Proxied.
2. SSL/TLS → Overview → режим **Flexible** (до origin идёт HTTP).
3. SSL/TLS → Edge Certificates → **Always Use HTTPS: On**.
4. Rules → Origin Rules → Create rule:
   - When: `Hostname` equals `codevibehub.org` (и `www.codevibehub.org`, если добавлен)
   - Then: Destination Port → **Rewrite to 8080**

## Мероприятия и их создание

- Страницы: `/events/` (афиша), `/events/<slug>` (мероприятие). Данные в Postgres (`events`, `event_rsvps`,
  `event_calendar_clicks`, см. `models.py`); `events/*.json` лишь засевают самую первую пустую БД.
- Создание и правка: `/events/new`, `/events/<slug>/edit`, список своих и счётчики — `/my/events`, вход — `/login`
  (Google). Код: `auth.py` (вход и права), `editor.py` (формы), `gcal.py` (поиск даты по ссылке Meet),
  `static/editor/` (JS-редактор со стикерами, drag & drop фото в S3).
- Посетители: вход через Google для всех (таблица `users`). Вошедший отмечает «это я» в «Для кого»
  (`event_audience_picks`) и лайкает пункты программы (`event_agenda_likes`); у пунктов стабильные `id`, правка текста
  отметки не сбрасывает. Кто что отметил — `/events/<slug>/insights` (только организаторам).
- Роли: **администратор** (`ADMIN_EMAILS`: создаёт, правит, удаляет, смотрит всё), **владелец** (создал мероприятие, пока он
  администратор), **соавтор** (владелец вписывает его Google-почту на странице правки: соавтор правит содержимое и видит
  отметки, но не удаляет мероприятие, не создаёт новые и не меняет список соавторов). Gmail сравнивается без точек и «+метки»
  (`auth.norm_email`). Доступ соавтора отзывается сразу, правки списка пишутся в `codevibehub.audit`.
- Права на создание: сейчас только email из `ADMIN_EMAILS` (через запятую). Правила в двух функциях `auth.can_create` и
  `auth.can_edit`; у каждого мероприятия есть `owner_email`, так что открыть создание всем можно, поменяв только их.
- Переменные (локальный и серверный `.env`): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ADMIN_EMAILS`,
  `SESSION_SECRET`, `PUBLIC_BASE_URL` (`https://codevibehub.org`; локально `http://localhost:8000`), `S3_*`.
- Google Cloud Console → Credentials → OAuth client (Web). Redirect URI: `https://codevibehub.org/auth/callback` и
  `http://localhost:8000/auth/callback`. Для кнопки «Подтянуть дату» включите ещё Google Calendar API.
- Схема БД создаётся `create_all` и сама не меняется: при изменении моделей нужны ручной SQL или миграции (Alembic).

## Безопасность

- **Права проверяет сервер, а не интерфейс.** Кнопка «Редактировать» выводится в HTML только тем, у кого есть право
  (`auth.can_edit`), но настоящая защита стоит на маршрутах `/events/new`, `/events/<slug>/edit|delete|insights`,
  `/my/events` (`require_creator`). Права перечитываются из `ADMIN_EMAILS` на каждый запрос: убрали email из списка,
  и действующая сессия сразу теряет доступ.
- Вход: Google OIDC, только подтверждённый email, сессия пересоздаётся после входа, живёт сутки, cookie `HttpOnly`,
  `SameSite=Lax`, на https имя `__Host-session`. Без `SESSION_SECRET` длиной от 32 символов вход выключен.
- Все POST-формы и API отметок защищены CSRF-токеном (форма или заголовок `X-CSRF`); `next` после входа и выхода
  принимает только пути своего сайта.
- Токен доступа к Google Calendar хранится только в памяти сервера (воркер один), не в cookie.
- `security.py`: `nosniff`, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, Referrer/Permissions-Policy, HSTS на https,
  строгий CSP (`script-src 'self'`) на страницах входа и редактирования, лимит запроса 16 МБ.
- Шаблоны экранируют HTML, ссылки принимаются только http(s), фото проверяются по содержимому (JPG/PNG/WebP, до 5 МБ).
- Создание, правка и удаление пишутся в лог `codevibehub.audit` (кто и какое мероприятие).

## Форма регистрации (TODO)

Форма пока не реализована — оставлена заглушка:

- **Фронт:** `static/index.html`, контейнер `<div id="registration-form">` в секции `#register`.
  Замените его содержимое формой. Стили-обёртка: `.register-form`, кнопки `.btn .btn-primary`,
  цветовые токены в `:root` в `static/styles.css`.
- **Бэкенд:** `POST /api/register` в `main.py` — сейчас возвращает `501`.
- Дата встречи: элемент `[data-event="date"]` в hero-блоке (сейчас «скоро объявим»).
