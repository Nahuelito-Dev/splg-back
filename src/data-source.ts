import 'dotenv/config';
import { DataSource } from 'typeorm';

/**
 * DataSource para el CLI de TypeORM (migraciones). La app en runtime usa la
 * config de `app.module.ts` (forRootAsync + ConfigService); esta es SOLO para
 * `migration:generate/run/revert`. Lee las mismas env vars del `.env`.
 *
 * El esquema en prod se gestiona con migraciones (synchronize:false); en dev se
 * puede seguir usando DB_SYNC=true para iterar rápido, pero las migraciones son
 * la fuente de verdad.
 */
const isSsl = process.env.DB_SSL === 'true';

export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: isSsl ? { rejectUnauthorized: false } : false,
  extra: {
    application_name: 'splg-migraciones',
    ...(isSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  },
  // Relativo a este archivo: sirve igual desde src/ (ts-node) que desde dist/ (la imagen
  // del servidor, donde no hay src/).
  entities: [`${__dirname}/**/*.entity{.ts,.js}`],
  migrations: [`${__dirname}/migrations/*{.ts,.js}`],
  synchronize: false,
  // Cada migración en su propia transacción: un valor nuevo de un enum no se puede usar
  // en la misma transacción que lo agrega, y una instalación desde cero lo necesita.
  migrationsTransactionMode: 'each',
});
