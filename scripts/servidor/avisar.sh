#!/usr/bin/env bash
# Manda un mensaje a Telegram con el bot de SPLG. Lee TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID de
# ~/splg/telegram.conf (permisos 600). Sin ese archivo no hace nada.
CONF="$HOME/splg/telegram.conf"
[ -f "$CONF" ] || exit 0
# shellcheck disable=SC1090
. "$CONF"
[ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] || exit 0
curl -s -m 15 -o /dev/null "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=$1" -d disable_web_page_preview=true
