#!/usr/bin/env python3
"""Aplica el mismo reemplazo a un DSS en todas sus copias: diagramas/DSS_CU-XXX*.mmd
y el bloque mermaid con el mismo title dentro de 2-Analisis.md y Casos-de-Uso.md.
Corta si las copias no coinciden antes, o si el texto a reemplazar aparece mas de
una vez. Uso: dss.py CU-089 cambios.json   (lista de [viejo, nuevo])
          dss.py CU-089 --sincronizar     (copia el .mmd a los .md)"""
import sys, json, glob, re
D='/Users/nahuelwagner/Desktop/myprojects/gearthlogic/projects/garrafitas/splg-docs/'
MDS=['2-Analisis.md','Casos-de-Uso.md']
cu = sys.argv[1]
sincronizar = sys.argv[2] == '--sincronizar'
cambios = [] if sincronizar else json.load(open(sys.argv[2]))
mmds = glob.glob(D+f'diagramas/DSS_{cu}_*.mmd')
assert mmds, f'no hay DSS para {cu}'
textos = {m: open(D+m, encoding='utf-8').read() for m in MDS}
for mmd in mmds:
    src = open(mmd, encoding='utf-8').read()
    titulo = re.search(r'title (.+)', src).group(1)
    nuevo = src
    for viejo, reemplazo in cambios:
        n = nuevo.count(viejo)
        if n == 0: continue
        assert n == 1, f'{mmd}: "{viejo}" aparece {n} veces'
        nuevo = nuevo.replace(viejo, reemplazo)
    for md in MDS:
        bl = [m for m in re.finditer(r'```mermaid\n(.*?)```', textos[md], re.S) if f'title {titulo}\n' in m.group(1)]
        if not bl:
            print(f'  {md}: no tiene copia de {titulo}'); continue
        assert len(bl) == 1, f'{md}: {len(bl)} bloques con ese titulo'
        b = bl[0]
        if not sincronizar:
            assert b.group(1).strip() == src.strip(), f'{md}: la copia de {titulo} ya difiere del .mmd'
        textos[md] = textos[md][:b.start(1)] + nuevo.strip() + '\n' + textos[md][b.end(1):]
    if nuevo != src:
        open(mmd, 'w', encoding='utf-8').write(nuevo)
    print('listo:', mmd.split('/')[-1])
for md in MDS:
    open(D+md, 'w', encoding='utf-8').write(textos[md])
