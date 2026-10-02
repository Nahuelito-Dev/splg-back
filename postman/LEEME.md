# Colección de Postman de SPLG

**459 peticiones sobre los 151 endpoints** (incluye `fleet/plans`,
`fleet/tasks`, `fleet/expirations`, las fachadas de documentos de vehículo y
chofer, y "Fleet · Vehicle in use": qué vehículo usa cada chofer, con
historial). Cada endpoint tiene su caso correcto y sus casos de fallo, cada uno
con el test que corresponde.

Tres endpoints de flota quedan afuera del generador automático: subir un
adjunto (`POST /fleet/tasks/{id}/attachments`) y sus dos rutas que dependen de
un adjunto real (`GET .../download`, `DELETE .../{attachmentId}`). El
generador arma cuerpos JSON; multipart con un archivo real no entra en ese
esquema. Se probaron a mano contra la API (ver el informe de la tarea de
flota): subida de PDF, descarga con contenido idéntico al original, rechazo
por tipo de archivo (415) y por tamaño (413), y borrado.

Corrida completa con newman, incluyendo lo de arriba: **cero fallos en las
carpetas de Fleet.** El resto de la colección puede tener fallos propios de
otros módulos, documentados más abajo o dependientes del estado de los datos
de la base en el momento de la corrida.

## Cómo usarla

1. Levantar el entorno: `./splg-dev.sh` desde la raíz de `garrafitas/`.
2. Importar en Postman los dos archivos:
   - `SPLG.postman_collection.json`
   - `SPLG-local.postman_environment.json`
3. Completar las cuatro contraseñas del environment. Son las de siembra y están
   en `splg-dev.sh`; acá se dejan vacías a propósito para no versionarlas.
4. Correr **en orden**: `00 · Acceso`, después `01 · Preparacion`, y recién ahí
   el resto.

Si algún identificador quedó viejo, `./refrescar-ids.sh` relee de la base un
dato vivo de cada entidad y deja el environment al día.

## Las variantes de cada endpoint

| Variante | Qué prueba | Espera |
|---|---|---|
| **1 · correcto** | Datos válidos y el rol que corresponde | 2xx |
| **2 · datos inválidos** | Que el `ValidationPipe` frene antes de tocar la base | 400 |
| **3 · sin token** | Que el `AuthGuard` corte | 401 |
| **3 · público** | Los 15 que **no** exigen token (medido contra la API) | 2xx |
| **4 · id inexistente** | Un UUID con formato válido que no existe | 404 |

Todas validan además que nunca haya un 5xx, que responda en menos de 2 segundos,
que no se filtren `refreshToken`, `apiKey` ni contraseñas, y que los errores
traigan `message` y `statusCode` sin revelar rutas del servidor.

## Las dos carpetas iniciales

**`00 · Acceso`** — los cuatro logins. El panel entra por
`/auth/login/dashboard`, que exige ser administrador; las apps por `/auth/login`.
Cada uno deja su token en su variable (`tokenAdmin`, `tokenSuperAdmin`,
`tokenCliente`, `tokenChofer`) y fija `clientSource` al origen que le
corresponde. **Esto último importa:** el guard compara el rol del token contra
la cabecera `X-Client-Source`, y si no coinciden responde 401.

**`01 · Preparacion`** — crea un cliente, una garrafa y un chofer que existen
sólo para ser borrados. Así las bajas de Customers, Gas Cylinders, Delivery y
Users **no se llevan puesto el dato que usan los demás módulos**.

## Se puede correr muchas veces seguidas

- Las operaciones van en orden CRUD dentro de cada módulo: crear, leer,
  modificar, borrar.
- El `POST` de cada módulo guarda el identificador de lo que creó y el resto del
  módulo opera sobre eso.
- Los borrados que afectarían a otros módulos usan los datos descartables de
  `01 · Preparacion`.
- `DELETE /distributor/{id}` está incluido pero conviene no correrlo suelto:
  deja al sistema sin distribuidora.

## Los 31 tests que fallan a propósito

No son fallas de la colección: **documentan defectos abiertos**. Cuando se
arreglen, pasan solos y sirven de verificación.

| Cuántos | Qué documentan |
|---:|---|
| 12 | **H-31 / H-28** — endpoints sin DTO que aceptan datos inválidos y contestan 2xx |
| 10 | **H-31** — endpoints sin DTO que devuelven 500 en vez de 400 |
| 6 | **H-02** — el login devuelve el `refreshToken` y el `apiKey` de Firebase |
| 3 | **H-37** — crear un usuario con un rol inexistente devuelve 500 |

El detalle de cada uno está en
`splg-docs/material-de-trabajo/HALLAZGOS-2026-09-23.md`.

## Los cuerpos

Los **56 endpoints que reciben cuerpo lo tienen escrito a mano y probado** contra
la API, en `cuerpos.py`. Cada uno trae un `ok` que funciona y un `malo` que debe
ser rechazado.

Once de esos cuerpos **no salen del OpenAPI**: son los endpoints sin DTO, que
Swagger no documenta (H-31). Están escritos leyendo el controlador.

## Precondiciones

Veintidós endpoints dependen del **estado** del dato, no del cuerpo: el pedido
tiene que estar en camino, el envase cargado, la transición ser válida. En esos,
la descripción del request dice qué hace falta para que devuelva 2xx, y el test
acepta el rechazo por regla de negocio como respuesta correcta.

## Regenerarla

    python3 postman/generar-coleccion.py

Necesita, en el mismo directorio: `openapi.json` bajado de `/docs-json`,
`ids.txt` (lo arma `refrescar-ids.sh`), `cuerpos.py` y `publicos.json`.
