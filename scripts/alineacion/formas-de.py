# Muestra la forma de las respuestas 2xx de una corrida, filtrando por ruta.
import json,sys
sys.path.insert(0,'/Users/nahuelwagner/Desktop/myprojects/gearthlogic/projects/garrafitas/splg-app-backend/postman')
import importlib; cf=importlib.import_module('comparar-formas'.replace('-','_')) if False else None
exec(open('/Users/nahuelwagner/Desktop/myprojects/gearthlogic/projects/garrafitas/splg-app-backend/postman/comparar-formas.py').read().split('def main')[0])
f=cargar(sys.argv[1])
vistos=set()
for k,(etq,cod,fo) in f.items():
    if sys.argv[2] in etq and cod and cod<300:
        clave=etq.split(' · ')[0]
        if clave in vistos: continue
        vistos.add(clave); print(cod, etq); print('   ', json.dumps(fo, ensure_ascii=False)[:1500])
