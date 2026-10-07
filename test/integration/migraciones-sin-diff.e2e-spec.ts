/**
 * Las migraciones, corridas TODAS sobre una base vacía, tienen que dejar
 * exactamente el esquema que describen las entidades: si TypeORM encuentra una
 * diferencia (`schema:log`) es que una entidad y su migración dicen cosas
 * distintas y el próximo `migration:generate` va a proponer arreglos que no
 * corresponden (p. ej. recrear un enum por un `enumName` igual al de por
 * defecto).
 */
import { join } from 'path';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

describe('Migraciones sin diff contra las entidades (e2e)', () => {
  let contenedor: StartedPostgreSqlContainer;
  let dataSource: DataSource;

  beforeAll(async () => {
    contenedor = await new PostgreSqlContainer(
      process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4',
    )
      .withDatabase('splg_migraciones')
      .withUsername('test')
      .withPassword('test')
      .start();
    const raiz = join(__dirname, '..', '..', 'src');
    dataSource = new DataSource({
      type: 'postgres',
      host: contenedor.getHost(),
      port: contenedor.getPort(),
      username: contenedor.getUsername(),
      password: contenedor.getPassword(),
      database: contenedor.getDatabase(),
      entities: [join(raiz, '**', '*.entity.ts')],
      migrations: [join(raiz, 'migrations', '*.ts')],
      synchronize: false,
    });
    await dataSource.initialize();
  }, 180000);

  afterAll(async () => {
    await dataSource?.destroy();
    await contenedor?.stop();
  });

  it('corren de cero y no dejan diferencias con las entidades', async () => {
    await dataSource.runMigrations();

    const consultas = await dataSource.driver
      .createSchemaBuilder()
      .log()
      .then((sql) => sql.upQueries.map((q) => q.query));

    expect(consultas).toEqual([]);
  }, 240000);
});
