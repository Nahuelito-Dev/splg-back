#!/usr/bin/env bash
# Al arrancar el Orix (corte de luz o reinicio): espera a que la API de SPLG responda y avisa por
# Telegram. Si a los 10 minutos no responde, avisa con el estado de los contenedores.
inicio=$(date +%s)
arranco=$(uptime -s 2>/dev/null)
for _ in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w "%{http_code}" -m 5 http://127.0.0.1:3000/api/health)" = "200" ]; then
    "$HOME/splg/avisar.sh" "🔌 Orix arrancó ($arranco). SPLG develop: API OK en $(( $(date +%s) - inicio ))s."
    echo 200 > "$HOME/splg/.estado-api"
    exit 0
  fi
  sleep 10
done
estados=$(docker ps -a --filter name=splg- --format "{{.Names}}: {{.Status}}" | tr "\n" ";")
"$HOME/splg/avisar.sh" "⚠️ Orix arrancó ($arranco) pero la API de SPLG develop no responde a los 10 min. $estados"
