#!/usr/bin/env bash
# Backup previo a la demo limpia: base (pg_dump) + objetos de S3 del prefijo de la demo.
#
#   set -a; source .env; set +a
#   scripts/demo-backup.sh            # deja todo en ~/backups-splg/<fecha>/
#
# Variables: DB_NAME (por defecto splg_db), DB_USERNAME (por defecto postgres),
# DB_CONTAINER (por defecto splg-bd), AWS_S3_BUCKET (obligatoria), AWS_S3_ENDPOINT
# (opcional, MinIO), BACKUP_DIR (por defecto ~/backups-splg).
# Corta ante cualquier error o si la copia queda vacía.
set -euo pipefail

DB_NAME="${DB_NAME:-splg_db}"
DB_USERNAME="${DB_USERNAME:-postgres}"
DB_CONTAINER="${DB_CONTAINER:-splg-bd}"
if [ -z "${AWS_S3_BUCKET:-}" ]; then
  echo "Falta AWS_S3_BUCKET: cargá el .env (set -a; source .env; set +a). No se hizo nada." >&2
  exit 1
fi
# Las carpetas donde el seed y la app dejan los archivos de la demo.
PREFIJOS="gascylinders cars claims incidents distributors users employees attachments fleet"

DESTINO="${BACKUP_DIR:-$HOME/backups-splg}/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DESTINO/s3"
ENDPOINT=()
if [ -n "${AWS_S3_ENDPOINT:-}" ]; then ENDPOINT=(--endpoint-url "$AWS_S3_ENDPOINT"); fi

echo "→ Base $DB_NAME (contenedor $DB_CONTAINER)"
docker exec "$DB_CONTAINER" pg_dump -U "$DB_USERNAME" -Fc "$DB_NAME" > "$DESTINO/$DB_NAME.dump"
if [ ! -s "$DESTINO/$DB_NAME.dump" ]; then
  echo "El dump de la base quedó vacío: se corta. Nada se purgó." >&2
  exit 1
fi

echo "→ S3 s3://$AWS_S3_BUCKET (prefijos de la demo)"
for p in $PREFIJOS; do
  aws s3 sync ${ENDPOINT[@]+"${ENDPOINT[@]}"} "s3://$AWS_S3_BUCKET/$p" "$DESTINO/s3/$p" --only-show-errors
done
aws s3 ls ${ENDPOINT[@]+"${ENDPOINT[@]}"} "s3://$AWS_S3_BUCKET" --recursive > "$DESTINO/s3-inventario.txt"
COPIADOS="$(find "$DESTINO/s3" -type f | wc -l | tr -d ' ')"
if [ "$COPIADOS" = "0" ] && [ "${PERMITIR_S3_VACIO:-}" != "1" ]; then
  echo "La copia de S3 trajo 0 objetos: se corta (¿bucket, credenciales o endpoint mal?)." >&2
  echo "Si el bucket está realmente vacío, repetí con PERMITIR_S3_VACIO=1." >&2
  exit 1
fi

{
  echo "fecha=$(date -Iseconds)"
  echo "base=$DB_NAME"
  echo "bucket=$AWS_S3_BUCKET"
  echo "dump_bytes=$(wc -c < "$DESTINO/$DB_NAME.dump")"
  echo "objetos_copiados=$(find "$DESTINO/s3" -type f | wc -l | tr -d ' ')"
} > "$DESTINO/MANIFEST.txt"
cat "$DESTINO/MANIFEST.txt"
echo
echo "Backup listo en: $DESTINO"
echo "Para volver atrás:  scripts/demo-restore.sh \"$DESTINO\""
