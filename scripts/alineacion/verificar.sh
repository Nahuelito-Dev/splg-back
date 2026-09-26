#!/usr/bin/env bash
# Uso: verificar.sh <etiqueta>  — compila, levanta el back en :3100, corre newman y lo apaga
set -u
S=${SPLG_TMP:-/tmp/splg-alineacion}; mkdir -p $S
BACK=/Users/nahuelwagner/Desktop/myprojects/gearthlogic/projects/garrafitas/splg-app-backend
TAG=$1; PORT=3100
cd $BACK
rm -rf dist && npx nest build >/dev/null 2>&1 || { echo "BUILD FALLO"; exit 1; }
PORT=$PORT DB_LOGGING=false node dist/main > $S/back-$TAG.log 2>&1 &
PID=$!
for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:$PORT/api/health && break; sleep 1; done
curl -s -o /dev/null -w "health %{http_code}\n" http://localhost:$PORT/api/health
bash postman/refrescar-ids.sh >/dev/null 2>&1
ENV=$S/env-$TAG.json
python3 - "$ENV" "$PORT" <<PY
import json,sys
e=json.load(open('postman/SPLG-local.postman_environment.json'))
ids=dict(l.strip().split('=',1) for l in open('postman/ids.txt') if '=' in l)
for v in e['values']:
    if v['key'].endswith('Password'): v['value']='Test1234'
    if v['key']=='baseUrl': v['value']=f'http://localhost:{sys.argv[2]}/api'
    if v['key'] in ids: v['value']=ids[v['key']]
json.dump(e,open(sys.argv[1],'w'))
PY
npx --no-install newman run postman/SPLG.postman_collection.json -e $ENV --reporters json --reporter-json-export $S/newman-$TAG.json >/dev/null 2>&1
kill $PID; wait $PID 2>/dev/null
python3 - $S/newman-$TAG.json <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))['run']
st=r['stats']; print('requests',st['requests']['total'],'assertions',st['assertions']['total'],'failed',st['assertions']['failed'])
codes={}
for ex in r['executions']:
    c=ex.get('response',{}).get('code'); codes[c]=codes.get(c,0)+1
print('5xx',sum(v for k,v in codes.items() if k and k>=500))
for f in r['failures']:
    print('FAIL|',f['source']['name'],'|',f['error']['test'] if 'test' in f['error'] else f['error'].get('message','')[:80])
PY
