# Pedidos, cobros, cotización, historial y rutas

Contratos del back que consumen el panel y las apps. Todo está también en Swagger
(`/docs`).

## Documentación de la API

`/docs`, `/docs-json` y `/docs-yaml` van detrás de la misma Basic Auth
(`SWAGGER_USER` / `SWAGGER_PASSWORD`). Con `NODE_ENV=production` y sin esas variables la
documentación **no se sirve**; fuera de producción y sin credenciales queda abierta y el
back avisa en el log. Código: `src/common/config/documentacion.ts`.

## Quién lee qué (accesos del chofer)

| Endpoint                           | Chofer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /orders/:id`                  | Sólo si el pedido es **suyo** (asignado), si tiene una **oferta de despacho vigente** para él, o si está en el **pool** que ve en `GET /orders/available` (pendiente, sin chofer, de su distribuidora, y con la carga del día en regla). Cualquier otro: **404**, como si no existiera. Si el chofer **tuvo** el pedido (lo aceptó o se lo asignaron) y ya no es suyo —lo liberó el admin, lo reasignaron o el control de carga lo sacó del pool—: **410** `Este pedido ya no está asignado a tu usuario`, sin datos del pedido, para que la app salga de la pantalla en vez de quedarse con el estado viejo. |
| `GET /orders/customer/:customerId` | **403**. El chofer lista lo suyo con `GET /orders/delivery/:deliveryId`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Distribuidora obligatoria en las escrituras

El admin y el chofer traen su distribuidora del perfil. El **super admin** y el cliente la
mandan con `X-Distributor`. Todas las escrituras de pedidos, cobros, incidencias, reclamos y
adjuntos exigen distribuidora: el super admin sin el header recibe **400**
`Falta la distribuidora: enviá el header X-Distributor (slug o id)`. El cliente sin header
sigue funcionando en lo que abre (crear, cancelar o confirmar **lo suyo**; el dueño lo
controla el caso de uso). Los locks del pedido en los cobros y en la asignación manual
filtran por `distributor_id`: un pedido de otra distribuidora es 404.

Se revisaron, en este cambio, `POST /orders`, `PATCH /orders/:id` (+ `status`, `cancel`,
`assign`, `location`, `arrived`, `confirm-deposit`), `DELETE /orders/:id`,
`POST /orders/:id/reject`, `POST /orders/:id/confirm-delivery`, todos los
`/orders/:id/payment/*`, `POST|PATCH|PUT|DELETE /incidents*`, `POST|PATCH|DELETE /claims*`
(foto incluida), y las escrituras por UUID de otros módulos que el super admin podía
ejecutar sin distribuidora: `PATCH /delivery/:id` (+ `balance`, `invalidate`, `validate`,
`status`, `location`, `availability`), `DELETE /delivery/:id`, `PATCH|DELETE /customers/:id`,
`PUT|DELETE /car/:id/photo`. La lista completa está fijada en
`src/common/decorators/tenant-en-escrituras.spec.ts`.

**Excepción por destino** (`PATCH /users/:id`, `PATCH /users/:id/block`, `DELETE /users/:id`,
`PUT|DELETE /users/:id/photo`, `PATCH|DELETE /admin/:id`): el super admin sin `X-Distributor`
recibe **400** si la cuenta de destino es del personal de una distribuidora (chofer o admin de
empresa). Sobre otro **super admin** (no es de ninguna distribuidora) o un **cliente** (puede
comprarle a varias; lo administra el administrador general, H-66/H-73) opera sin header. Con el
header, la cuenta tiene que ser de esa distribuidora (404 si no). Cubierto por
`users.controller.tenant.spec.ts` y `admin.controller.tenant.spec.ts`.

`attachments`, `fleet-tasks`, `employee` y `cylinder` ya la exigían.
`stock`, `purchase` y `truck-load` los revisa otra tanda.

## Idempotencia (`Idempotency-Key`)

El alcance de la clave es **usuario + distribuidora + método + ruta + parámetros**: un super
admin que cambia de `X-Distributor` con la misma clave ejecuta de nuevo. En un multipart, el
archivo entra en la huella (otra imagen con la misma clave: 422). Una entrada de caché
corrupta se descarta y la operación se ejecuta. El lock de la clave se renueva solo mientras
corre el handler. Si la operación pasa los 120 s responde **503** (antes 500).

Son idempotentes (aceptan la clave): `POST /orders`, `PATCH /orders/:id/status|cancel|
assign/:deliveryId|confirm-deposit`, `POST /orders/:id/reject|confirm-delivery`, todos los
`/orders/:id/payment/*`, `POST /incidents`, `POST /claims`, `POST /claims/:id/photo`,
`POST /attachments/:ownerType/:ownerId`, `POST /fleet-tasks`, `POST /fleet-tasks/:id/attachments`,
`POST /user-address`, `POST /cylinder/assign`, `POST /employee/:id/termination` y
`/reinstatement`. Las apps deben mandar la clave en cada reintento.

Si falla algo **después** del commit (relectura del pedido, aviso al panel, checkout), la
operación no devuelve error: responde con lo ya confirmado, así el reintento con la misma clave
no duplica.

## Cobros manuales del administrador

Todos con `reason` obligatorio (10 a 500 caracteres), idempotentes y auditados. Se registran
en `order_status_history` como una fila de mismo estado de origen y destino con el motivo.

| Endpoint                                                            | Qué hace                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATCH /orders/:id/payment/register-cash` `{ reason }`              | Efectivo entregado con pago `pending` → `paid`. `paymentConfirmedBy` es el admin; el motivo queda en `paymentResolutionNote`. 409 si ya es impago.                                                                                                                                                                                                                                                              |
| `PATCH /orders/:id/payment/register-unpaid` `{ reason }`            | Lo mismo que el aviso del chofer: pago `unpaid` + **una** incidencia `unpaid_collection` (reportada por el admin). Responde como `PATCH .../unpaid`.                                                                                                                                                                                                                                                            |
| `PATCH /orders/:id/payment/confirm-transfer` `{ received, reason }` | Pedido `transfer`, no cancelado. `received: true` → `paid` (recién ahí cuenta como venta), desde `pending` **o desde `failed`** (la transferencia llegó después de marcarla no recibida: se corrige con motivo). `received: false` → `failed`, sólo desde `pending` y **sólo sobre un pedido entregado** (409 si no lo está: marcarla antes no frenaría nada). Repetir lo mismo: no-op; `paid` → `failed`: 409. |

**Transferencia confirmada y pedido cancelado después.** La cancelación no se bloquea (el cliente
o el admin pueden cancelar un pedido todavía no entregado), pero el dinero ya está en la
distribuidora: `GET /reports/collections` lo informa en `pendingRefund` (pedidos `cancelled` con
pago `paid`, por fecha de última modificación) y el pedido sigue con `paymentStatus: paid`.
**El sistema no gestiona el reintegro**: lo hace la distribuidora por fuera y el panel debe
mostrarlo como "reintegro pendiente".

Una transferencia sin confirmar **no suma a las ventas**: `GET /reports/collections` ahora trae
`pendingTransfer` y `notReceivedTransfer` junto a `pendingCash`, `unpaid` y `writtenOff`.

La incidencia de cobro impago **se cierra sólo con `resolve-unpaid`**: por
`PATCH /incidents/:id/resolve` (resuelta o descartada) responde 409 mientras el pedido siga
`unpaid`. El cierre y la edición de una incidencia son un `UPDATE` condicional a `open`: si
otro la cerró en paralelo, 409 y no se pisa su resolución.

## Historial de estados

`order_status_history` registra **toda** transición del pedido (incluido el alta,
`from_status = null`), en la misma transacción que el cambio: quién (el usuario del request;
`null` si lo hizo el sistema: cron, webhook), cuándo, desde, hasta y el motivo si lo hay
(cancelación o entrega manual). Lo asienta `OrderStatusHistorySubscriber`, que escucha los
`save` del pedido; las transiciones pasan por `transitionOrder`, así ningún caso de uso puede
olvidarse. **No hay backfill:** los pedidos anteriores a este cambio no tienen el historial de
sus transiciones pasadas; el historial empieza el día que se despliega.

**Filas de anotación.** Los cobros manuales (`register-cash`, `register-unpaid`,
`confirm-transfer`) no cambian el estado del pedido, pero dejan su motivo en el historial como
una fila con `from_status = to_status` (p. ej. `delivered → delivered`) y el texto en `reason`
(`Transferencia confirmada por un administrador: …`). No son una transición: quien muestre la
línea de tiempo del pedido tiene que distinguirlas (origen = destino) y mostrarlas como una
nota, no como un cambio de estado.

**Respuesta incompleta.** Si un cobro, un alta o una asignación ya se confirmaron pero falla
la relectura del pedido, el back responde 2xx con lo que tiene y la `Idempotency-Key` guarda esa
respuesta **5 minutos** en vez de 24 h: cubre el reintento inmediato (no repite la operación) y
no deja un pedido a medias como "la respuesta" de esa clave.

## Cotización — `POST /orders/quote`

Mismo cuerpo que `POST /orders`; sólo `items` y `paymentMethod` son obligatorios. Con `addressId`
(el admin además manda `customerId`) incluye el recargo de la zona. Respuesta `200`:

```json
{
  "items": [
    {
      "gasCylinderId": "…",
      "title": "Garrafa 10kg",
      "quantity": 3,
      "unitPrice": 8500,
      "subtotal": 25500
    }
  ],
  "subtotal": 25500,
  "zone": {
    "coverageZoneId": "…",
    "name": "Centro",
    "type": "fixed",
    "value": 0,
    "amount": 0
  },
  "zoneSurcharge": 0,
  "paymentMethod": "transfer",
  "paymentSurcharge": 2550,
  "deposit": 0,
  "total": 28050,
  "balance": 28050
}
```

`paymentSurcharge` es el +10% de `mercadopago` y `transfer` sobre **subtotal + recargo de zona**
(0 en `cash`). `total` es el del pedido que se crea con el mismo cuerpo; `balance = total −
deposit`. Usa las mismas funciones que el alta (`valorizarRenglon`, `resolverZona`,
`calcularTotales`); no escribe nada ni reserva stock, pero rechaza lo que el alta rechazaría
(otra distribuidora —se valida antes que el stock—, sin stock, franja inválida, fuera de cobertura, y la misma garrafa en dos renglones: 400, igual que `POST /orders`). Roles: cliente (para sí), admin, super admin.

## El chofer en el pedido — `GET /orders/:id`

Para el **cliente dueño** y el **admin**, mientras el pedido está `accepted` o
`out_for_delivery` y tiene chofer:

```json
"driver": { "userId": "…", "fullName": "Ana Gómez", "phoneNumber": "+54911…", "ratingAverage": 4.8, "ratingCount": 37 }
```

Con el pedido cerrado, sin chofer, o visto por el propio chofer, `driver` es `null` (el teléfono
no se expone). Sólo viene en la lectura individual, no en los listados. La patente está en
`vehicle.patent` (snapshot al aceptar). Las calificaciones ocultas no cuentan.

`driver.location` es la **última ubicación conocida**: `{ "lat": -34.61, "lng": -58.40, "at":
"2026-10-12T20:15:00.000Z" }`. Es más sensible que el nombre o el teléfono, así que tiene reglas
más estrictas:

- **Sólo con el pedido `out_for_delivery`** y siendo **ese** el pedido activo del chofer (el que
  lleva en el radar). Con el pedido `accepted` el chofer puede estar entregando otro y su
  posición no es de este cliente: `location` es `null` (el teléfono sí viene desde `accepted`).
- **Sólo si es reciente**: la hora (`at`) no puede tener más de `DRIVER_LOCATION_MAX_AGE_MIN`
  minutos (10 por defecto). Una posición más vieja, o sin hora anotada (anterior al despliegue),
  no se devuelve: `location` es `null`. El cliente debe tratar `null` como "sin posición
  reciente", no como error.
- Si el radar (Redis) no responde, el pedido se lee igual y `location` es `null`.

Sale del radar de despacho (Redis GEO), el mismo que alimenta el chofer por socket
(`driver:update-location`) o por `PATCH /orders/:id/location`; no hay tabla nueva. La hora se
anota aparte en Redis (`driver:location-at:<userId>`, 24 h). Con el pedido cerrado no se expone.
Sirve para redibujar la camioneta si se cae el socket.

## Quién canceló — `cancelledBy`

`GET /orders/:id` trae `cancelledBy` (`customer` · `admin` · `driver` · `system`, o `null` si el
pedido no está cancelado o es anterior al historial) y el evento de socket `order:cancelled`
lleva el mismo campo. Se saca de `order_status_history`: el rol del usuario que hizo la última
transición a `cancelled` (el super admin cuenta como `admin`); sin usuario (vencimiento de pago,
cron) es `system`, que sólo se ve al leer el pedido: el evento `order:cancelled` no se emite
en esos casos y lleva `customer` o `admin`. Un chofer que "cancela" no cancela: libera el pedido a `pending`
(`order:searching-driver`), por eso `driver` sólo aparece si un pedido lo cancela un usuario con
rol chofer por otra vía.

## Eventos de socket que recibe el cliente

| Evento                   | Cuándo                                                                                                                                                                  | Payload                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `order:accepted`         | un chofer acepta, o el admin asigna                                                                                                                                     | `{ orderId, status: "accepted", updatedAt, paymentStatus, driver: { name, phone, photoUrl } \| null }` |
| `order:on-the-way`       | el chofer sale                                                                                                                                                          | igual que `order:accepted`, con `status: "on_the_way"`                                                 |
| `order:arrived`          | el chofer avisa que llegó                                                                                                                                               | `{ orderId, message, driverName }`                                                                     |
| `order:delivered`        | se entrega                                                                                                                                                              | igual que `order:accepted`, con `status: "delivered"`                                                  |
| `order:cancelled`        | cancela el cliente o un admin (los vencimientos automáticos —pago, reserva— **no** emiten el evento: el cliente se entera al leer el pedido, con `cancelledBy: system`) | `{ orderId, status: "cancelled", reason, cancelledBy }`                                                |
| `order:searching-driver` | el chofer libera el pedido y vuelve a buscarse                                                                                                                          | `{ orderId, status: "pending" }`                                                                       |
| `order:driver-location`  | cada posición del chofer mientras el pedido está en camino                                                                                                              | `{ orderId, driverId, lat, lng, at }`                                                                  |
| `order:updated`          | un admin edita el pedido y cambia el total                                                                                                                              | `{ orderId, totalAmount, previousTotalAmount }`                                                        |
| `order:payment-approved` | MercadoPago aprueba el pago o la seña                                                                                                                                   | `{ orderId, tipo: "deposit" \| "payment", paymentStatus, updatedAt }`                                  |

`reason` de `order:cancelled` es el motivo que se dio, o `Cancelado por <rol>` si no hubo.
`status` viaja con el valor del enum (`on_the_way`), no con el `out_for_delivery` del REST.

## Aceptar un pedido y volver con el camión

La aceptación del chofer (`PATCH /orders/:id/status` → `accepted`) y la asignación manual
(`PATCH /orders/:id/assign/:deliveryId`) toman `FOR SHARE` sobre la carga abierta del chofer
**dentro de su transacción**, antes de leer su estado (`TruckLoadGatePort`, con el `manager`);
la vuelta del camión (`PATCH /truck-loads/:id/return`) la toma `FOR UPDATE`. Si pasan a la vez,
una espera a la otra: o la aceptación termina antes (y la vuelta ve el pedido en curso y responde 409) o la vuelta termina antes (y la aceptación ve la carga `returned` y responde 400). Nunca queda
un pedido aceptado sobre una carga devuelta. Orden de locks: pedido → chofer → carga (compartido).

## Un solo reloj

`acceptedAt`, `onTheWayAt` y `deliveredAt` del pedido se toman con `clock_timestamp()` de la base
(`src/common/utils/ahora-de-la-base.ts`), en la transacción del cambio de estado, igual que
`opened_at` / `closed_at` de la carga del camión: los dos módulos comparan momentos del mismo
reloj. Los cobros (`paymentConfirmedAt`, `paymentResolvedAt`) y las fechas de las ofertas de
despacho siguen con el reloj de Node: no se comparan contra la carga.

## Rutas por calles — `GET /routes/driving?orderId=<uuid>[&from=lat,lng]`

La ruta es **de un pedido**, no un trazador de mapas abierto: el destino es siempre la dirección
de entrega del pedido y el origen la última posición reciente del chofer (la hora de la posición
no puede tener más de `DRIVER_LOCATION_MAX_AGE_MIN`; si no hay, 409). `from` es opcional y se
acepta sólo a menos de `ROUTES_FROM_MAX_DISTANCE_M` (300 m) de esa posición (400 si no).

| Quién              | Cuándo                                                                               | Si no                                 |
| ------------------ | ------------------------------------------------------------------------------------ | ------------------------------------- |
| Chofer asignado    | pedido `accepted` u `on_the_way`                                                     | pedido de otro: 404; otro estado: 403 |
| Cliente dueño      | pedido `on_the_way` y el pedido que el chofer lleva (su posición no se expone antes) | 404 / 403                             |
| Admin, super admin | no piden rutas                                                                       | 404                                   |

**Cupos** (429): 30 pedidos por minuto y usuario; y, por cada consulta que llega al proveedor
(la caché de 60 s por origen y destino redondeados a 4 decimales no cuenta), 100 por usuario y
3000 por distribuidora cada 24 h (`ROUTES_DAILY_LIMIT_PER_USER`,
`ROUTES_DAILY_LIMIT_PER_DISTRIBUTOR`). Con Redis caído no hay 500: los cupos se cuentan en
memoria de cada proceso, no hay caché y, sin radar, el chofer (sólo él) puede mandar su propio
`from`; el cliente recibe 409.

**Proveedor**: Google Directions con `GOOGLE_DIRECTIONS_API_KEY` (clave **del servidor**,
restringida por IP, no la de las apps). Sin clave, o si Google falla, OSRM propio
(`OSRM_BASE_URL`); el OSRM público sólo se usa con `NODE_ENV=development` o `test`: en producción
sin ninguno de los dos, 503. Si el proveedor no responde: 502.

**Costo y alerta en Google** (a configurar en la consola, el back no lo puede hacer): fijar una
cuota diaria del API Directions en Google Cloud (Cuotas y límites de la API) igual o apenas mayor
a la suma esperada de los topes por distribuidora, y una alerta de presupuesto
(Facturación → Presupuestos y alertas) al 50 %, 90 % y 100 % del gasto mensual previsto. Los
topes del back acotan a un usuario o a una distribuidora; la cuota de Google es la última línea.

```json
{
  "provider": "osrm",
  "distanceMeters": 4621,
  "durationSeconds": 465,
  "encodedPolyline": "loerE`ticJ…",
  "points": [{ "lat": -34.60371, "lng": -58.38161 }]
}
```

`encodedPolyline` es el formato de Google (precisión 5); `points` es la misma ruta decodificada.
