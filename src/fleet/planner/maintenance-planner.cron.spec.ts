import { MaintenancePlannerCron } from './maintenance-planner.cron';
import { MaintenancePlannerService } from './maintenance-planner.service';
import { RedisService } from '../../redis/redis.service';

// 03:00 en Argentina.
const A_LAS_3 = new Date('2026-10-30T06:00:00Z');

describe('MaintenancePlannerCron', () => {
  let planner: {
    distribuidorasConTareas: jest.Mock;
    parametros: jest.Mock;
    ejecutar: jest.Mock;
    vencerPropuestas: jest.Mock;
  };
  let withLock: jest.Mock;
  let cron: MaintenancePlannerCron;

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
    cron = new MaintenancePlannerCron(
      planner as unknown as MaintenancePlannerService,
      { withLock } as unknown as RedisService,
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
      new Date('2026-10-30T12:00:00Z'),
    );
    expect(n).toBe(0);
    expect(planner.ejecutar).not.toHaveBeenCalled();
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
});
