#!/usr/bin/env python3
"""Aplica el mismo reemplazo a un CUE en sus dos copias: el bloque "#### … CU-XXX —"
de Casos-de-Uso.md (§5, la fuente) y el de 1-Requisitos.md (Doc 1). Corta si las
copias no coinciden antes, o si el texto a reemplazar no aparece exactamente una vez.
Uso: cue.py CU-015 cambios.json    (lista de [viejo, nuevo])
     cue.py CU-015 --sincronizar   (copia el bloque de Casos-de-Uso.md al Doc 1)"""
import sys, json, re
D = '/Users/nahuelwagner/Desktop/myprojects/gearthlogic/projects/garrafitas/splg-docs/'
FUENTE, COPIA = 'Casos-de-Uso.md', '1-Requisitos.md'
cu = sys.argv[1]
sincronizar = sys.argv[2] == '--sincronizar'
cambios = [] if sincronizar else json.load(open(sys.argv[2]))
PAT = re.compile(r'(\n#### (?:\S+ )*' + re.escape(cu) + r' — [^\n]*\n)(.*?)(?=\n#### |\n### |\n## |\Z)', re.S)

def bloque(texto, archivo):
    ms = list(PAT.finditer(texto))
    assert len(ms) == 1, f'{archivo}: {len(ms)} bloques de {cu}'
    return ms[0]

textos = {f: open(D + f, encoding='utf-8').read() for f in (FUENTE, COPIA)}
mf, mc = bloque(textos[FUENTE], FUENTE), bloque(textos[COPIA], COPIA)
cuerpo = mf.group(2)
if not sincronizar:
    assert cuerpo.strip() == mc.group(2).strip(), f'las copias de {cu} ya difieren: sincronizar primero'
    for viejo, nuevo in cambios:
        n = cuerpo.count(viejo)
        assert n == 1, f'{cu}: "{viejo[:60]}" aparece {n} veces'
        cuerpo = cuerpo.replace(viejo, nuevo)
    textos[FUENTE] = textos[FUENTE][:mf.start(2)] + cuerpo + textos[FUENTE][mf.end(2):]
    mc = bloque(textos[COPIA], COPIA)
textos[COPIA] = textos[COPIA][:mc.start(2)] + cuerpo + textos[COPIA][mc.end(2):]
for f, t in textos.items():
    open(D + f, 'w', encoding='utf-8').write(t)
print('listo:', cu)
