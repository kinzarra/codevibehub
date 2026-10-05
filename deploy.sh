#!/usr/bin/env bash
# Деплой на прод: ./deploy.sh
set -euo pipefail

HOST="${DEPLOY_HOST:-deploy@157.180.81.21}"
DIR="${DEPLOY_DIR:-/opt/codevibehub}"

ssh "$HOST" "test -f $DIR/.env" || { echo "Нет $DIR/.env на сервере (нужен POSTGRES_DSN)"; exit 1; }

rsync -az --delete \
  --exclude .env --exclude .git --exclude .idea --exclude .venv --exclude __pycache__ \
  ./ "$HOST:$DIR/"

ssh "$HOST" "cd $DIR && docker compose -p codevibehub up -d --build --remove-orphans && docker compose -p codevibehub ps"
