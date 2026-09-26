#!/usr/bin/env python3
"""Compara la FORMA de las respuestas de dos corridas de newman.

    python3 postman/comparar-formas.py antes.json despues.json [--modulo Cars]

Las corridas se exportan con `newman run ... --reporters json --reporter-json-export`.
Los valores cambian de una corrida a otra (ids, fechas); lo que no puede cambiar
en un refactor es la forma: qué claves trae cada objeto y si cada valor es un
objeto, una lista o un dato suelto. Eso es lo que las apps y el panel leen.

Reglas de la comparación:
- `null` es comodín: una columna vacía en una corrida y llena en la otra no es un
  cambio de forma.
- Una lista vacía también es comodín, por la misma razón.
- En una lista se unen las claves de todos sus elementos.

Sale con código 1 si alguna respuesta cambió de forma.
"""
import json, sys

def forma(v):
    if v is None:
        return None
    if isinstance(v, dict):
        return {k: forma(x) for k, x in v.items()}
    if isinstance(v, list):
        unida = None
        for x in v:
            unida = unir(unida, forma(x))
        return ["lista", unida]
    return type(v).__name__ if not isinstance(v, bool) else "bool"

def unir(a, b):
    if a is None: return b
    if b is None: return a
    if isinstance(a, dict) and isinstance(b, dict):
        return {k: unir(a.get(k), b.get(k)) for k in set(a) | set(b)}
    if isinstance(a, list) and isinstance(b, list):
        return ["lista", unir(a[1], b[1])]
    return a

def cat(f):
    if isinstance(f, dict): return "objeto"
    if isinstance(f, list): return "lista"
    if f in ("int", "float"): return "número"
    return f

def diferencias(a, b, ruta="$"):
    if a is None or b is None:
        return []
    if cat(a) != cat(b):
        return [f"{ruta}: era {cat(a)}, ahora es {cat(b)}"]
    if isinstance(a, dict):
        out = []
        for k in sorted(set(a) - set(b)):
            out.append(f"{ruta}.{k}: ya no viene")
        for k in sorted(set(b) - set(a)):
            out.append(f"{ruta}.{k}: clave nueva")
        for k in sorted(set(a) & set(b)):
            out += diferencias(a[k], b[k], f"{ruta}.{k}")
        return out
    if isinstance(a, list):
        return diferencias(a[1], b[1], ruta + "[]")
    return []

def cargar(ruta):
    run = json.load(open(ruta))["run"]
    formas = {}
    for ex in run["executions"]:
        item = ex["item"]
        resp = ex.get("response") or {}
        try:
            cuerpo = json.loads(bytes(resp["stream"]["data"]).decode())
        except Exception:
            continue
        # newman inventa ids nuevos en cada corrida: la clave es la plantilla de
        # la URL tal como está en la colección, el método y el nombre del caso.
        plantilla = item["request"]["url"]
        if isinstance(plantilla, dict):
            plantilla = "/".join(plantilla.get("path") or []) + "?" + "&".join(
                q.get("key", "") for q in plantilla.get("query") or [])
        clave = (item["request"].get("method"), plantilla, item["name"])
        req = ex["request"]
        etiqueta = f'{req["method"]} /{"/".join(req["url"]["path"])} · {item["name"]}'
        previa = formas.get(clave)
        f = forma(cuerpo)
        formas[clave] = (etiqueta, resp.get("code"), unir(previa[2], f) if previa else f)
    return formas

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    filtro = sys.argv[sys.argv.index("--modulo") + 1].lower() if "--modulo" in sys.argv else None
    antes, despues = cargar(args[0]), cargar(args[1])
    cambios, comparadas = 0, 0
    for clave, (etq, cod_a, fa) in antes.items():
        if clave not in despues:
            continue
        if filtro and filtro not in etq.lower():
            continue
        etq_b, cod_b, fb = despues[clave]
        # Sólo se comparan respuestas del mismo tipo: un 200 contra un 200.
        if cod_a is None or cod_b is None or cod_a // 100 != cod_b // 100:
            if cod_a != cod_b:
                print(f"~ {etq}: el código cambió de {cod_a} a {cod_b}")
                cambios += 1
            continue
        comparadas += 1
        difs = diferencias(fa, fb)
        if difs:
            cambios += 1
            print(f"✗ {etq}")
            for d in difs:
                print(f"    {d}")
    print(f"\n{comparadas} respuestas comparadas, {cambios} con cambios")
    sys.exit(1 if cambios else 0)

if __name__ == "__main__":
    main()
