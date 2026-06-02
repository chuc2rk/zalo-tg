#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

: "${TG_API_ID:?Missing TG_API_ID in .env}"
: "${TG_API_HASH:?Missing TG_API_HASH in .env}"

BOT_API_BIN="${TELEGRAM_BOT_API_BIN:-/home/chuc2rk/.local/bin/telegram-bot-api}"
DATA_DIR="${TGBOTAPI_DATA_DIR:-$SCRIPT_DIR/data/bot-api}"
TEMP_DIR="${TGBOTAPI_TEMP_DIR:-/tmp/zalo-tg-bot-api}"
PORT="${TG_LOCAL_PORT:-8081}"

mkdir -p "$DATA_DIR" "$TEMP_DIR"

exec "$BOT_API_BIN" \
  --api-id="$TG_API_ID" \
  --api-hash="$TG_API_HASH" \
  --local \
  --dir="$DATA_DIR" \
  --temp-dir="$TEMP_DIR" \
  --http-port="$PORT" \
  --log="$DATA_DIR/bot-api.log" \
  --verbosity=1
