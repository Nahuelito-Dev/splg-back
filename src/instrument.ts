// Sentry se inicializa antes que cualquier otro módulo: así instrumenta Nest,
// Express, `pg` y el resto al cargarse. Va importado PRIMERO en `main.ts`.
import { existsSync } from 'node:fs';
import { iniciarSentry } from './common/config/sentry.config';

// En desarrollo las variables vienen del `.env`, que el `ConfigModule` de Nest
// lee recién al armar la app: sin esto, `SENTRY_DSN` todavía no existe acá y
// Sentry no arranca. No pisa lo que ya está en el entorno (Docker en el
// servidor) y en los tests no se lee, igual que en el `ConfigModule`.
if (process.env.STAGE !== 'test' && existsSync('.env')) {
  process.loadEnvFile('.env');
}

iniciarSentry();
