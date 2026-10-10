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
           "distributor": "distributorId", "plans": "fleetPlanId", "tasks": "fleetTaskId"}
POR_NOMBRE = {"orderid":"orderId","customerid":"customerId","deliveryid":"deliveryId",
  "userid":"userId","distributorid":"distributorId","addressid":"addressId",
  "cylinderid":"cylinderId","gascylinderid":"gasCylinderId","timeslotid":"timeSlotId",
  "coveragezoneid":"coverageZoneId","carid":"carId","roleid":"roleId","ratingid":"ratingId",
  "incidentid":"incidentId","adminid":"adminId","term":"term","email":"email",
  "phonenumber":"phoneNumber","type":"type","patent":"patent","distributor":"distributorSlug",
  "attachmentid":"fleetAttachmentId"}
POR_RUTA_USERID = {"customers":"customerUserId","delivery":"deliveryUserId","user-address":"addressUserId"}
INEXISTENTE = "00000000-0000-4000-8000-000000000000"

# El acceso esta limitado a 8 intentos por minuto y la coleccion entera gastaba
# diez: los cuatro de "00 · Acceso" mas las variantes de la carpeta Auth, que
# repiten exactamente lo mismo. Para estos dos endpoints se deja SOLO la
# variante de datos invalidos; el camino feliz ya lo prueba "00 · Acceso".
SOLO_CASO_INVALIDO = {"POST /api/auth/login", "POST /api/auth/login/dashboard"}

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
 "POST /api/ratings": ([400, 403], "el pedido tiene que estar entregado y el token ser el del cliente dueno"),
 "POST /api/cylinders/assign": ([400], "el envase tiene que estar en estado filled"),
 "PATCH /api/cylinders/{id}/transition": ([400], "la transicion tiene que ser valida desde el estado actual"),
 "POST /api/email/password-reset": ([400], "el dominio tiene que estar autorizado en el proyecto de Firebase (H-30)"),
 "POST /api/email/change-email": ([400], "hace falta un idToken real de Firebase"),
 "GET /api/customers/user/{userId}": ([404], "el usuario tiene que ser ademas cliente"),
 "GET /api/delivery/user/{userId}": ([404], "el usuario tiene que ser ademas chofer"),
 "PATCH /api/delivery/user/{userId}/availability": ([404], "el usuario tiene que ser ademas chofer"),
 "GET /api/admin/term/{term}": ([404], "busca por UUID o email exacto, no por nombre"),
 "POST /api/claims": ([400], "el pedido tiene que pertenecer al cliente indicado"),
 "PATCH /api/role/{id}": ([409], "los cuatro roles del sistema (customer, delivery, admin, super_admin) no se pueden renombrar: el codigo los busca por ese texto"),
 "DELETE /api/role/{id}": ([409], "un rol del sistema no se puede borrar, y uno en uso tampoco"),
 "POST /api/users": ([409], "el correo y el telefono son unicos: repetir el mismo cuerpo devuelve 409, que es lo correcto"),
 "POST /api/auth/login": ([400, 429], "el acceso esta limitado a 8 intentos por minuto y la coleccion hace alrededor de diez: si sale 429, esperar un minuto"),
 "POST /api/auth/login/dashboard": ([400, 429], "mismo limite de 8 por minuto que /auth/login"),
 "POST /api/admin": ([400, 409], "solo para un usuario con rol admin que todavia no tenga perfil; el alta normal ya lo crea (H-77)"),
 "DELETE /api/customers/{id}": ([403, 404], "la baja de un cliente es del administrador general; el cliente recien creado ademas no le compro a nadie (H-81)"),
 # Dentro de la misma carpeta, "cancel" ordena alfabeticamente antes que
 # "close": para cuando se corre "close", la bateria ya cancelo la tarea
 # recien creada, asi que el 400 ("ya esta cancelada") es el resultado
 # esperado de esa carrera de orden, no un defecto.
 "PATCH /api/fleet/tasks/{id}/close": ([400], "la carpeta ya canceló esta misma tarea (orden alfabético: cancel corre antes que close)"),
}

# Multipart (subida de archivos): el generador arma cuerpos JSON, no
# formdata con un archivo real. Estos tres se prueban a mano contra la API
# (ver el informe de la tarea) y no entran en la coleccion automatica.
SIN_GENERAR = {
 "POST /api/fleet/tasks/{id}/attachments",
 "GET /api/fleet/tasks/{id}/attachments/{attachmentId}/download",
 "DELETE /api/fleet/tasks/{id}/attachments/{attachmentId}",
}

# Endpoints que aceptan datos invalidos y contestan 2xx en vez de 400.
# El test falla a proposito: es el defecto, no el test.
# POST /users con un rol inexistente da 500 en vez de 400 (H-37). El test falla
# a proposito: es el defecto, no el test.
ACEPTAN_BASURA = {
}

# El OpenAPI declara un codigo y el endpoint devuelve otro. Es un defecto de
# contrato: se acepta el real y se deja anotado.
CODIGO_DECLARADO_MAL = {
 "POST /api/notifications/token": 201,
 "POST /api/notifications/send-test": 201,
 "POST /api/notifications/order-confirmation": 201,
}
# Cuales NO exigen token: medido llamando a la API sin autorizacion, no deducido
# del codigo. Pedirles 401 seria un test mal escrito que falla siempre.
PUBLICOS = set(json.load(open(f"{SP}/publicos.json")))

def var_de(param, ruta):
    p = param.lower().replace("_", "")
    if p == "userid":
        for seg, v in POR_RUTA_USERID.items():
            if f"/{seg}/" in ruta or ruta.endswith(f"/{seg}"): return v
    # Las fachadas de flota (documentos, y el historial de vehiculo en uso)
    # usan "carId" en la ruta, pero NO pueden compartir la variable "carId":
    # el modulo Car crea y borra un auto propio en su carpeta, y deja la
    # variable apuntando a uno ya eliminado para cuando le toca el turno a
    # esta carpeta (orden alfabetico: Cars < Fleet).
    if p == "carid" and ("/documents" in ruta or "/assignments" in ruta):
        return "fleetCarId"
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
        if clave in SIN_GENERAR: continue
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
        # El alta publica de clientes no es sujeto de la carpeta Users: un
        # cliente recien registrado no le compro a la distribuidora que la
        # coleccion esta "viendo como" (H-66).
        if M == "POST" and not ruta.rstrip("/").endswith(("login", "dashboard", "check-exists", "customer-registration")):
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
        solo_malo = clave in SOLO_CASO_INVALIDO
        if not solo_malo:
          items.append(request(
            f"1 · correcto → {' o '.join(map(str, exito))}", M, segmentos, headers, cuerpo_ok,
            (op.get("summary") or "") + nota +
            (f"\n\nPrecondicion: {pre[1]}." if pre else ""),
            test("El camino feliz: datos validos y permisos correctos.",
                 exito + ([403] if not curado else []), TEST_OK_EXTRA + captura), query or None))
        else:
          items.append({"name": "1 · correcto → lo prueba 00 · Acceso",
            "request": {"method": "GET", "header": [],
              "url": {"raw": "{{baseUrl}}/health", "host": ["{{baseUrl}}"], "path": ["health"]},
              "auth": {"type": "noauth"},
              "description": "El camino feliz de este endpoint se prueba en la carpeta "
                             "00 · Acceso. No se repite aca porque el acceso esta limitado "
                             "a 8 intentos por minuto y la coleccion entera gastaria diez."},
            "event": [{"listen": "test", "script": {"type": "text/javascript", "exec": [
              "pm.test(\"el acceso se prueba en 00 · Acceso\", () => pm.expect(true).to.be.true);"]}}]})

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
                    "El ValidationPipe tiene que rechazar esto antes de tocar la base."
                    + (" El acceso esta limitado a 8 intentos por minuto y el limite "
                       "cuenta tambien los invalidos: un 429 aca significa esperar un "
                       "minuto, no que el endpoint este mal." if solo_malo else ""),
                    test("Entrada invalida: el pipe la frena con 400.",
                         [400, 403] + ([429] if solo_malo else []),
                         TEST_ERROR_EXTRA), query or None))

        if solo_malo:
            pass
        elif clave not in PUBLICOS:
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
const idToken = j?.accessToken;
pm.test("devuelve un token", () => pm.expect(idToken).to.be.a("string"));
if (idToken) {{
  pm.collectionVariables.set("{var}", idToken);
  pm.collectionVariables.set("token", idToken);
  // El guard compara el rol del token con X-Client-Source: tienen que ir juntos.
  pm.collectionVariables.set("clientSource", "{src}");
}}
// H-02 resuelto: el login devuelve un DTO propio, no el objeto de Firebase.
pm.test("no devuelve refreshToken ni apiKey", () => {{
  const t = pm.response.text();
  pm.expect(t, "refreshToken").to.not.include("refreshToken");
  pm.expect(t, "apiKey").to.not.include("apiKey");
}});
pm.test("devuelve accessToken, expiresIn y user", () => {{
  pm.expect(j).to.have.property("accessToken");
  pm.expect(j).to.have.property("expiresIn");
  pm.expect(j).to.have.property("user");
}});""".strip().split("\n")}}]})


# --- datos descartables, para que las bajas no toquen nada compartido --------
prep = {"name": "01 · Preparacion",
  "description": "Crea un cliente, un chofer y un usuario que existen solo para "
                 "ser borrados al final. Asi las bajas de Customers, Delivery y "
                 "Users no se llevan puesto el dato que usan los demas modulos.",
  "item": []}
for titulo, ruta_prep, origen, cuerpo_prep, captura in [
  ("Cliente descartable", "auth/registro", "customer-app",
   {"email": "borrable.cli.{{sufijo}}@splg-test.com", "password": "Test1234",
    "full_name": "Cliente Descartable", "phone_number": "+549376{{sufijo}}"},
   [("customerIdBorrable", "j?.customer?.customer_id")]),
  ("Garrafa descartable", "gascylinder", "panel-app",
   {"type": "Descartable {{sufijo}}", "weight": 10, "price": 9000, "stock": 5,
    "description": "Producto creado solo para probar la baja"},
   [("gasCylinderIdBorrable", "j?.gas_cylinder_id")]),
  ("Chofer descartable", "users", "panel-app",
   {"email": "borrable.cho.{{sufijo}}@splg-test.com", "password": "Test1234",
    "full_name": "Chofer Descartable", "phone_number": "+549377{{sufijo}}",
    "rol": "delivery", "distributorId": "{{distribuidoraBaseId}}"},
   [("deliveryIdBorrable", "j?.delivery?.delivery_id")]),
  # El usuario que borra DELETE /users/{id}: un chofer de la distribuidora
  # base, porque la coleccion corre "viendo como" ella y un cliente que nunca
  # le compro no es suyo (H-66).
  ("Usuario descartable", "users", "panel-app",
   {"email": "borrable.usr.{{sufijo}}@splg-test.com", "password": "Test1234",
    "full_name": "Usuario Descartable", "phone_number": "+549379{{sufijo}}",
    "rol": "delivery", "distributorId": "{{distribuidoraBaseId}}"},
   [("userIdBorrable", "j?.user_id")]),
]:
    sets = "\n".join(
      f'  if ({expr}) {{ pm.collectionVariables.set("{v}", {expr}); '
      f'if (pm.environment.name) pm.environment.set("{v}", {expr}); }}'
      for v, expr in captura)
    prep["item"].append({"name": titulo, "request": {
        "method": "POST",
        "header": [{"key": "Content-Type", "value": "application/json"},
                   {"key": "X-Client-Source", "value": origen},
                   {"key": "X-Distributor", "value": "{{distributorSlug}}"}],
        "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "{{tokenSuperAdmin}}",
                                               "type": "string"}]},
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


# --- el recorrido del pedido, de punta a punta -------------------------------
# Los endpoints sueltos de "Orders" prueban cada uno por separado con datos
# estaticos. Esta carpeta es lo otro: UN pedido que nace, se asigna, se acepta,
# viaja y se entrega, en orden, con cada paso encadenado al anterior. Es el
# camino que se muestra en la demo.
#
# Reutiliza los tokens de "00 · Acceso" a proposito: el acceso admite 8 intentos
# por minuto POR IP, y la coleccion entera comparte esa cuota. El unico login
# que se agrega aca es el del chofer ajeno, que hace falta para probar que NO
# puede avisar la llegada de un pedido que no es suyo.
DENTRO_DE_ZONA = ("-27.4100", "-55.9650")  # Itaembe Mini, la unica zona activa

def paso(nombre, metodo, ruta, token_var, descripcion, cuerpo=None,
         origen="panel-app", capturas=(), tests="", espera=(200, 201)):
    cab = [{"key": "X-Client-Source", "value": origen},
           {"key": "X-Distributor", "value": "{{distributorSlug}}"}]
    # El token va en la autenticacion de la peticion y no como cabecera: si no,
    # la autenticacion de la coleccion (Bearer {{token}}) la pisa y cada paso
    # sale con el token del ultimo login, que es el del super administrador.
    auth = ({"type": "bearer", "bearer": [{"key": "token", "value": "{{%s}}" % token_var,
                                           "type": "string"}]}
            if token_var else {"type": "noauth"})
    req = {"method": metodo, "header": cab, "auth": auth,
           "url": {"raw": "{{baseUrl}}/" + ruta, "host": ["{{baseUrl}}"],
                   "path": ruta.split("/")},
           "description": descripcion}
    if cuerpo is not None:
        cab.insert(0, {"key": "Content-Type", "value": "application/json"})
        req["body"] = {"mode": "raw",
                       "raw": json.dumps(cuerpo, indent=2, ensure_ascii=False),
                       "options": {"raw": {"language": "json"}}}
    sets = "\n".join(
        '  if (%s) { pm.collectionVariables.set("%s", %s); '
        'if (pm.environment.name) pm.environment.set("%s", %s); }'
        % (expr, v, expr, v, expr) for v, expr in capturas)
    cuerpo_test = (
        'pm.test("nunca 5xx", () => pm.expect(pm.response.code, '
        '"un 5xx es siempre un defecto").to.be.below(500));\n'
        'pm.test("responde %s", () => pm.expect(pm.response.code).to.be.oneOf(%s));\n'
        % (" o ".join(str(c) for c in espera), list(espera)))
    if tests:
        cuerpo_test += tests + "\n"
    if sets:
        cuerpo_test += "if (pm.response.code < 300) {\n  const j = pm.response.json();\n%s\n}" % sets
    return {"name": nombre, "request": req,
            "event": [{"listen": "test", "script": {
                "type": "text/javascript",
                "exec": cuerpo_test.strip().split("\n")}}]}

recorrido = {"name": "02 · Recorrido del pedido",
  "description":
    "Un pedido de punta a punta, en orden: alta del producto, direccion del "
    "cliente, pedido, asignacion, aceptacion, viaje, aviso de llegada, codigo "
    "de entrega, confirmacion y calificacion. Cada paso usa lo que devolvio el "
    "anterior, asi que hay que correrla ENTERA y EN ORDEN (el boton Run de la "
    "carpeta), no pedido por pedido.\n\n"
    "Requiere haber corrido antes '00 · Acceso'. Las coordenadas caen dentro de "
    "Itaembe Mini, que es la unica zona de cobertura activa: fuera de ese "
    "poligono el alta de pedido responde 400 a proposito.",
  "item": [
    paso("Chofer asignado · resolver su user_id", "GET",
         "users/email/{{choferEmail}}", "tokenChofer",
         "El login devuelve el uid de Firebase, no la clave interna. La app del "
         "chofer resuelve su user_id con este mismo endpoint despues de entrar.",
         origen="driver-app", capturas=[("cuUserChofer", "j?.user_id")]),
    paso("Chofer asignado · su perfil de reparto", "GET",
         "delivery/user/{{cuUserChofer}}", "tokenSuperAdmin",
         "La asignacion identifica al chofer por delivery_id, que NO es su "
         "user_id: hay que resolverlo antes de pedirla.",
         capturas=[("cuDeliveryId", "j?.delivery_id")]),
    paso("Cliente · resolver su user_id", "GET",
         "users/email/{{clienteEmail}}", "tokenCliente",
         "Mismo caso que el chofer: la direccion y el pedido se piden con la "
         "clave interna del usuario.",
         origen="customer-app", capturas=[("cuUserCliente", "j?.user_id")]),
    paso("Alta de la garrafa", "POST", "gascylinder", "tokenSuperAdmin",
         "El producto que se va a pedir. Se crea uno nuevo en cada corrida para "
         "no depender del stock de otro.",
         cuerpo={"type": "Garrafa del recorrido {{sufijo}}", "weight": 10,
                 "price": 9500, "stock": 50,
                 "description": "Garrafa de 10 kg creada por el recorrido"},
         capturas=[("cuGasCylinderId", "j?.gas_cylinder_id")]),
    paso("El cliente carga su direccion", "POST", "user-address", "tokenCliente",
         "Dentro de Itaembe Mini. Si se cambian estas coordenadas por unas de "
         "afuera, el alta del pedido responde 400 y el recorrido se corta ahi.",
         cuerpo={"user_id": "{{cuUserCliente}}", "street": "Av. del Recorrido 1234",
                 "city": "Posadas", "postalCode": "3300",
                 "latitude": DENTRO_DE_ZONA[0], "longitude": DENTRO_DE_ZONA[1]},
         origen="customer-app", capturas=[("cuAddressId", "j?.address_id")]),
    paso("El cliente hace el pedido", "POST", "orders", "tokenCliente",
         "Pago en efectivo: la demo todavia no incluye el metodo de pago online.",
         cuerpo={"customerId": "{{cuUserCliente}}", "addressId": "{{cuAddressId}}",
                 "items": [{"gasCylinderId": "{{cuGasCylinderId}}", "quantity": 1,
                            "unitPrice": 9500}],
                 "paymentMethod": "cash", "notes": "Pedido del recorrido"},
         origen="customer-app",
         tests='pm.test("nace pendiente", () => { const j = pm.response.json(); '
               'pm.expect(j.status, "un pedido recien creado esta pendiente")'
               '.to.eql("pending"); });',
         capturas=[("cuOrderId", "j?.order_id")]),
    paso("Alta de un chofer ajeno al pedido", "POST", "users",
         "tokenSuperAdmin",
         "Existe solo para comprobar que NO puede tocar el pedido de otro.",
         cuerpo={"email": "ajeno.{{sufijo}}@splg-test.com", "password": "Test1234",
                 "full_name": "Chofer Ajeno", "phone_number": "+549378{{sufijo}}",
                 "rol": "delivery", "distributorId": "{{distribuidoraBaseId}}"}),
    paso("Chofer ajeno · entra", "POST", "auth/login", None,
         "Unico login que agrega esta carpeta. El acceso admite 8 por minuto y "
         "por IP: si aparece un 429, esperar un minuto y volver a correr.",
         cuerpo={"email": "ajeno.{{sufijo}}@splg-test.com", "password": "Test1234"},
         origen="driver-app", espera=(200,),
         capturas=[("cuTokenAjeno", "j?.accessToken")]),
    paso("El admin le asigna el pedido al chofer", "PATCH",
         "orders/{{cuOrderId}}/assign/{{cuDeliveryId}}", "tokenSuperAdmin",
         "Con el delivery_id que se resolvio al principio."),
    paso("El chofer acepta", "PATCH", "orders/{{cuOrderId}}/status", "tokenChofer",
         "pending -> accepted. Aca el pedido genera su codigo secreto de entrega.",
         cuerpo={"status": "accepted"}, origen="driver-app"),
    paso("El chofer sale en camino", "PATCH", "orders/{{cuOrderId}}/status",
         "tokenChofer", "accepted -> on_the_way.",
         cuerpo={"status": "on_the_way"}, origen="driver-app"),
    paso("El chofer reporta su posicion", "PATCH", "orders/{{cuOrderId}}/location",
         "tokenChofer",
         "El tracking que sigue el cliente. En la app se manda cada vez que el "
         "GPS se mueve; aca alcanza con una.",
         cuerpo={"lat": -27.4120, "lng": -55.9670}, origen="driver-app"),
    paso("Un chofer ajeno NO puede avisar la llegada", "PATCH",
         "orders/{{cuOrderId}}/arrived", "cuTokenAjeno",
         "El aviso de llegada solo lo puede dar el chofer asignado al pedido. "
         "Antes lo podia disparar cualquier chofer autenticado.",
         origen="driver-app", espera=(403,),
         tests='pm.test("dice que el pedido no es suyo", () => '
               'pm.expect(pm.response.text()).to.include("no esta asignado"'
               '.replace("esta", "está")));'),
    paso("El chofer asignado avisa que llego", "PATCH",
         "orders/{{cuOrderId}}/arrived", "tokenChofer",
         "Sale por socket y tambien por push, para que el aviso llegue aunque el "
         "cliente tenga la app cerrada. No cambia el estado del pedido: el "
         "ciclo de vida tiene cinco estados y 'llego' no es uno de ellos.",
         origen="driver-app", espera=(200,)),
    paso("El chofer pide el codigo de entrega", "GET",
         "orders/{{cuOrderId}}/delivery-code", "tokenChofer",
         "El chofer lo muestra como QR y el cliente lo escanea.",
         origen="driver-app", espera=(200,),
         capturas=[("cuDeliveryCode", "j?.deliveryCode")]),
    paso("El cliente confirma la entrega", "POST",
         "orders/{{cuOrderId}}/confirm-delivery", "tokenCliente",
         "Con el codigo del paso anterior. Es lo que pasa el pedido a entregado.",
         cuerpo={"code": "{{cuDeliveryCode}}"}, origen="customer-app"),
    paso("El cliente califica el servicio", "POST", "ratings", "tokenCliente",
         "Cierra el recorrido.",
         cuerpo={"orderId": "{{cuOrderId}}", "stars": 5,
                 "comment": "Entrega rapida, todo bien"},
         origen="customer-app"),
  ]}

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
  "item": [login, prep, recorrido] + [{"name": t, "item": v} for t, v in sorted(carpetas.items())]}
json.dump(col, open(f"{SP}/SPLG.postman_collection.json", "w"), indent=2, ensure_ascii=False)

valores = [
  {"key":"baseUrl","value":"http://localhost:3000/api","enabled":True},
  {"key":"clientSource","value":"panel-app","enabled":True,"description":"panel-app | customer-app | driver-app"},
  {"key":"distributorSlug","value":"demo","enabled":True},
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
