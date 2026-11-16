import { s3DelSeedHabilitado } from '../../scripts/lib/storage-demo';
import {
  purgaS3Habilitada,
  resguardoDeProduccion,
} from '../../scripts/lib/resguardo-de-produccion';

describe('resguardo del seed de demostración', () => {
  it.each([
    [{ NODE_ENV: 'production' }],
    [{ DB_NAME: 'splg_prod' }],
    [{ DB_HOST: 'db.produccion.example' }],
    [{ AWS_S3_BUCKET: 'splg-prod-files' }],
  ])('se niega a correr con %j', (env) => {
    expect(() => resguardoDeProduccion(env)).toThrow(/parece producción/);
  });

  it('corre en un entorno de desarrollo', () => {
    expect(() =>
      resguardoDeProduccion({ NODE_ENV: 'development', DB_NAME: 'splg_db' }),
    ).not.toThrow();
  });

  it('corre con la variable explícita aunque parezca producción', () => {
    expect(() =>
      resguardoDeProduccion({
        NODE_ENV: 'production',
        SEED_ALLOW_PRODUCTION: 'true',
      }),
    ).not.toThrow();
  });
});

describe('purga de S3 del seed de demostración', () => {
  it.each([[{}], [{ SEED_PURGE_S3: '0' }], [{ SEED_PURGE_S3: 'true' }]])(
    'no borra objetos con %j',
    (env) => {
      expect(purgaS3Habilitada(env)).toBe(false);
    },
  );

  it('borra sólo con SEED_PURGE_S3=1', () => {
    expect(purgaS3Habilitada({ SEED_PURGE_S3: '1' })).toBe(true);
  });
});

describe('acceso a S3 de los seeds', () => {
  it.each([[{}], [{ SEED_S3: '0' }], [{ SEED_S3: 'true' }]])(
    'no toca S3 con %j',
    (env) => {
      expect(s3DelSeedHabilitado(env)).toBe(false);
    },
  );

  it('toca S3 sólo con SEED_S3=1', () => {
    expect(s3DelSeedHabilitado({ SEED_S3: '1' })).toBe(true);
  });
});
