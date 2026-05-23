/**
 * Test environment bootstrap.
 *
 * Levanta Postgres + Redis efímeros en Docker via testcontainers,
 * inyecta las variables de entorno necesarias y arranca la app NestJS
 * lista para recibir requests via supertest.
 *
 * Cada suite de integración importa `createTestApp()` y obtiene un
 * `INestApplication` aislado. Al final llama `cleanup()` que para
 * contenedores y libera puertos.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { AppModule } from '../../../src/app.module';

export interface TestEnv {
  app: INestApplication;
  pgContainer: StartedPostgreSqlContainer;
  redisContainer: StartedRedisContainer;
  cleanup: () => Promise<void>;
}

export async function createTestApp(): Promise<TestEnv> {
  // 1. Postgres efímero
  const pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('splg_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  // 2. Redis efímero
  const redisContainer = await new RedisContainer('redis:7-alpine').start();

  // 3. Variables de entorno apuntando a los containers
  process.env.DB_HOST = pgContainer.getHost();
  process.env.DB_PORT = String(pgContainer.getPort());
  process.env.DB_USERNAME = pgContainer.getUsername();
  process.env.DB_PASSWORD = pgContainer.getPassword();
  process.env.DB_NAME = pgContainer.getDatabase();
  process.env.DB_SSL = 'false';
  process.env.REDIS_HOST = redisContainer.getHost();
  process.env.REDIS_PORT = String(redisContainer.getPort());
  process.env.STAGE = 'test';
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.PORT = '0'; // puerto random asignado por supertest

  // 4. Arranca NestJS
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  const cleanup = async () => {
    await app.close();
    await redisContainer.stop();
    await pgContainer.stop();
  };

  return { app, pgContainer, redisContainer, cleanup };
}

/**
 * Helper para que cada suite haga un reset rápido de la BD entre tests
 * sin tener que reiniciar el container completo.
 */
export async function truncateAllTables(app: INestApplication): Promise<void> {
  const dataSource = app.get('DataSource' as any);
  const entities = dataSource.entityMetadatas;
  // TRUNCATE CASCADE limpia todas las tablas respetando FKs.
  const tables = entities.map((e: any) => `"${e.tableName}"`).join(', ');
  await dataSource.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE;`);
}
