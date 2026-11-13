import { RoutePlanProposalService } from './application/route-plan-proposal.service';
import { RoutePlanService } from './application/route-plan.service';
import { RoutePlanningCron } from './route-planning.cron';
import { RedisService } from '../redis/redis.service';

describe('RoutePlanningCron', () => {
  const conCerrojo = {
    withLock: jest.fn(
      async (_k: string, _t: number, fn: () => Promise<unknown>) => ({
        obtenido: true,
        valor: await fn(),
      }),
    ),
  };

  function armar(
    para: Array<{ distributorId: string; planDate: string }>,
    proponer: jest.Mock,
  ) {
    const plans = {
      paraProponer: jest.fn().mockResolvedValue(para),
      cerrarDiasVencidos: jest.fn().mockResolvedValue(2),
    };
    const cron = new RoutePlanningCron(
      plans as unknown as RoutePlanService,
      { proponer } as unknown as RoutePlanProposalService,
      conCerrojo as unknown as RedisService,
    );
    return { cron, plans };
  }

  it('propone mañana en cada distribuidora que le toca', async () => {
    const proponer = jest
      .fn()
      .mockResolvedValue({ sheets: [{}], unassigned: [] });
    const { cron } = armar(
      [
        { distributorId: 'd1', planDate: '2026-11-14' },
        { distributorId: 'd2', planDate: '2026-11-14' },
      ],
      proponer,
    );
    await expect(cron.proponer()).resolves.toEqual({ proposed: 2 });
    expect(proponer).toHaveBeenCalledWith('d1', '2026-11-14');
    expect(proponer).toHaveBeenCalledWith('d2', '2026-11-14');
  });

  it('una distribuidora que falla no frena a las demás', async () => {
    const proponer = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ sheets: [], unassigned: [] });
    const { cron } = armar(
      [
        { distributorId: 'd1', planDate: '2026-11-14' },
        { distributorId: 'd2', planDate: '2026-11-14' },
      ],
      proponer,
    );
    await expect(cron.proponer()).resolves.toEqual({ proposed: 1 });
    expect(proponer).toHaveBeenCalledTimes(2);
  });

  it('cierra los días vencidos', async () => {
    const { cron, plans } = armar([], jest.fn());
    await expect(cron.cerrarDias()).resolves.toEqual({ closed: 2 });
    expect(plans.cerrarDiasVencidos).toHaveBeenCalledTimes(1);
  });

  it('sin el cerrojo no hace nada', async () => {
    const proponer = jest.fn();
    const plans = { paraProponer: jest.fn(), cerrarDiasVencidos: jest.fn() };
    const cron = new RoutePlanningCron(
      plans as unknown as RoutePlanService,
      { proponer } as unknown as RoutePlanProposalService,
      {
        withLock: jest.fn().mockResolvedValue({ obtenido: false }),
      } as unknown as RedisService,
    );
    await expect(cron.proponer()).resolves.toBeUndefined();
    await expect(cron.cerrarDias()).resolves.toBeUndefined();
    expect(plans.paraProponer).not.toHaveBeenCalled();
    expect(plans.cerrarDiasVencidos).not.toHaveBeenCalled();
  });
});
