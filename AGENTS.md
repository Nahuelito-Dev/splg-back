# splg-app-backend

API de SPLG. NestJS 11 + TypeORM + Postgres/PostGIS + Redis + Firebase Auth + Socket.IO.
Mapa del sistema y reglas del workspace: `../AGENTS.md`.

<!-- orq:gate: npm run verify -->

## Comandos

| Para | Comando |
|---|---|
| Gate completo (lo que tiene que quedar verde) | `npm run verify` — tipos, lint (con reglas de Jest), unit tests con piso de cobertura por módulo y build (ver `CONVENCIONES.md` §11) |
| Levantar en desarrollo | `../splg-dev.sh` (infra + back :3000 + panel :3001) o `npm run start:dev` |
| Unit tests | `npm test` (Jest, `src/**/*.spec.ts`) |
| Integración con testcontainers (no se corre en el flujo de trabajo: la prueba es contra la API sobre `splg_db` y `splg-redis`) | `npm run test:integration` |
| Migraciones | `npm run migration:generate -- src/migrations/<Nombre>` · `npm run migration:run` |
| Seeds | `npm run seed` (roles, distribuidora, usuarios con Firebase) · `npm run seed:demo` |
| Archivos (Amazon S3; los e2e usan un MinIO efímero con testcontainers) | `splg-docs/sistema/back/S3.md` |
| Pedidos, cobros, cotización, historial, rutas e informes con totales (v2) | `splg-docs/sistema/back/PEDIDOS.md` |
| Parámetros del despacho y frecuencia de tareas programadas (M1) | `splg-docs/sistema/back/PARAMETROS-DESPACHO.md` |
| Vigencia de envases, revisiones y bloqueo del despacho (C-11) | `splg-docs/sistema/back/VIGENCIA-ENVASES.md` |
| Carrito persistente y consumo declarado (C-12 y C-13) | `splg-docs/sistema/back/CARRITO-Y-CONSUMO.md` |
| Parámetros de los procesos automáticos (CU-172) y zonas de cobertura vencidas (CU-151) | `splg-docs/sistema/back/PROCESOS-AUTOMATICOS.md` |
| Productos dados de baja y reactivación (CU-268, CU-269) | `splg-docs/sistema/back/CATALOGO.md` |
| Personal: documentación, asistencia, licencias, tablero y habilitación laboral (C-08) | `splg-docs/sistema/back/PERSONAL.md` |
| Compra express, despacho a motos y reintegro de pagos (C-17) | `splg-docs/sistema/back/EXPRESS-REINTEGROS.md` |
| Reglas en la base (CHECK, únicos, exclusiones, FK) y su verificación | `splg-docs/sistema/back/VALIDACIONES-BASE.md` |
| Transacciones, locks, triggers de la base y operaciones con servicios externos | `splg-docs/sistema/back/TRANSACCIONES.md` |
| Versiones de la API | Rutas en `/api/v1/...` (y `/api/...` sin número, por compatibilidad). La v1 quedó congelada el 24/10/2026: un endpoint nuevo o con contrato cambiado va con `@Version('2')` en `/api/v2/...`; los arreglos sin cambio de contrato siguen en v1. Swagger lista sólo la forma versionada. |
| OpenAPI | `GET /docs-json` y `GET /docs-yaml` (basic auth `SWAGGER_USER` / `SWAGGER_PASSWORD` del `.env`; con `NODE_ENV=production` y sin credenciales la documentación no se sirve) |

## Documentación

La documentación técnica del back (pedidos, stock, finanzas, validaciones, S3, demo, Postman…)
vive en `splg-docs/sistema/back/`, no en este repo. Un cambio de contrato o de regla se documenta
ahí en la misma tanda (rama en `splg-docs`).

## Convenciones

**`CONVENCIONES.md` manda** (está en `splg-docs/sistema/back/CONVENCIONES.md`): TypeScript estricto sin `any`, nombres, las dos plantillas de
módulo (soporte vs núcleo), DTOs de salida, errores, tests. Leelo antes de crear un módulo.

Lo que más se rompe:

- Nunca `synchronize`: todo cambio de esquema va con migración generada y revisada.
- Todo lo que lee o escribe datos de una distribuidora filtra por el tenant (`X-Distributor`).
  Un endpoint sin aislamiento es un bug de seguridad (hallazgos H-77..H-84).
- Endpoints existentes conservan las claves del JSON; los nuevos van en camelCase.
- Cambio de contrato ⇒ Swagger completo (los campos con `default` no son obligatorios),
  y el panel se actualiza con `npm run api:types`.
- La auditoría de datos (`audit`, `audit_detail`) la escriben triggers de la base (`TRG_auditoria`), no la
  aplicación. Una entidad o columna nueva: `npm run auditoria:mapa -- --migracion <Nombre>`, revisar la migración
  y correrla; el test `auditoria-mapa.spec.ts` falla si el mapa quedó viejo. El actor lo fija `ActorEnLaBase` por
  transacción. `AuditoriaDeDatos.registrar` es sólo para hechos que no son una columna.
- Transiciones de pedido y de envase pasan por las máquinas de estado del dominio, no por
  un `update` directo.

## Cómo se da por hecho

Además de `npm run verify`: el endpoint se prueba contra la API corriendo (curl o la
colección), incluido el caso de error y el de otro tenant. Ver `~/.claude/orquesta/DOD.md`.

**Ojo con la colección de Postman/newman completa**: trae un `DELETE /distributor` que da de
baja a la distribuidora sembrada.
