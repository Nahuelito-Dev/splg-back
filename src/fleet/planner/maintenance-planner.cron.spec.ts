import { MaintenancePlannerCron } from './maintenance-planner.cron';
import { MaintenancePlannerService } from './maintenance-planner.service';
import { RedisService } from '../../redis/redis.service';
import { empresasDePrueba } from '../../process-run/testing/empresas-de-prueba';

// 03:00 en Argentina.
const A_LAS_3 = new Date('2026-10-30T06:00:00Z');

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

describe('MaintenancePlannerCron', () => {
  let planner: {
    distribuidorasConTareas: jest.Mock;
    parametros: jest.Mock;
    ejecutar: jest.Mock;
    vencerPropuestas: jest.Mock;
  };
  let withLock: jest.Mock;
  let cron: MaintenancePlannerCron;
  let sinPlanificador: Set<string>;

  beforeEach(() => {
    planner = {
      distribuidorasConTareas: jest.fn().mockResolvedValue(['d1', 'd2']),
      parametros: jest.fn().mockResolvedValue({ cronHour: 3 }),
      ejecutar: jest.fn().mockResolvedValue({
        propuestas: 1,
        escaladas: 0,
        vehiculosFueraDeServicio: 0,
      }),
      vencerPropuestas: jest.fn().mockResolvedValue(2),
    };
    withLock = jest
      .fn()
      .mockImplementation(
        async (_k: string, _t: number, fn: () => Promise<void>) => {
          await fn();
          return { obtenido: true, valor: undefined };
        },
      );
    sinPlanificador = new Set();
    cron = new MaintenancePlannerCron(
      planner as unknown as MaintenancePlannerService,
      { withLock, ...memoriaRedis() } as unknown as RedisService,
      empresasDePrueba({
        distribuidoras: { findAll: () => Promise.resolve([]) },
        habilitado: (id, modulo) =>
          !(modulo === 'fleet_planner' && sinPlanificador.has(id)),
      }).empresas,
    );
  });

  it('corre las distribuidoras cuya hora de ejecución es la actual', async () => {
    planner.parametros.mockImplementation((id: string) =>
      Promise.resolve({ cronHour: id === 'd1' ? 3 : 9 }),
    );
    const n = await cron.planificarLasQueTocan(A_LAS_3);
    expect(n).toBe(1);
    expect(planner.ejecutar).toHaveBeenCalledTimes(1);
    expect(planner.ejecutar).toHaveBeenCalledWith('d1', A_LAS_3);
  });

  it('a otra hora no corre ninguna', async () => {
    const n = await cron.planificarLasQueTocan(
      new Date('2026-10-30T05:00:00Z'),
    );
    expect(n).toBe(0);
    expect(planner.ejecutar).not.toHaveBeenCalled();
  });

  it('sin el planificador habilitado por la plataforma no propone en esa empresa; en otra sí', async () => {
    sinPlanificador.add('d2');
    expect(await cron.planificarLasQueTocan(A_LAS_3)).toBe(1);
    expect(planner.ejecutar).toHaveBeenCalledTimes(1);
    expect(planner.ejecutar).toHaveBeenCalledWith('d1', A_LAS_3);
  });

  it('si una distribuidora falla sigue con las demás', async () => {
    planner.ejecutar.mockRejectedValueOnce(new Error('boom'));
    const n = await cron.planificarLasQueTocan(A_LAS_3);
    expect(n).toBe(1);
    expect(planner.ejecutar).toHaveBeenCalledTimes(2);
  });

  it('la corrida diaria toma el cerrojo y lo suelta', async () => {
    await cron.planificar();
    expect(withLock).toHaveBeenCalledWith(
      MaintenancePlannerCron.CERROJO_DIARIO,
      MaintenancePlannerCron.CERROJO_TTL_MS,
      expect.any(Function),
    );
  });

  it('si otra instancia tiene el cerrojo no hace nada', async () => {
    withLock.mockResolvedValue({ obtenido: false });
    await cron.vencerPropuestas();
    expect(planner.vencerPropuestas).not.toHaveBeenCalled();
  });

  it('el vencimiento de propuestas corre bajo su propio cerrojo', async () => {
    await cron.vencerPropuestas();
    expect((withLock.mock.calls as [string][])[0][0]).toBe(
      MaintenancePlannerCron.CERROJO_VENCIMIENTOS,
    );
    expect(planner.vencerPropuestas).toHaveBeenCalledTimes(1);
  });

  it('un error del cerrojo no se propaga', async () => {
    withLock.mockRejectedValue(new Error('redis caído'));
    await expect(cron.planificar()).resolves.toBeUndefined();
  });

  it('si el planificador se apaga después de elegir la empresa, no propone (re-consulta sin caché)', async () => {
    planner.parametros.mockImplementation((id: string) => {
      if (id === 'd1') sinPlanificador.add(id);
      return Promise.resolve({ cronHour: 3 });
    });
    expect(await cron.planificarLasQueTocan(A_LAS_3)).toBe(1);
    expect(planner.ejecutar).toHaveBeenCalledTimes(1);
    expect(planner.ejecutar).toHaveBeenCalledWith('d2', A_LAS_3);
  });

  describe('corrida diaria recuperable', () => {
    const exacta = A_LAS_3;
    const unaHoraDespues = new Date(exacta.getTime() + 3_600_000);
    const unaHoraAntes = new Date(exacta.getTime() - 3_600_000);
    const diaSiguiente = new Date(exacta.getTime() + 24 * 3_600_000);

    it('a la hora exacta corre', async () => {
      planner.parametros.mockResolvedValue({ cronHour: 3 });
      expect(await cron.planificarLasQueTocan(exacta)).toBe(2);
    });

    it('una hora después sin corrida previa hoy recupera', async () => {
      planner.parametros.mockResolvedValue({ cronHour: 3 });
      expect(await cron.planificarLasQueTocan(unaHoraDespues)).toBe(2);
    });

    it('una hora después con corrida hoy no corre', async () => {
      planner.parametros.mockResolvedValue({ cronHour: 3 });
      await cron.planificarLasQueTocan(exacta);
      planner.ejecutar.mockClear();
      expect(await cron.planificarLasQueTocan(unaHoraDespues)).toBe(0);
      expect(planner.ejecutar).not.toHaveBeenCalled();
    });

    it('antes de la hora no corre', async () => {
      planner.parametros.mockResolvedValue({ cronHour: 3 });
      expect(await cron.planificarLasQueTocan(unaHoraAntes)).toBe(0);
    });

    it('al día siguiente vuelve a correr', async () => {
      planner.parametros.mockResolvedValue({ cronHour: 3 });
      await cron.planificarLasQueTocan(exacta);
      expect(await cron.planificarLasQueTocan(diaSiguiente)).toBe(2);
    });
  });
});
