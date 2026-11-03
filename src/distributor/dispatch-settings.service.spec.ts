import { DispatchSettingsService } from './dispatch-settings.service';
import { ModuleConfigService } from './module-config.service';
import { ConfigurableProcess } from './entities/module-config.entity';
import { dispatchSettingsDesde } from './dispatch-settings';

describe('DispatchSettingsService (CU-171)', () => {
  let service: DispatchSettingsService;
  let configs: { parametros: jest.Mock; fila: jest.Mock; guardar: jest.Mock };

  const DEFAULTS = {
    radiusStepsKm: [5, 10, 15, 20],
    offerTtlSeconds: 30,
    finishingRadiusMeters: 300,
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-15T12:00:00Z') });
    configs = {
      parametros: jest.fn().mockResolvedValue(null),
      fila: jest.fn().mockResolvedValue(null),
      guardar: jest.fn().mockResolvedValue(undefined),
    };
    service = new DispatchSettingsService(
      configs as unknown as ModuleConfigService,
    );
  });
  afterEach(() => jest.useRealTimers());

  it('sin distribuidora o sin configuración rigen los valores por omisión (los de las constantes de siempre)', async () => {
    expect(await service.obtener(null)).toEqual(DEFAULTS);
    expect(await service.obtener(undefined)).toEqual(DEFAULTS);
    expect(await service.obtener('d1')).toEqual(DEFAULTS);
    expect(configs.parametros).toHaveBeenCalledWith(
      'd1',
      ConfigurableProcess.DISPATCH,
    );
  });

  it('devuelve lo configurado por la distribuidora', async () => {
    configs.parametros.mockResolvedValue({
      radiusStepsKm: [2, 4],
      offerTtlSeconds: 60,
    });
    expect(await service.obtener('d1')).toEqual({
      radiusStepsKm: [2, 4],
      offerTtlSeconds: 60,
      finishingRadiusMeters: 300,
    });
  });

  it('copia en memoria: dentro del minuto no vuelve a la base; pasado el minuto sí', async () => {
    await service.obtener('d1');
    jest.advanceTimersByTime(59_000);
    await service.obtener('d1');
    expect(configs.parametros).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(2_000);
    await service.obtener('d1');
    expect(configs.parametros).toHaveBeenCalledTimes(2);
  });

  it('la copia es por distribuidora', async () => {
    await service.obtener('d1');
    await service.obtener('d2');
    expect(configs.parametros).toHaveBeenCalledTimes(2);
  });

  it('guardar descarta la copia de esa distribuidora (y sólo la suya) y el cambio rige enseguida', async () => {
    await service.obtener('d1');
    await service.obtener('d2');
    configs.parametros.mockResolvedValue({
      radiusStepsKm: [3],
      offerTtlSeconds: 90,
    });
    configs.fila.mockResolvedValue({
      params: { radiusStepsKm: [3], offerTtlSeconds: 90 },
      updatedAt: new Date('2026-10-15T12:00:00Z'),
      updatedByUserId: 'u1',
    });

    const guardado = await service.guardar(
      'd1',
      { radiusStepsKm: [3], offerTtlSeconds: 90 },
      'u1',
    );

    expect(configs.guardar).toHaveBeenCalledWith(
      'd1',
      ConfigurableProcess.DISPATCH,
      { radiusStepsKm: [3], offerTtlSeconds: 90 },
      'u1',
    );
    expect(guardado).toMatchObject({
      radiusStepsKm: [3],
      offerTtlSeconds: 90,
      isDefault: false,
      updatedByUserId: 'u1',
    });
    expect(await service.obtener('d1')).toEqual({
      radiusStepsKm: [3],
      offerTtlSeconds: 90,
      finishingRadiusMeters: 300,
    });
    // La otra distribuidora conserva su copia: no volvió a la base.
    await service.obtener('d2');
    expect(configs.parametros).toHaveBeenCalledTimes(3);
  });

  it('quien lo recibe no puede alterar la copia en memoria', async () => {
    const primero = await service.obtener('d1');
    primero.radiusStepsKm.push(999);
    expect((await service.obtener('d1')).radiusStepsKm).toEqual(
      DEFAULTS.radiusStepsKm,
    );
  });

  it('vigentes: sin fila marca isDefault y no hay quién modificó', async () => {
    expect(await service.vigentes('d1')).toEqual({
      ...DEFAULTS,
      isDefault: true,
      updatedAt: null,
      updatedByUserId: null,
    });
  });

  it('un JSON guardado con valores fuera de rango cae al valor por omisión en vez de romper el despacho', () => {
    expect(
      dispatchSettingsDesde({
        radiusStepsKm: [10, 5],
        offerTtlSeconds: 5000,
      }),
    ).toEqual(DEFAULTS);
    expect(dispatchSettingsDesde({ radiusStepsKm: 'x' })).toEqual(DEFAULTS);
    expect(dispatchSettingsDesde({ offerTtlSeconds: 45 })).toEqual({
      ...DEFAULTS,
      offerTtlSeconds: 45,
    });
  });

  it('finishingRadiusMeters: 0 (apagado) es válido; negativo, fraccionario o enorme cae al valor por omisión', () => {
    const radio = (finishingRadiusMeters: unknown) =>
      dispatchSettingsDesde({ finishingRadiusMeters }).finishingRadiusMeters;
    expect(radio(0)).toBe(0);
    expect(radio(5000)).toBe(5000);
    expect(radio(450)).toBe(450);
    expect(radio(-1)).toBe(300);
    expect(radio(5001)).toBe(300);
    expect(radio(10.5)).toBe(300);
    expect(radio('x')).toBe(300);
  });

  it('guardar el radio por terminar lo manda a la configuración y deja de ser isDefault', async () => {
    configs.fila.mockResolvedValue({
      params: { finishingRadiusMeters: 0 },
      updatedAt: null,
      updatedByUserId: 'u1',
    });
    const r = await service.guardar('d1', { finishingRadiusMeters: 0 }, 'u1');
    expect(configs.guardar).toHaveBeenCalledWith(
      'd1',
      ConfigurableProcess.DISPATCH,
      { finishingRadiusMeters: 0 },
      'u1',
    );
    expect(r).toMatchObject({ finishingRadiusMeters: 0, isDefault: false });
  });

  it('PUT parcial: guarda sólo lo que vino y lo que falta se lee con su valor por omisión', async () => {
    configs.fila.mockResolvedValue({
      params: { offerTtlSeconds: 90 },
      updatedAt: null,
      updatedByUserId: 'u1',
    });

    const r = await service.guardar('d1', { offerTtlSeconds: 90 }, 'u1');

    expect(configs.guardar).toHaveBeenCalledWith(
      'd1',
      ConfigurableProcess.DISPATCH,
      { offerTtlSeconds: 90 },
      'u1',
    );
    expect(r).toMatchObject({
      radiusStepsKm: [5, 10, 15, 20],
      offerTtlSeconds: 90,
      isDefault: false,
    });
  });

  it('restablecer (PUT sin campos) o guardar valores iguales a los de omisión: isDefault true', async () => {
    configs.fila.mockResolvedValue({
      params: {},
      updatedAt: null,
      updatedByUserId: 'u1',
    });
    expect((await service.guardar('d1', {}, 'u1')).isDefault).toBe(true);

    configs.fila.mockResolvedValue({
      params: { radiusStepsKm: [5, 10, 15, 20], offerTtlSeconds: 30 },
      updatedAt: null,
      updatedByUserId: 'u1',
    });
    expect((await service.vigentes('d1')).isDefault).toBe(true);
  });
});
