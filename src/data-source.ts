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
  extra: isSsl ? { ssl: { rejectUnauthorized: false } } : undefined,
  entities: ['src/**/*.entity{.ts,.js}'],
  migrations: ['src/migrations/*{.ts,.js}'],
  synchronize: false,
});
