import { DistributorService } from '../distributor/distributor.service';
import { DistributorStatus } from '../distributor/entities/distributor.entity';
import { RedisService } from '../redis/redis.service';
import { RepurchaseCron } from './repurchase.cron';
import { RepurchaseEstimatorService } from './repurchase-estimator.service';
import { RepurchaseForecastService } from './repurchase-forecast.service';
import { empresasDePrueba } from '../process-run/testing/empresas-de-prueba';

// 09:00 en Argentina.
const A_LAS_9 = new Date('2026-10-31T12:00:00Z');

const memoriaRedis = () => {
  const m = new Map<string, string>();
  return {
    get: jest.fn((k: string) => Promise.resolve(m.get(k) ?? null)),
    setex: jest.fn((k: string, _t: number, v: string) => {
      m.set(k, v);
      return Promise.resolve();
    }),
  };
};

describe('RepurchaseCron', () => {
  let forecast: {
    ejecutar: jest.Mock;
    vencer: jest.Mock;
    cerrarLasDeUnaDistribuidoraInactiva: jest.Mock;
  };
  let estimator: { parametros: jest.Mock };
  let distributors: { findAll: jest.Mock };
  let withLock: jest.Mock;
  let cron: RepurchaseCron;
  let sinRecompra: Set<string>;

  beforeEach(() => {
    forecast = {
      ejecutar: jest.fn().mockResolvedValue({}),
      vencer: jest.fn().mockResolvedValue(2),
      cerrarLasDeUnaDistribuidoraInactiva: jest.fn().mockResolvedValue(1),
    };
    estimator = {
      parametros: jest.fn().mockResolvedValue({ enabled: true, runHour: 9 }),
    };
    distributors = {
      findAll: jest.fn().mockResolvedValue([
        { distributorId: 'd1', status: DistributorStatus.ACTIVE },
        { distributorId: 'd2', status: DistributorStatus.ACTIVE },
        { distributorId: 'd3', status: DistributorStatus.SUSPENDED },
      ]),
    };
    withLock = jest
      .fn()
      .mockImplementation(
        async (_k: string, _t: number, fn: () => Promise<void>) => {
          await fn();
          return { obtenido: true, valor: undefined };
        },
      );
    sinRecompra = new Set();
    cron = new RepurchaseCron(
      forecast as unknown as RepurchaseForecastService,
      estimator as unknown as RepurchaseEstimatorService,
      distributors as unknown as DistributorService,
      { withLock, ...memoriaRedis() } as unknown as RedisService,
      empresasDePrueba({
        distribuidoras: distributors as never,
        habilitado: (id, modulo) =>
          !(modulo === 'repurchase' && sinRecompra.has(id)),
      }).empresas,
    );
  });

  it('corre las distribuidoras activas cuya hora de ejecución es la actual', async () => {
    estimator.parametros.mockImplementation((id: string) =>
      Promise.resolve({ enabled: true, runHour: id === 'd1' ? 9 : 15 }),
    );
    expect(await cron.anticiparLasQueTocan(A_LAS_9)).toBe(1);
    expect(forecast.ejecutar).toHaveBeenCalledTimes(1);
    expect(forecast.ejecutar).toHaveBeenCalledWith('d1', A_LAS_9);
  });

  it('con la recompra deshabilitada por la plataforma no invita en esa empresa y sí en otra', async () => {
    sinRecompra.add('d1');
    expect(await cron.anticiparLasQueTocan(A_LAS_9)).toBe(1);
    expect(forecast.ejecutar).toHaveBeenCalledTimes(1);
    expect(forecast.ejecutar).toHaveBeenCalledWith('d2', A_LAS_9);
    expect(estimator.parametros).not.toHaveBeenCalledWith('d1');
  });

  it('una distribuidora suspendida no corre', async () => {
    await cron.anticiparLasQueTocan(A_LAS_9);
    expect(forecast.ejecutar).not.toHaveBeenCalledWith('d3', A_LAS_9);
  });

  it('a otra hora no corre ninguna', async () => {
    expect(
      await cron.anticiparLasQueTocan(new Date('2026-10-31T11:00:00Z')),
    ).toBe(0);
    expect(forecast.ejecutar).not.toHaveBeenCalled();
  });

  it('si una distribuidora falla, las demás corren igual', async () => {
    forecast.ejecutar.mockRejectedValueOnce(new Error('falló d1'));
    expect(await cron.anticiparLasQueTocan(A_LAS_9)).toBe(1);
    expect(forecast.ejecutar).toHaveBeenCalledTimes(2);
  });

  it('anticipar corre bajo el cerrojo diario', async () => {
    await cron.anticipar();
    expect(withLock).toHaveBeenCalledWith(
      RepurchaseCron.CERROJO_DIARIO,
      RepurchaseCron.CERROJO_TTL_MS,
      expect.any(Function),
    );
    expect(distributors.findAll).toHaveBeenCalled();
  });

  it('vencer corre bajo su propio cerrojo y barre las distribuidoras activas que la tienen encendida', async () => {
    await cron.vencer();
    expect(withLock).toHaveBeenCalledWith(
      RepurchaseCron.CERROJO_VENCIMIENTOS,
      RepurchaseCron.CERROJO_TTL_MS,
      expect.any(Function),
    );
    expect(forecast.vencer).toHaveBeenCalledTimes(2);
    expect(forecast.vencer).toHaveBeenCalledWith(expect.any(Date), 'd1');
    expect(forecast.vencer).toHaveBeenCalledWith(expect.any(Date), 'd2');
  });

  it('una distribuidora con la anticipación apagada no corre ni se barre', async () => {
    estimator.parametros.mockResolvedValue({ enabled: false, runHour: 9 });
    expect(await cron.anticiparLasQueTocan(A_LAS_9)).toBe(0);
    await cron.vencer();
    expect(forecast.ejecutar).not.toHaveBeenCalled();
    expect(forecast.vencer).not.toHaveBeenCalled();
  });

  it('las invitaciones de una distribuidora que ya no está activa se cierran en el barrido', async () => {
    await cron.vencer();
    expect(forecast.cerrarLasDeUnaDistribuidoraInactiva).toHaveBeenCalledTimes(
      1,
    );
    expect(forecast.cerrarLasDeUnaDistribuidoraInactiva).toHaveBeenCalledWith(
      'd3',
      expect.any(Date),
    );
  });

  it('si el barrido de una distribuidora falla, sigue con las demás', async () => {
    forecast.vencer.mockRejectedValueOnce(new Error('falló d1'));
    await expect(cron.vencer()).resolves.toBeUndefined();
    expect(forecast.vencer).toHaveBeenCalledTimes(2);
  });

  it('vencer sin nada vencido no deja rastro y no falla', async () => {
    forecast.vencer.mockResolvedValue(0);
    forecast.cerrarLasDeUnaDistribuidoraInactiva.mockResolvedValue(0);
    await expect(cron.vencer()).resolves.toBeUndefined();
  });

  it('si otra instancia tiene el cerrojo no hace nada', async () => {
    withLock.mockResolvedValue({ obtenido: false });
    await cron.anticipar();
    await cron.vencer();
    expect(forecast.ejecutar).not.toHaveBeenCalled();
    expect(forecast.vencer).not.toHaveBeenCalled();
  });

  it('si la ejecución revienta, lo registra y no propaga', async () => {
    withLock.mockRejectedValue(new Error('redis caído'));
    await expect(cron.anticipar()).resolves.toBeUndefined();
  });

  it('si la recompra se apaga después de elegir la empresa, no invita (re-consulta sin caché)', async () => {
    estimator.parametros.mockImplementation((id: string) => {
      if (id === 'd1') sinRecompra.add(id);
      return Promise.resolve({ enabled: true, runHour: 9 });
    });
    expect(await cron.anticiparLasQueTocan(A_LAS_9)).toBe(1);
    expect(forecast.ejecutar).toHaveBeenCalledTimes(1);
    expect(forecast.ejecutar).toHaveBeenCalledWith('d2', A_LAS_9);
  });

  describe('corrida diaria recuperable', () => {
    const exacta = A_LAS_9;
    const unaHoraDespues = new Date(exacta.getTime() + 3_600_000);
    const unaHoraAntes = new Date(exacta.getTime() - 3_600_000);
    const diaSiguiente = new Date(exacta.getTime() + 24 * 3_600_000);

    it('a la hora exacta corre', async () => {
      estimator.parametros.mockResolvedValue({ enabled: true, runHour: 9 });
      expect(await cron.anticiparLasQueTocan(exacta)).toBe(2);
    });

    it('una hora después sin corrida previa hoy recupera', async () => {
      estimator.parametros.mockResolvedValue({ enabled: true, runHour: 9 });
      expect(await cron.anticiparLasQueTocan(unaHoraDespues)).toBe(2);
    });

    it('una hora después con corrida hoy no corre', async () => {
      estimator.parametros.mockResolvedValue({ enabled: true, runHour: 9 });
      await cron.anticiparLasQueTocan(exacta);
      forecast.ejecutar.mockClear();
      expect(await cron.anticiparLasQueTocan(unaHoraDespues)).toBe(0);
      expect(forecast.ejecutar).not.toHaveBeenCalled();
    });

    it('antes de la hora no corre', async () => {
      estimator.parametros.mockResolvedValue({ enabled: true, runHour: 9 });
      expect(await cron.anticiparLasQueTocan(unaHoraAntes)).toBe(0);
    });

    it('al día siguiente vuelve a correr', async () => {
      estimator.parametros.mockResolvedValue({ enabled: true, runHour: 9 });
      await cron.anticiparLasQueTocan(exacta);
      expect(await cron.anticiparLasQueTocan(diaSiguiente)).toBe(2);
    });
  });
});
