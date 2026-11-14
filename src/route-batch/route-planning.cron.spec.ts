import { RoutePlanAutoConfirmService } from './application/route-plan-auto-confirm.service';
import { RoutePlanProposalService } from './application/route-plan-proposal.service';
import { RouteSheetWatchService } from './application/route-sheet-watch.service';
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

  const sinConfirmar = {
    autoConfirmed: 0,
    autoConfirmFailed: 0,
    autoConfirmRetry: 0,
  };
  const nuevoAuto = () => ({
    confirmarLasVencidas: jest.fn().mockResolvedValue(sinConfirmar),
    avisarSinHojaPosible: jest.fn().mockReturnValue(false),
  });

  function armar(
    para: Array<{ distributorId: string; planDate: string }>,
    proponer: jest.Mock,
    auto = nuevoAuto(),
  ) {
    const plans = {
      paraProponer: jest.fn().mockResolvedValue(para),
      cerrarDiasVencidos: jest.fn().mockResolvedValue(2),
    };
    const cron = new RoutePlanningCron(
      plans as unknown as RoutePlanService,
      { proponer } as unknown as RoutePlanProposalService,
      conCerrojo as unknown as RedisService,
      { vigilar: jest.fn() } as unknown as RouteSheetWatchService,
      auto as unknown as RoutePlanAutoConfirmService,
    );
    return { cron, plans, auto };
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
    await expect(cron.proponer()).resolves.toEqual({
      proposed: 2,
      noVehiclesAlerts: 0,
      ...sinConfirmar,
    });
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
    await expect(cron.proponer()).resolves.toMatchObject({ proposed: 1 });
    expect(proponer).toHaveBeenCalledTimes(2);
  });

  it('sigue las hojas en curso con el cerrojo', async () => {
    const vigilar = jest.fn().mockResolvedValue({
      reconciled: 1,
      completed: 0,
      etaRecalculated: 2,
      notStartedAlerts: 0,
    });
    const cron = new RoutePlanningCron(
      {} as unknown as RoutePlanService,
      {} as unknown as RoutePlanProposalService,
      conCerrojo as unknown as RedisService,
      { vigilar } as unknown as RouteSheetWatchService,
      nuevoAuto() as unknown as RoutePlanAutoConfirmService,
    );
    await expect(cron.seguir()).resolves.toMatchObject({ reconciled: 1 });
    expect(vigilar).toHaveBeenCalledTimes(1);
  });

  it('cierra los días vencidos', async () => {
    const { cron, plans } = armar([], jest.fn());
    await expect(cron.cerrarDias()).resolves.toEqual({ closed: 2 });
    expect(plans.cerrarDiasVencidos).toHaveBeenCalledTimes(1);
  });

  it('sin el cerrojo no hace nada', async () => {
    const proponer = jest.fn();
    const auto = nuevoAuto();
    const plans = { paraProponer: jest.fn(), cerrarDiasVencidos: jest.fn() };
    const cron = new RoutePlanningCron(
      plans as unknown as RoutePlanService,
      { proponer } as unknown as RoutePlanProposalService,
      {
        withLock: jest.fn().mockResolvedValue({ obtenido: false }),
      } as unknown as RedisService,
      { vigilar: jest.fn() } as unknown as RouteSheetWatchService,
      auto as unknown as RoutePlanAutoConfirmService,
    );
    await expect(cron.proponer()).resolves.toBeUndefined();
    expect(auto.confirmarLasVencidas).not.toHaveBeenCalled();
    await expect(cron.cerrarDias()).resolves.toBeUndefined();
    expect(plans.paraProponer).not.toHaveBeenCalled();
    expect(plans.cerrarDiasVencidos).not.toHaveBeenCalled();
  });

  it('en la misma pasada confirma lo vencido, después de proponer (reviewMinutes = 0 confirma lo recién propuesto)', async () => {
    const orden: string[] = [];
    const proponer = jest.fn(() => {
      orden.push('proponer');
      return Promise.resolve({ sheets: [{}], unassigned: [] });
    });
    const auto = nuevoAuto();
    auto.confirmarLasVencidas.mockImplementation(() => {
      orden.push('confirmar');
      return Promise.resolve({
        autoConfirmed: 2,
        autoConfirmFailed: 1,
        autoConfirmRetry: 0,
      });
    });
    const { cron } = armar(
      [{ distributorId: 'd1', planDate: '2026-11-14' }],
      proponer,
      auto,
    );
    await expect(cron.proponer()).resolves.toEqual({
      proposed: 1,
      noVehiclesAlerts: 0,
      autoConfirmed: 2,
      autoConfirmFailed: 1,
      autoConfirmRetry: 0,
    });
    expect(orden).toEqual(['proponer', 'confirmar']);
  });

  it('sin choferes ni vehículos: la propuesta automática lo avisa en la bandeja', async () => {
    const unassigned = [{ orderId: 'o1', reason: 'no_vehicles' }];
    const proponer = jest.fn().mockResolvedValue({ sheets: [], unassigned });
    const auto = nuevoAuto();
    auto.avisarSinHojaPosible.mockReturnValue(true);
    const { cron } = armar(
      [{ distributorId: 'd1', planDate: '2026-11-14' }],
      proponer,
      auto,
    );
    await expect(cron.proponer()).resolves.toMatchObject({
      noVehiclesAlerts: 1,
    });
    expect(auto.avisarSinHojaPosible).toHaveBeenCalledWith(
      'd1',
      '2026-11-14',
      unassigned,
      expect.any(Date),
    );
  });
});
