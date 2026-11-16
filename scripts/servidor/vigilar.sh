#!/usr/bin/env bash
# Cada 5 minutos: si la API pública de SPLG deja de responder (o vuelve), avisa por Telegram una
# sola vez por cambio de estado.
ESTADO="$HOME/splg/.estado-api"
c=$(curl -s -o /dev/null -w '%{http_code}' -m 20 http://127.0.0.1:3000/api/health)
antes=$(cat "$ESTADO" 2>/dev/null || echo 200)
if [ "$c" != "200" ] && [ "$antes" = "200" ]; then
  "$HOME/splg/avisar.sh" "🔴 SPLG producción: la API no responde (health=$c) $(date '+%d/%m %H:%M'). Contenedor: $(docker inspect -f '{{.State.Status}}' splg-api 2>/dev/null)"
elif [ "$c" = "200" ] && [ "$antes" != "200" ]; then
  "$HOME/splg/avisar.sh" "🟢 SPLG producción: la API volvió a responder $(date '+%d/%m %H:%M')."
fi
echo "$c" > "$ESTADO"
