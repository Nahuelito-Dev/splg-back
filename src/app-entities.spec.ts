import { EntitiesMetadataStorage } from '@nestjs/typeorm/dist/entities-metadata.storage';
import { DataSource } from 'typeorm';

/**
 * Importar el módulo raíz evalúa todos los `TypeOrmModule.forFeature([...])` de la
 * app (lo que `autoLoadEntities` junta para armar la conexión) y también
 * `ConfigModule.forRoot`, que valida las variables obligatorias. En la CI no hay
 * `.env`: se completan con valores de prueba las que falten (no se conecta a nada)
 * y recién después se carga el módulo.
 */
const OBLIGATORIAS_DE_PRUEBA: Readonly<Record<string, string>> = {
  DB_PASSWORD: 'test',
  DB_NAME: 'test',
  DB_HOST: 'localhost',
  DB_USERNAME: 'test',
  FIREBASE_PROJECT_ID: 'test',
  FIREBASE_CLIENT_EMAIL: 'test@example.com',
  FIREBASE_PRIVATE_KEY: 'test',
  AWS_S3_BUCKET: 'test',
  AWS_REGION: 'us-east-1',
};

beforeAll(() => {
  for (const [clave, valor] of Object.entries(OBLIGATORIAS_DE_PRUEBA)) {
    process.env[clave] ||= valor;
  }
  jest.requireActual('./app.module');
});

/**
 * La app sólo conoce las entidades que algún módulo registra con `forFeature`
 * (`autoLoadEntities`). Una entidad que referencia a otra que ningún módulo
 * registró hace caer el arranque con «Entity metadata for X was not found», aunque
 * los tests de integración (que cargan todas las entidades por patrón de archivo)
 * pasen. Este spec arma la metadata con exactamente esas entidades.
 */
describe('Entidades que carga la app (autoLoadEntities)', () => {
  const entidades = () =>
    EntitiesMetadataStorage.getEntitiesByDataSource('default');

  it('la metadata de TypeORM se arma con las entidades registradas por los módulos', async () => {
    const dataSource = new DataSource({
      type: 'postgres',
      entities: entidades(),
    });
    await expect(
      (
        dataSource as unknown as { buildMetadatas(): Promise<void> }
      ).buildMetadatas(),
    ).resolves.toBeUndefined();
    expect(dataSource.entityMetadatas.length).toBeGreaterThan(80);
  });

  it('el lote de recorrido, su planificación del día y sus paradas están registrados', () => {
    const nombres = entidades().map((e) => (e as { name: string }).name);
    expect(nombres).toEqual(
      expect.arrayContaining([
        'RouteBatch',
        'RouteBatchStop',
        'RouteBatchOffer',
        'RoutePlan',
      ]),
    );
  });
});
