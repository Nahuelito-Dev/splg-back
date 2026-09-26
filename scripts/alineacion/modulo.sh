#!/usr/bin/env bash
# Uso: modulo.sh <etiqueta> <carpetas de src a lintear...>
set -u
S=${SPLG_TMP:-/tmp/splg-alineacion}; mkdir -p $S
BACK=/Users/nahuelwagner/Desktop/myprojects/gearthlogic/projects/garrafitas/splg-app-backend
cd $BACK
TAG=$1; shift
npx prettier --write "$@" >/dev/null 2>&1
echo "== tsc";    npx tsc --noEmit -p tsconfig.json 2>&1 | head -20
echo "== eslint"; npx eslint "$@" 2>&1 | tail -15
echo "== jest";   npx jest 2>&1 | grep -E "^Tests:|✕" | head
echo "== api";    /Users/nahuelwagner/Desktop/myprojects/gearthlogic/projects/garrafitas/splg-app-backend/scripts/alineacion/verificar.sh $TAG > $S/res-$TAG.txt 2>&1; head -3 $S/res-$TAG.txt | tail -2; grep FAIL $S/res-$TAG.txt | grep -v "health" | head
# Se compara contra la última corrida aceptada (aceptar.sh), así sólo aparecen
# los cambios de este módulo y no los que ya se revisaron.
REF=$S/newman-aceptada.json; [ -f $REF ] || REF=$S/newman-base1.json
echo "== formas (contra $(basename $REF))"; python3 postman/comparar-formas.py $REF $S/newman-$TAG.json | grep -v "api/health"
