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

## Деплой

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

## Форма регистрации (TODO)

Форма пока не реализована — оставлена заглушка:

- **Фронт:** `static/index.html`, контейнер `<div id="registration-form">` в секции `#register`.
  Замените его содержимое формой. Стили-обёртка: `.register-form`, кнопки `.btn .btn-primary`,
  цветовые токены в `:root` в `static/styles.css`.
- **Бэкенд:** `POST /api/register` в `main.py` — сейчас возвращает `501`.
- Дата встречи: элемент `[data-event="date"]` в hero-блоке (сейчас «скоро объявим»).
