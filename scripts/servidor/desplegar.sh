#!/usr/bin/env bash
# Despliegue de la API de SPLG en el Orix. Lo invoca GitHub Actions por SSH con una clave
# restringida a este comando: recibe por la entrada estándar un git bundle con la rama a
# desplegar y en SSH_ORIGINAL_COMMAND el commit esperado.
#
# Pasos: respaldo de la base → código del bundle → imagen nueva → migraciones → API nueva →
# health. Si el health no da 200 en 3 minutos vuelve a la imagen anterior (las migraciones no
# se revierten solas: para eso está el respaldo previo).
set -euo pipefail
RAIZ="$HOME/splg"
REPO="$RAIZ/splg-app-backend"
COMPOSE=(docker compose -f docker-compose.servidor.yaml)
COMMIT="${SSH_ORIGINAL_COMMAND:-}"
COMMIT="${COMMIT##* }"
[[ "$COMMIT" =~ ^[0-9a-f]{7,40}$ ]] || { echo "Falta el commit a desplegar (sha)."; exit 2; }

exec 9>"$RAIZ/.desplegando" && flock -n 9 || { echo "Ya hay un despliegue en curso."; exit 3; }

BUNDLE="$RAIZ/entrante.bundle"
cat > "$BUNDLE"
git -C "$REPO" bundle verify -q "$BUNDLE"
git -C "$REPO" fetch -q "$BUNDLE" "+refs/heads/*:refs/remotes/entrante/*"
git -C "$REPO" cat-file -e "$COMMIT^{commit}" || { echo "El bundle no trae $COMMIT."; exit 4; }
rm -f "$BUNDLE"

echo "== Respaldo previo"
"$RAIZ/respaldar.sh"
PREVIO=$(ls -1t "$RAIZ"/respaldos/splg_prod-*.dump | head -1)
cp "$PREVIO" "$RAIZ/respaldos/antes-de-${COMMIT:0:8}.dump"

cd "$REPO"
ANTERIOR=$(git rev-parse HEAD)
git checkout -q --detach "$COMMIT"

echo "== Imagen"
docker tag splg-app-backend-api:latest splg-api:anterior 2>/dev/null || true
"${COMPOSE[@]}" build -q api

echo "== Migraciones"
"${COMPOSE[@]}" run --rm --no-deps api node node_modules/typeorm/cli.js migration:run -d dist/data-source.js

echo "== API nueva"
"${COMPOSE[@]}" up -d api
for _ in $(seq 1 60); do
  c=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3000/api/health || true)
  [ "$c" = 200 ] && { echo "OK ${COMMIT:0:8} health=200"; exit 0; }
  sleep 3
done

echo "== El health no respondió: vuelvo a ${ANTERIOR:0:8}"
git checkout -q --detach "$ANTERIOR"
if docker image inspect splg-api:anterior >/dev/null 2>&1; then
  docker tag splg-api:anterior splg-app-backend-api:latest
  "${COMPOSE[@]}" up -d --no-build api
fi
exit 5
