/**
 * `instrument.ts` corre al importarse: carga el `.env` (si no es la etapa de
 * tests y el archivo existe) y recién después inicializa Sentry.
 */
describe('instrument', () => {
  const stageOriginal = process.env.STAGE;

  afterEach(() => {
    process.env.STAGE = stageOriginal;
    jest.resetModules();
    jest.dontMock('node:fs');
    jest.dontMock('./common/config/sentry.config');
  });

  function importar(stage: string | undefined, hayEnv: boolean) {
    const orden: string[] = [];
    if (stage === undefined) delete process.env.STAGE;
    else process.env.STAGE = stage;
    jest.doMock('node:fs', () => ({ existsSync: () => hayEnv }));
    jest.doMock('./common/config/sentry.config', () => ({
      iniciarSentry: () => orden.push('iniciarSentry'),
    }));
    const cargar = jest.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      orden.push('loadEnvFile');
    });
    jest.isolateModules(() => {
      jest.requireActual('./instrument');
    });
    return { orden, cargar };
  }

  it('carga el .env antes de iniciar Sentry', () => {
    const { orden, cargar } = importar('dev', true);
    expect(orden).toEqual(['loadEnvFile', 'iniciarSentry']);
    expect(cargar).toHaveBeenCalledWith('.env');
  });

  it('sin .env inicia Sentry con el entorno que haya', () => {
    expect(importar(undefined, false).orden).toEqual(['iniciarSentry']);
  });

  it('en la etapa de tests no lee el .env', () => {
    expect(importar('test', true).orden).toEqual(['iniciarSentry']);
  });
});
