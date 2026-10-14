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
| Integración (necesita Postgres y Redis arriba) | `npm run test:integration` |
| Migraciones | `npm run migration:generate -- src/migrations/<Nombre>` · `npm run migration:run` |
| Seeds | `npm run seed` (roles, distribuidora, usuarios con Firebase) · `npm run seed:demo` |
| Archivos (S3 en prod, MinIO en dev: `docker compose up -d minio minio-init`) | `docs/S3.md` |
| Pedidos, cobros, cotización, historial y rutas | `docs/PEDIDOS.md` |
| OpenAPI | `GET /docs-json` y `GET /docs-yaml` (basic auth `SWAGGER_USER` / `SWAGGER_PASSWORD` del `.env`; con `NODE_ENV=production` y sin credenciales la documentación no se sirve) |

## Convenciones

**`CONVENCIONES.md` manda**: TypeScript estricto sin `any`, nombres, las dos plantillas de
módulo (soporte vs núcleo), DTOs de salida, errores, tests. Leelo antes de crear un módulo.

Lo que más se rompe:

- Nunca `synchronize`: todo cambio de esquema va con migración generada y revisada.
- Todo lo que lee o escribe datos de una distribuidora filtra por el tenant (`X-Distributor`).
  Un endpoint sin aislamiento es un bug de seguridad (hallazgos H-77..H-84).
- Endpoints existentes conservan las claves del JSON; los nuevos van en camelCase.
- Cambio de contrato ⇒ Swagger completo (los campos con `default` no son obligatorios),
  y el panel se actualiza con `npm run api:types`.
- Transiciones de pedido y de envase pasan por las máquinas de estado del dominio, no por
  un `update` directo.

## Cómo se da por hecho

Además de `npm run verify`: el endpoint se prueba contra la API corriendo (curl o la
colección), incluido el caso de error y el de otro tenant. Ver `~/.claude/orquesta/DOD.md`.

**Ojo con la colección de Postman/newman completa**: trae un `DELETE /distributor` que da de
baja a la distribuidora sembrada.
