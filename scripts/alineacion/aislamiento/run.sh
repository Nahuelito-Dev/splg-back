#!/bin/bash
# Por cada actor: resetea los datos de B y corre sus casos. Uso: SPLG_CLAVE=... run.sh <salida>
D="$(cd "$(dirname "$0")" && pwd)"; OUT="${SPLG_TMP:-/tmp/splg-alineacion}/$1"; : > "$OUT"
for a in admA supA choA cliA; do
  docker exec -i splg-bd psql -q -U postgres -d splg_db -v ON_ERROR_STOP=1 < "$D/reset-b.sql" >/dev/null && \
  docker exec -i splg-bd psql -q -U postgres -d splg_db -v ON_ERROR_STOP=1 < "$D/fixture-b.sql" >/dev/null || exit 1
  python3 "$D/bateria.py" bbbb0000-0000-4000-8000-00000000000f $a >> "$OUT" 2>&1
done
grep -v '^ok' "$OUT" | cut -c1-230
