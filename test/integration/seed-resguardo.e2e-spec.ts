import { resguardoDeProduccion } from '../../scripts/lib/resguardo-de-produccion';

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
