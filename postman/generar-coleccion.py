#!/usr/bin/env python3
"""Genera la coleccion de Postman con, por cada endpoint, su caso correcto y
sus casos de fallo, cada uno con el test que corresponde."""
import json, re, os, sys
SP = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, SP)
from cuerpos import CUERPOS

spec = json.load(open(f"{SP}/openapi.json"))
defs = spec.get("components", {}).get("schemas", {})
ids = {}
for l in open(f"{SP}/ids.txt"):
    l = l.strip()
    if "=" in l:
        k, v = l.split("=", 1); ids[k] = v

RECURSO = {"orders": "orderId", "delivery": "deliveryId", "customers": "customerId",
           "users": "userId", "user-address": "addressId", "gascylinder": "gasCylinderId",
           "cylinders": "cylinderId", "time-slot": "timeSlotId", "admin": "adminId",
           "coverage-zones": "coverageZoneId", "car": "carId", "role": "roleId",
           "ratings": "ratingId", "incidents": "incidentId", "claims": "claimId",
           "distributor": "distributorId"}
POR_NOMBRE = {"orderid":"orderId","customerid":"customerId","deliveryid":"deliveryId",
  "userid":"userId","distributorid":"distributorId","addressid":"addressId",
  "cylinderid":"cylinderId","gascylinderid":"gasCylinderId","timeslotid":"timeSlotId",
  "coveragezoneid":"coverageZoneId","carid":"carId","roleid":"roleId","ratingid":"ratingId",
  "incidentid":"incidentId","adminid":"adminId","term":"term","email":"email",
  "phonenumber":"phoneNumber","type":"type","patent":"patent","distributor":"distributorSlug"}
POR_RUTA_USERID = {"customers":"customerUserId","delivery":"deliveryUserId","user-address":"addressUserId"}
INEXISTENTE = "00000000-0000-4000-8000-000000000000"

# Endpoints cuyo camino feliz depende del ESTADO del dato, no del cuerpo. Con
# datos estaticos el rechazo es la respuesta correcta, asi que se acepta y se
# deja escrito que hace falta para que devuelva 2xx.
BORRABLE = {
 "DELETE /api/gascylinder/{id}": "gasCylinderIdBorrable",
 "DELETE /api/customers/{id}": "customerIdBorrable",
 "DELETE /api/delivery/{id}": "deliveryIdBorrable",
 "DELETE /api/users/{id}": "userIdBorrable",
}

PRECONDICIONES = {
 "PATCH /api/orders/{id}/status": ([400], "la transicion tiene que ser valida desde el estado actual del pedido"),
 "PATCH /api/orders/{id}/arrived": ([400], "el pedido tiene que estar en camino"),
 "PATCH /api/orders/{id}/cancel": ([400], "el pedido no puede estar finalizado"),
 "PATCH /api/orders/{id}/confirm-deposit": ([400], "el pedido tiene que ser una reserva pendiente"),
 "GET /api/orders/{id}/delivery-code": ([400], "el pedido tiene que estar aceptado"),
 "POST /api/orders/{id}/confirm-delivery": ([400], "hace falta el codigo real que devuelve GET /orders/{id}/delivery-code"),
 "DELETE /api/orders/{id}": ([400], "el pedido no puede estar en un estado que impida borrarlo"),
 "PATCH /api/orders/{id}/assign/{deliveryId}": ([404], "el chofer tiene que existir y estar activo"),
 "PATCH /api/orders/{id}/location": ([403], "solo el chofer asignado al pedido puede reportar posicion"),
 "POST /api/orders/{id}/reject": ([401, 400], "solo el chofer al que se le ofrecio el pedido"),
 "POST /api/admin/first-superadmin": ([403], "solo funciona si todavia no existe ningun super admin"),
 "POST /api/ratings": ([400, 403], "el pedido tiene que estar entregado y el token ser el del cliente dueno"),
 "POST /api/cylinders/assign": ([400], "el envase tiene que estar en estado filled"),
 "PATCH /api/cylinders/{id}/transition": ([400], "la transicion tiene que ser valida desde el estado actual"),
 "POST /api/email/password-reset": ([400], "el dominio tiene que estar autorizado en el proyecto de Firebase (H-30)"),
 "POST /api/email/change-email": ([400], "hace falta un idToken real de Firebase"),
 "GET /api/customers/user/{userId}": ([404], "el usuario tiene que ser ademas cliente"),
 "GET /api/delivery/user/{userId}": ([404], "el usuario tiene que ser ademas chofer"),
 "PATCH /api/delivery/user/{userId}/availability": ([404], "el usuario tiene que ser ademas chofer"),
 "GET /api/coverage-zones/check": ([400], "exige lat y lng, que el OpenAPI no declara (H-09)"),
 "GET /api/admin/term/{term}": ([404], "busca por UUID o email exacto, no por nombre"),
 "POST /api/claims": ([400], "el pedido tiene que pertenecer al cliente indicado"),
}

# Endpoints que aceptan datos invalidos y contestan 2xx en vez de 400.
# El test falla a proposito: es el defecto, no el test.
# POST /users con un rol inexistente da 500 en vez de 400 (H-37). El test falla
# a proposito: es el defecto, no el test.
ACEPTAN_BASURA = {
 "PATCH /api/customers/{id}/location": "H-31",
 "PATCH /api/delivery/{id}/location": "H-31",
 "POST /api/notifications/token": "H-31",
 "POST /api/notifications/send-test": "H-31",
 "POST /api/notifications/order-confirmation": "H-31",
 "POST /api/users/check-exists": "H-28",
}

# El OpenAPI declara un codigo y el endpoint devuelve otro. Es un defecto de
# contrato: se acepta el real y se deja anotado.
CODIGO_DECLARADO_MAL = {
 "POST /api/notifications/token": 201,
 "POST /api/notifications/send-test": 201,
 "POST /api/notifications/order-confirmation": 201,
 "POST /api/users/check-exists": 201,
}
# Cuales NO exigen token: medido llamando a la API sin autorizacion, no deducido
# del codigo. Pedirles 401 seria un test mal escrito que falla siempre.
PUBLICOS = set(json.load(open(f"{SP}/publicos.json")))

def var_de(param, ruta):
    p = param.lower().replace("_", "")
    if p == "userid":
        for seg, v in POR_RUTA_USERID.items():
            if f"/{seg}/" in ruta or ruta.endswith(f"/{seg}"): return v
    if p in POR_NOMBRE: return POR_NOMBRE[p]
    for seg in ruta.split("/"):
        if seg in RECURSO: return RECURSO[seg]
    return param

def ejemplo(esq, prof=0, nombre=""):
    if not esq or prof > 6: return {}
    if "$ref" in esq: return ejemplo(defs.get(esq["$ref"].split("/")[-1], {}), prof+1, nombre)
    if "allOf" in esq:
        out = {}
        for s in esq["allOf"]:
            v = ejemplo(s, prof+1, nombre)
            if isinstance(v, dict): out.update(v)
        return out
    if "example" in esq: return esq["example"]
    if "enum" in esq: return esq["enum"][0]
    t = esq.get("type")
    if t == "array": return [ejemplo(esq.get("items", {}), prof+1, nombre)]
    if t == "object" or "properties" in esq:
        return {k: ejemplo(v, prof+1, k) for k, v in (esq.get("properties") or {}).items()}
    plano = nombre.lower().replace("_", "")
    if plano in POR_NOMBRE: return "{{" + POR_NOMBRE[plano] + "}}"
    if t in ("integer", "number"): return 1
    if t == "boolean": return True
    f = esq.get("format")
    if f == "date-time": return "2026-10-15T14:00:00.000Z"
    if f == "date": return "2026-10-15"
    if f == "uuid": return "{{orderId}}"
    return "texto"

def a_postman(o):
    """Pasa los marcadores <<x>> de los cuerpos curados a variables de Postman."""
    if isinstance(o, dict): return {k: a_postman(v) for k, v in o.items()}
    if isinstance(o, list): return [a_postman(v) for v in o]
    if isinstance(o, str):
        o = o.replace("<<unico>>", "{{$timestamp}}").replace("<<sufijo>>", "{{sufijo}}")
        return re.sub(r"<<(\w+)>>", lambda m: "{{" + m.group(1) + "}}", o)
    return o

def test(titulo, esperados, extra=""):
    return f"""// {titulo}
pm.test("nunca 5xx", () => pm.expect(pm.response.code, "un 5xx es siempre un defecto").to.be.below(500));
pm.test("responde {' o '.join(map(str, esperados))}", () =>
  pm.expect(pm.response.code).to.be.oneOf({json.dumps(esperados)}));
pm.test("responde en menos de 2s", () => pm.expect(pm.response.responseTime).to.be.below(2000));
{extra}""".strip().split("\n")

TEST_OK_EXTRA = """
if (pm.response.code < 300 && pm.response.text()) {
  pm.test("devuelve JSON valido", () => pm.response.json());
  pm.test("no filtra datos sensibles", () => {
    const t = pm.response.text();
    pm.expect(t, "refreshToken").to.not.include("refreshToken");
    pm.expect(t, "apiKey").to.not.include("apiKey");
  });
}
""".strip()

TEST_ERROR_EXTRA = """
pm.test("el error explica que paso", () => {
  const j = pm.response.json();
  pm.expect(j, "falta message").to.have.property("message");
  pm.expect(j, "falta statusCode").to.have.property("statusCode");
});
pm.test("el error no revela rutas del servidor", () =>
  pm.expect(pm.response.text()).to.not.match(/\\/(Users|home|var\\/www)\\//));
""".strip()

def request(nombre, metodo, segmentos, cabeceras, cuerpo, desc, script, query=None, sin_auth=False):
    r = {"name": nombre,
         "request": {"method": metodo, "header": cabeceras,
                     "url": {"raw": "{{baseUrl}}/" + "/".join(segmentos),
                             "host": ["{{baseUrl}}"], "path": segmentos},
                     "description": desc,
                     **({"auth": {"type": "noauth"}} if sin_auth else {})},
         "event": [{"listen": "test", "script": {"type": "text/javascript", "exec": script}}]}
    if query: r["request"]["url"]["query"] = query
    if cuerpo is not None:
        r["request"]["body"] = {"mode": "raw",
            "raw": json.dumps(cuerpo, indent=2, ensure_ascii=False),
            "options": {"raw": {"language": "json"}}}
    return r

ORDEN_CRUD = {"post": 0, "get": 1, "put": 2, "patch": 3, "delete": 4}
tareas = []
for ruta, ops in spec.get("paths", {}).items():
    for metodo, op in ops.items():
        if metodo in ORDEN_CRUD:
            tareas.append(((op.get("tags") or ["Sin clasificar"])[0],
                           ORDEN_CRUD[metodo], ruta, metodo, op))
tareas.sort(key=lambda t: (t[0], t[1], t[2]))

carpetas, curados, sin_curar = {}, 0, 0
for _tag, _ord, ruta, metodo, op in tareas:
    if True:
        if metodo not in ("get", "post", "put", "patch", "delete"): continue
        tag = (op.get("tags") or ["Sin clasificar"])[0]
        M = metodo.upper()
        clave = f"{M} {ruta}"
        if clave in BORRABLE:
            pm_ruta = re.sub(r"\{[^}]+\}", "{{" + BORRABLE[clave] + "}}", ruta)
        else:
            pm_ruta = re.sub(r"\{([^}]+)\}", lambda m: "{{" + var_de(m.group(1), ruta) + "}}", ruta)
        segmentos = [s for s in pm_ruta.strip("/").split("/") if s]
        if segmentos and segmentos[0] == "api":
            segmentos = segmentos[1:]
        tiene_id = "{" in ruta

        base_headers = [{"key": "X-Client-Source", "value": "{{clientSource}}"},
                        {"key": "X-Distributor", "value": "{{distributorSlug}}"}]
        rb = op.get("requestBody")
        esq = (rb or {}).get("content", {}).get("application/json", {}).get("schema") if rb else None

        curado = CUERPOS.get(clave)
        if rb or curado:
            cuerpo_ok = a_postman(curado["ok"]) if curado else ejemplo(esq)
            headers = base_headers + [{"key": "Content-Type", "value": "application/json"}]
        else:
            cuerpo_ok, headers = None, base_headers
        if curado: curados += 1
        elif rb: sin_curar += 1

        query = []
        for pr in op.get("parameters", []):
            if pr.get("in") != "query": continue
            v = "{{" + var_de(pr["name"], ruta) + "}}" if pr["name"].lower() in POR_NOMBRE else ""
            if not v:
                n = pr["name"].lower()
                v = ("2026-10-15" if "date" in n or "fecha" in n else
                     "-27.41" if n in ("lat", "latitude") else
                     "-55.965" if n in ("lng", "lon", "longitude") else
                     "day" if "granularit" in n else "")
            query.append({"key": pr["name"], "value": v,
                          "disabled": not pr.get("required", False)})

        declarados = sorted({int(c) for c in op.get("responses", {}) if c.isdigit() and int(c) < 300})
        exito = declarados or ([201] if M == "POST" else [200])
        items = []

        # Si el modulo tiene un POST, lo que se crea ahi pasa a ser el sujeto del
        # resto del modulo: asi el DELETE borra lo recien creado y no los datos
        # sembrados, y la coleccion se puede correr muchas veces seguidas.
        captura = ""
        if M == "POST" and not ruta.rstrip("/").endswith(("login", "dashboard", "check-exists")):
            var_mod = None
            for seg in ruta.split("/"):
                if seg in RECURSO: var_mod = RECURSO[seg]; break
            if var_mod:
                captura = f"""
if (pm.response.code < 300) {{
  const j = pm.response.json();
  const nuevo = j?.{var_mod} || j?.id || j?.{var_mod.replace('Id','_id')} ||
                Object.entries(j || {{}}).find(([k, v]) =>
                  /(_id|Id)$/.test(k) && typeof v === "string" && v.length === 36)?.[1];
  if (nuevo) {{
    pm.collectionVariables.set("{var_mod}", nuevo);
    if (pm.environment.name) pm.environment.set("{var_mod}", nuevo);
    console.log("{var_mod} ahora apunta a lo recien creado:", nuevo);
  }}
}}"""
        mal = CODIGO_DECLARADO_MAL.get(clave)
        if mal: exito = sorted(set(exito + [mal]))
        pre = PRECONDICIONES.get(clave)
        if pre:
            exito = sorted(set(exito + pre[0]))
        nota = "" if (curado or not rb) else ("\n\nEl cuerpo es un ejemplo generado desde el "
               "OpenAPI y puede no cumplir todas las reglas: revisalo antes de darlo por bueno.")
        items.append(request(
            f"1 · correcto → {' o '.join(map(str, exito))}", M, segmentos, headers, cuerpo_ok,
            (op.get("summary") or "") + nota +
            (f"\n\nPrecondicion: {pre[1]}." if pre else ""),
            test("El camino feliz: datos validos y permisos correctos.",
                 exito + ([403] if not curado else []), TEST_OK_EXTRA + captura), query or None))

        if rb or curado:
            cuerpo_malo = a_postman(curado["malo"]) if curado else {"campo_inexistente": "x"}
            basura = ACEPTAN_BASURA.get(clave)
            if basura:
                items.append(request(
                    f"2 · datos invalidos → 400  [defecto {basura}]", M, segmentos,
                    headers, cuerpo_malo,
                    f"Este endpoint NO tiene DTO: hoy acepta esto y contesta 2xx sin "
                    f"actualizar nada. El test FALLA a proposito hasta que se escriba "
                    f"el DTO ({basura}).",
                    test(f"Defecto conocido {basura}: deberia rechazar con 400.",
                         [400, 403], TEST_ERROR_EXTRA), query or None))
            else:
                items.append(request(
                    "2 · datos invalidos → 400", M, segmentos, headers, cuerpo_malo,
                    "El ValidationPipe tiene que rechazar esto antes de tocar la base.",
                    test("Entrada invalida: el pipe la frena con 400.", [400, 403],
                         TEST_ERROR_EXTRA), query or None))

        if clave not in PUBLICOS:
          items.append(request(
            "3 · sin token → 401", M, segmentos,
            base_headers + [{"key": "Authorization", "value": "", "disabled": False}],
            cuerpo_ok, "Sin cabecera de autorizacion: el AuthGuard tiene que cortar.",
            ["// Esta peticion va sin token a proposito.",
             "pm.test(\"nunca 5xx\", () => pm.expect(pm.response.code).to.be.below(500));",
             "pm.test(\"rechaza sin token (401)\", () => pm.expect(pm.response.code).to.be.oneOf([401, 403]));"],
            query or None, sin_auth=True))
        else:
          items.append(request(
            "3 · publico: anda sin token", M, segmentos, base_headers, cuerpo_ok,
            "Este endpoint NO exige token (verificado contra la API). Se deja la "
            "peticion para dejar constancia de que es publico a proposito.",
            ["// Endpoint publico: no se le pide 401.",
             "pm.test(\"nunca 5xx\", () => pm.expect(pm.response.code).to.be.below(500));",
             "pm.test(\"responde sin token\", () => pm.expect(pm.response.code).to.not.equal(401));"],
            query or None, sin_auth=True))

        if tiene_id and M in ("GET", "PATCH", "PUT", "DELETE"):
            seg_fake = [("{{idInexistente}}" if s.startswith("{{") and s.endswith("}}") and "Id" in s else s)
                        for s in segmentos]
            if seg_fake != segmentos:
                items.append(request(
                    "4 · id inexistente → 404", M, seg_fake, headers, cuerpo_ok,
                    "Un identificador con formato valido que no existe en la base.",
                    test("Recurso inexistente: 404, o lista vacia si el endpoint "
                         "devuelve una coleccion. Lo que no puede ser es un 500.",
                         [404, 400, 403] + ([200] if M == "GET" else [])),
                    query or None))

        carpetas.setdefault(tag, []).append({"name": f"{M} {ruta}", "item": items})

# --- accesos ---
ACCESOS = [("Entrar como cliente","{{clienteEmail}}","{{clientePassword}}","cliente","auth/login","customer-app","tokenCliente"),
           ("Entrar como chofer","{{choferEmail}}","{{choferPassword}}","chofer","auth/login","driver-app","tokenChofer"),
           ("Entrar como administrador","{{adminEmail}}","{{adminPassword}}","admin","auth/login/dashboard","panel-app","tokenAdmin"),
           ("Entrar como super administrador","{{superAdminEmail}}","{{superAdminPassword}}","super_admin","auth/login/dashboard","panel-app","tokenSuperAdmin")]
login = {"name": "00 · Acceso",
         "description": "Correr esto primero: deja el token de cada rol en su variable.",
         "item": []}
for nombre, u, c, rol, ep, src, var in ACCESOS:
    login["item"].append({"name": nombre, "request": {
        "method": "POST",
        "header": [{"key": "Content-Type", "value": "application/json"},
                   {"key": "X-Client-Source", "value": src}],
        "body": {"mode": "raw", "raw": json.dumps({"email": u, "password": c}, indent=2),
                 "options": {"raw": {"language": "json"}}},
        "url": {"raw": "{{baseUrl}}/" + ep, "host": ["{{baseUrl}}"], "path": ep.split("/")},
        "description": f"Deja el token de {rol} en {{{{{var}}}}} y activo en {{{{token}}}}."},
      "event": [{"listen": "test", "script": {"type": "text/javascript", "exec": f"""
pm.test("el acceso de {rol} funciona", () => pm.response.to.have.status(200));
const j = pm.response.json();
const idToken = j?._tokenResponse?.idToken;
pm.test("devuelve un token", () => pm.expect(idToken).to.be.a("string"));
if (idToken) {{
  pm.collectionVariables.set("{var}", idToken);
  pm.collectionVariables.set("token", idToken);
  // El guard compara el rol del token con X-Client-Source: tienen que ir juntos.
  pm.collectionVariables.set("clientSource", "{src}");
}}
// Defecto H-02: el login devuelve el objeto crudo de Firebase. Falla a proposito.
pm.test("[H-02] no deberia devolver refreshToken ni apiKey", () => {{
  const t = pm.response.text();
  pm.expect(t, "refreshToken").to.not.include("refreshToken");
  pm.expect(t, "apiKey").to.not.include("apiKey");
}});""".strip().split("\n")}}]})


# --- datos descartables, para que las bajas no toquen nada compartido --------
prep = {"name": "01 · Preparacion",
  "description": "Crea un cliente, un chofer y un usuario que existen solo para "
                 "ser borrados al final. Asi las bajas de Customers, Delivery y "
                 "Users no se llevan puesto el dato que usan los demas modulos.",
  "item": []}
for titulo, ruta_prep, origen, cuerpo_prep, captura in [
  ("Cliente descartable", "users/customer-registration", "customer-app",
   {"email": "borrable.cli.{{sufijo}}@splg-test.com", "password": "Test1234",
    "full_name": "Cliente Descartable", "phone_number": "+549376{{sufijo}}"},
   [("customerIdBorrable", "j?.customer?.customer_id"), ("userIdBorrable", "j?.user_id")]),
  ("Garrafa descartable", "gascylinder", "panel-app",
   {"type": "Descartable {{sufijo}}", "weight": 10, "price": 9000, "stock": 5,
    "description": "Producto creado solo para probar la baja"},
   [("gasCylinderIdBorrable", "j?.gas_cylinder_id")]),
  ("Chofer descartable", "users/delivery-registration", "panel-app",
   {"email": "borrable.cho.{{sufijo}}@splg-test.com", "password": "Test1234",
    "full_name": "Chofer Descartable", "phone_number": "+549377{{sufijo}}",
    "distributorId": "{{distributorId}}"},
   [("deliveryIdBorrable", "j?.delivery?.delivery_id")]),
]:
    sets = "\n".join(
      f'  if ({expr}) {{ pm.collectionVariables.set("{v}", {expr}); '
      f'if (pm.environment.name) pm.environment.set("{v}", {expr}); }}'
      for v, expr in captura)
    prep["item"].append({"name": titulo, "request": {
        "method": "POST",
        "header": [{"key": "Content-Type", "value": "application/json"},
                   {"key": "X-Client-Source", "value": origen},
                   {"key": "X-Distributor", "value": "{{distributorSlug}}"},
                   {"key": "Authorization", "value": "Bearer {{tokenSuperAdmin}}"}],
        "body": {"mode": "raw", "raw": json.dumps(cuerpo_prep, indent=2, ensure_ascii=False),
                 "options": {"raw": {"language": "json"}}},
        "url": {"raw": "{{baseUrl}}/" + ruta_prep, "host": ["{{baseUrl}}"],
                "path": ruta_prep.split("/")},
        "description": "Dato descartable: se crea para poder probar la baja sin "
                       "romper el resto de la coleccion."},
      "event": [{"listen": "test", "script": {"type": "text/javascript", "exec": f"""
pm.test("se crea el dato descartable", () => pm.expect(pm.response.code).to.be.oneOf([200, 201]));
if (pm.response.code < 300) {{
  const j = pm.response.json();
{sets}
}}""".strip().split("\n")}}]})

col = {"info": {"name": "SPLG — API completa (correcto y fallo)",
   "description": (
     "Cada endpoint tiene su caso correcto y sus casos de fallo, cada uno con el "
     "test que corresponde.\n\n"
     "  1 · correcto        espera 2xx\n"
     "  2 · datos invalidos espera 400\n"
     "  3 · sin token       espera 401\n"
     "  4 · id inexistente  espera 404\n\n"
     "Uso: importar el environment, completar las contrasenas (estan en splg-dev.sh), "
     "levantar el entorno con ./splg-dev.sh y correr primero la carpeta 00 · Acceso.\n\n"
     "Los cuerpos marcados como ejemplo generado no estan verificados; los demas se "
     "probaron contra la API real."),
   "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
  "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "{{token}}", "type": "string"}]},
  "event": [{"listen": "prerequest", "script": {"type": "text/javascript", "exec": [
      "// Sufijo corto y distinto en cada corrida. No se usa {{$timestamp}} para los",
      "// telefonos porque son 10 digitos y E.164 no admite mas de 15 en total.",
      "if (!pm.collectionVariables.get('sufijo')) {",
      "  pm.collectionVariables.set('sufijo', String(Date.now()).slice(-6));",
      "}"]}}],
  "variable": ([{"key": k, "value": "", "type": "string"} for k in
               ("token","tokenAdmin","tokenSuperAdmin","tokenCliente","tokenChofer","sufijo")]
               + [{"key": "clientSource", "value": "panel-app", "type": "string"}]),
  "item": [login, prep] + [{"name": t, "item": v} for t, v in sorted(carpetas.items())]}
json.dump(col, open(f"{SP}/SPLG.postman_collection.json", "w"), indent=2, ensure_ascii=False)

valores = [
  {"key":"baseUrl","value":"http://localhost:3000/api","enabled":True},
  {"key":"clientSource","value":"panel-app","enabled":True,"description":"panel-app | customer-app | driver-app"},
  {"key":"distributorSlug","value":"jeny-gas","enabled":True},
  {"key":"idInexistente","value":INEXISTENTE,"enabled":True,"description":"UUID con formato valido que no existe"},
  {"key":"customerIdBorrable","value":"","enabled":True,"description":"Lo llena 01 · Preparacion"},
  {"key":"deliveryIdBorrable","value":"","enabled":True,"description":"Lo llena 01 · Preparacion"},
  {"key":"userIdBorrable","value":"","enabled":True,"description":"Lo llena 01 · Preparacion"},
  {"key":"gasCylinderIdBorrable","value":"","enabled":True,"description":"Lo llena 01 · Preparacion"},
  {"key":"adminEmail","value":"admin@splg.com","enabled":True},
  {"key":"adminPassword","value":"","enabled":True,"type":"secret"},
  {"key":"superAdminEmail","value":"superadmin@splg.com","enabled":True},
  {"key":"superAdminPassword","value":"","enabled":True,"type":"secret"},
  {"key":"clienteEmail","value":ids.get("clienteEmail","cliente@splg.com"),"enabled":True},
  {"key":"clientePassword","value":"","enabled":True,"type":"secret"},
  {"key":"choferEmail","value":ids.get("choferEmail","chofer@splg.com"),"enabled":True},
  {"key":"choferPassword","value":"","enabled":True,"type":"secret"},
]
for k, v in sorted(ids.items()):
    if k.endswith(("Email","Password")): continue
    valores.append({"key": k, "value": v, "enabled": True})
json.dump({"name":"SPLG local","values":valores,"_postman_variable_scope":"environment"},
          open(f"{SP}/SPLG-local.postman_environment.json","w"), indent=2, ensure_ascii=False)

n = sum(len(sub.get("item", [1])) for f in col["item"][2:] for sub in f["item"]) + len(login["item"]) + len(prep["item"])
print(f"carpetas: {len(carpetas)}  endpoints: {sum(len(v) for v in carpetas.values())}  requests: {n}")
print(f"cuerpos curados y probados: {curados}   cuerpos de ejemplo sin curar: {sin_curar}")
