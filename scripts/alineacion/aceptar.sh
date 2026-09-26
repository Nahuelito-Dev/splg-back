#!/usr/bin/env bash
# Uso: aceptar.sh <etiqueta> — la corrida de ese módulo pasa a ser la referencia
# contra la que se compara el siguiente. Se corre después de revisar y commitear.
S=${SPLG_TMP:-/tmp/splg-alineacion}
cp "$S/newman-$1.json" "$S/newman-aceptada.json" && echo "referencia: newman-$1.json"
