FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py db.py live.py events.py auth.py editor.py gcal.py models.py notify.py security.py storage.py web.py ./
COPY static ./static
COPY templates ./templates
COPY events ./events

EXPOSE 8000
# Заголовки прокси (IP посетителя, https) разбирает security.py и только от Cloudflare — uvicorn им не верит.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--ws-max-size", "65536", "--no-proxy-headers"]
