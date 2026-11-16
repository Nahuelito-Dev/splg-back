#!/usr/bin/env bash
# Respaldo diario de la base de producción de SPLG. Guarda los últimos 14 y avisa por Telegram
# si falla (cuando ~/splg/telegram.conf existe). Lo corre el crontab de labs-wagners.
set -uo pipefail
DIR="$HOME/splg/respaldos"
mkdir -p "$DIR" && chmod 700 "$DIR"
ARCH="$DIR/splg_prod-$(date +%Y-%m-%d_%H%M).dump"
DB=$(docker exec splg-bd printenv POSTGRES_DB)
if docker exec splg-bd pg_dump -U postgres -Fc "$DB" > "$ARCH" && [ -s "$ARCH" ]; then
  chmod 600 "$ARCH"
  ls -1t "$DIR"/splg_prod-*.dump | tail -n +15 | xargs -r rm -f
  echo "$(date '+%F %T') ok $(du -h "$ARCH" | cut -f1)" >> "$DIR/respaldos.log"
else
  rm -f "$ARCH"
  echo "$(date '+%F %T') FALLÓ" >> "$DIR/respaldos.log"
  "$HOME/splg/avisar.sh" "🔴 SPLG producción: falló el respaldo diario de la base ($(date '+%d/%m %H:%M'))."
fi
