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
import type { Server } from 'http';
import { HttpAdapterHost } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { GlobalExceptionFilter } from '../../../src/common/filters/global-exception.filter';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { generateKeyPairSync, randomInt, randomUUID } from 'crypto';
import { FirebaseAuthPort } from '../../../src/firebase/ports/firebase-auth.port';
import { Distributor } from '../../../src/distributor/entities/distributor.entity';
import { Role } from '../../../src/role/entities/role.entity';
import { User } from '../../../src/users/entities/user.entity';
import { Customer } from '../../../src/customer/entities/customer.entity';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import {
  AUDIT_ACTION_TYPE_NAMES,
  AuditActionType,
} from '../../../src/audit/entities/audit-action-type.entity';

/** La app NestJS tipada con su servidor HTTP real, para que `getHttpServer()`
 * devuelva algo que `supertest` acepta sin pasar por `any`. */
export type TestApp = INestApplication<Server>;

export interface TestEnv {
  app: TestApp;
  pgContainer: StartedPostgreSqlContainer;
  redisContainer: StartedRedisContainer;
  cleanup: () => Promise<void>;
}

/**
 * Imagen de Postgres con PostGIS (la app crea la extensión). Se puede cambiar
 * con `TEST_POSTGIS_IMAGE`.
 */
const IMAGEN_POSTGIS =
  process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4';

/** Clave privada descartable: Firebase Admin la parsea al iniciar, no la usa. */
function clavePrivadaDescartable(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey.replace(/\n/g, '\\n');
}

/**
 * Teléfono único para los seeds: 10 dígitos al azar (no derivados del sufijo
 * del correo, que tiene pocos dígitos y choca con el UNIQUE de `phone_number`).
 */
export function telefonoDePrueba(): string {
  return `+549${String(randomInt(0, 10_000_000_000)).padStart(10, '0')}`;
}

/**
 * S3 por defecto de las suites que no prueban archivos: la app exige bucket y
 * región para arrancar, y el endpoint apunta a un puerto donde no escucha
 * nadie, así que ningún test llega a AWS por accidente. Las suites que sí
 * suben archivos pasan el entorno de su MinIO (`startMinio().env`).
 */
const S3_SIN_SERVICIO: Record<string, string> = {
  AWS_REGION: 'us-east-1',
  AWS_S3_BUCKET: 'splg-test-sin-s3',
  AWS_ACCESS_KEY_ID: 'sin-s3',
  AWS_SECRET_ACCESS_KEY: 'sin-s3',
  AWS_S3_ENDPOINT: 'http://127.0.0.1:1',
  AWS_S3_FORCE_PATH_STYLE: 'true',
};

export async function createTestApp(
  opciones: { s3?: Record<string, string> } = {},
): Promise<TestEnv> {
  // 1. Postgres (con PostGIS) y Redis efímeros
  const pgContainer = await new PostgreSqlContainer(IMAGEN_POSTGIS)
    .withDatabase('splg_test')
    .withUsername('test')
    .withPassword('test')
    .start();
  const redisContainer = await new RedisContainer('redis:7-alpine').start();

  // 2. El entorno de la app es EXACTAMENTE el de los contenedores. Se pisa
  // todo lo que importa del entorno de desarrollo, y `STAGE=test` hace que
  // `ConfigModule` no lea el `.env` (ver `app.module.ts`).
  Object.assign(process.env, {
    STAGE: 'test',
    NODE_ENV: 'test',
    DB_HOST: pgContainer.getHost(),
    DB_PORT: String(pgContainer.getPort()),
    DB_USERNAME: pgContainer.getUsername(),
    DB_PASSWORD: pgContainer.getPassword(),
    DB_NAME: pgContainer.getDatabase(),
    DB_SSL: 'false',
    DB_SYNC: 'true',
    DB_POOL_SIZE: '40',
    DB_LOGGING: 'false',
    REDIS_HOST: redisContainer.getHost(),
    REDIS_PORT: String(redisContainer.getPort()),
    JWT_SECRET: 'test-secret-do-not-use-in-prod',
    PORT: '0',
    // El proceso de Jest (ts-jest, Nest, testcontainers) pasa el umbral de
    // memoria de producción: no es lo que valida el test de health.
    HEALTH_MEMORY_RSS_THRESHOLD_MB: '4096',
    FIREBASE_PROJECT_ID: 'splg-test',
    FIREBASE_CLIENT_EMAIL: 'test@splg-test.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: clavePrivadaDescartable(),
    ...S3_SIN_SERVICIO,
    ...opciones.s3,
  });

  // 3. Recién ahora se importa la app: `ConfigModule.forRoot` valida el
  // entorno al cargar el módulo, así que tiene que ver el de arriba.
  // `require` y no `import()`: con `module: nodenext` un `import()` dinámico
  // sale como ESM nativo, que Jest no carga.
  const { AppModule } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../../src/app.module') as typeof import('../../../src/app.module');
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<TestApp>();
  // Igual que `main.ts`: los errores de dominio se traducen a HTTP.
  app.useGlobalFilters(
    new GlobalExceptionFilter(app.get(HttpAdapterHost).httpAdapter),
  );
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  const cleanup = async () => {
    await app.close();
    await redisContainer.stop();
    await pgContainer.stop();
  };
  // El token de prueba es el correo del usuario: sin llamar a Firebase.
  jest
    .spyOn(app.get(FirebaseAuthPort), 'verifyIdToken')
    .mockImplementation((token) =>
      Promise.resolve({ email: token, uid: token, sub: token } as never),
    );
  try {
    asegurarBaseDescartable(app.get(DataSource), pgContainer);
    await app.init();
    await sembrarCatalogoDeAuditoria(app.get(DataSource));
    // Escucha en loopback con puerto propio: si no, supertest hace un
    // `listen(0)` por request y a veces le toca un puerto que otro proceso
    // ya usa en 127.0.0.1.
    await app.listen(0, '127.0.0.1');
  } catch (error) {
    await cleanup();
    throw error;
  }

  return { app, pgContainer, redisContainer, cleanup };
}

/**
 * Helper para que cada suite haga un reset rápido de la BD entre tests
 * sin tener que reiniciar el container completo.
 */
const BASE_DE_PRUEBA = 'splg_test';

/**
 * Corta la suite si la app no quedó conectada a la base del contenedor: un
 * error de configuración no puede terminar escribiendo (o vaciando) la base
 * de desarrollo compartida.
 */
function asegurarBaseDescartable(
  dataSource: DataSource,
  contenedor?: StartedPostgreSqlContainer,
): void {
  const opciones = dataSource.options as {
    host?: string;
    port?: number;
    database?: string;
  };
  const base = opciones.database;
  if (base !== BASE_DE_PRUEBA) {
    throw new Error(
      `Los tests de integración tienen que correr contra "${BASE_DE_PRUEBA}" y la app está conectada a "${String(base)}"`,
    );
  }
  if (
    contenedor &&
    (opciones.host !== contenedor.getHost() ||
      Number(opciones.port) !== contenedor.getPort())
  ) {
    throw new Error(
      `La app de test no está conectada al contenedor efímero (${String(opciones.host)}:${String(opciones.port)} en vez de ${contenedor.getHost()}:${contenedor.getPort()})`,
    );
  }
}

/**
 * El catálogo TipoAccionAuditoria lo siembra la migración; con `DB_SYNC` el
 * esquema sale de las entidades y hay que sembrarlo. Sin él, toda auditoría
 * falla por la clave foránea.
 */
async function sembrarCatalogoDeAuditoria(dataSource: DataSource) {
  await dataSource.getRepository(AuditActionType).upsert(
    Object.entries(AUDIT_ACTION_TYPE_NAMES).map(([id, name]) => ({
      actionTypeId: Number(id),
      name,
    })),
    ['actionTypeId'],
  );
}

export async function truncateAllTables(app: TestApp): Promise<void> {
  // `app.get('DataSource' as any)` (el token en string) no resuelve: Nest
  // registra el provider con la CLASE `DataSource` como token, no con el
  // nombre. Con el import real sí lo encuentra.
  const dataSource = app.get(DataSource);
  asegurarBaseDescartable(dataSource);
  const entities = dataSource.entityMetadatas;
  // TRUNCATE CASCADE limpia todas las tablas respetando FKs.
  // El catálogo de acciones de auditoría es dato de referencia: no se vacía.
  const tables = entities
    .filter((e) => e.tableName !== 'audit_action_type')
    .map((e) => `"${e.tableName}"`)
    .join(', ');
  // Tras un pedido quedan tareas en segundo plano (auditoría, notificaciones,
  // despacho) escribiendo: pueden chocar con el TRUNCATE. Se reintenta.
  for (let intento = 1; ; intento++) {
    try {
      await dataSource.query(
        `TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE;`,
      );
      return;
    } catch (error) {
      const codigo = (error as { code?: string }).code;
      if (intento >= 10 || (codigo !== '40P01' && codigo !== '55P03')) {
        throw error;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

/**
 * Una distribuidora y un cliente que pasan el `AuthGuard` (rol `customer`):
 * `headers` va en cada request (el token es el correo, ver `createTestApp`).
 */
export async function sembrarClienteAutenticado(app: TestApp): Promise<{
  distributor: Distributor;
  user: User;
  headers: Record<string, string>;
}> {
  const dataSource = app.get(DataSource);
  const sufijo = randomUUID().slice(0, 8);
  const distributor = await dataSource.getRepository(Distributor).save({
    name: `Distribuidora ${sufijo}`,
    slug: `dist-${sufijo}`,
  } as Partial<Distributor>);
  const roles = dataSource.getRepository(Role);
  const rol =
    (await roles.findOne({ where: { type: 'customer' } })) ??
    (await roles.save({ type: 'customer' } as Partial<Role>));
  const email = `cliente.${sufijo}@splg.local`;
  const user = await dataSource.getRepository(User).save({
    email,
    fullName: 'Test Customer',
    phoneNumber: telefonoDePrueba(),
    roleId: rol.roleId,
  } as Partial<User>);
  await dataSource.getRepository(Customer).save({
    userId: user.userId,
    notificationToken: 'fake-fcm',
  } as Partial<Customer>);
  return {
    distributor,
    user,
    headers: {
      Authorization: `Bearer ${email}`,
      'X-Client-Source': 'customer-app',
      'X-Distributor': distributor.slug,
    },
  };
}
