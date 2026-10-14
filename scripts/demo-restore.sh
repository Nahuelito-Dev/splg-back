#!/usr/bin/env bash
# Restaura un backup de scripts/demo-backup.sh: base (pg_restore) y objetos de S3.
#
#   set -a; source .env; set +a
#   CONFIRMAR_RESTAURAR=splg_db scripts/demo-restore.sh ~/backups-splg/<fecha>
#
# Pisa la base con el dump (--clean). En S3 sube de nuevo lo copiado; NO borra lo que
# se haya subido después del backup. Las cuentas borradas de Firebase NO vuelven.
set -euo pipefail

DESTINO="${1:-}"
DB_NAME="${DB_NAME:-splg_db}"
DB_USERNAME="${DB_USERNAME:-postgres}"
DB_CONTAINER="${DB_CONTAINER:-splg-bd}"
if [ -z "$DESTINO" ] || [ ! -s "$DESTINO/$DB_NAME.dump" ]; then
  echo "Uso: CONFIRMAR_RESTAURAR=$DB_NAME scripts/demo-restore.sh <carpeta del backup>" >&2
  echo "No encuentro $DESTINO/$DB_NAME.dump (o está vacío)." >&2
  exit 1
fi
if [ "${CONFIRMAR_RESTAURAR:-}" != "$DB_NAME" ]; then
  echo "Esto pisa la base $DB_NAME. Para confirmar: CONFIRMAR_RESTAURAR=$DB_NAME" >&2
  exit 1
fi
if [ -z "${AWS_S3_BUCKET:-}" ]; then
  echo "Falta AWS_S3_BUCKET: cargá el .env (set -a; source .env; set +a)." >&2
  exit 1
fi
# El backup tiene que ser de ESTA base y de ESTE bucket.
BASE_DEL_BACKUP="$(sed -n 's/^base=//p' "$DESTINO/MANIFEST.txt" 2>/dev/null || true)"
BUCKET_DEL_BACKUP="$(sed -n 's/^bucket=//p' "$DESTINO/MANIFEST.txt" 2>/dev/null || true)"
if [ "$BASE_DEL_BACKUP" != "$DB_NAME" ] || [ "$BUCKET_DEL_BACKUP" != "$AWS_S3_BUCKET" ]; then
  echo "El backup no coincide con el entorno: se corta." >&2
  echo "  base:   backup=[$BASE_DEL_BACKUP]   DB_NAME=[$DB_NAME]" >&2
  echo "  bucket: backup=[$BUCKET_DEL_BACKUP]   AWS_S3_BUCKET=[$AWS_S3_BUCKET]" >&2
  exit 1
fi
ENDPOINT=()
if [ -n "${AWS_S3_ENDPOINT:-}" ]; then ENDPOINT=(--endpoint-url "$AWS_S3_ENDPOINT"); fi

echo "→ Base $DB_NAME"
docker exec -i "$DB_CONTAINER" pg_restore -U "$DB_USERNAME" -d "$DB_NAME" --clean --if-exists --no-owner --single-transaction --exit-on-error < "$DESTINO/$DB_NAME.dump"

echo "→ S3 s3://$AWS_S3_BUCKET"
for dir in "$DESTINO"/s3/*/; do
  [ -d "$dir" ] || continue
  p="$(basename "$dir")"
  aws s3 sync ${ENDPOINT[@]+"${ENDPOINT[@]}"} "$dir" "s3://$AWS_S3_BUCKET/$p" --only-show-errors
done
echo "Restauración lista. Volvé a levantar el back."
