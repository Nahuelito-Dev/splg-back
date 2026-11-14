import { CoverageZoneExpiryCron } from '../coverage-zone/coverage-zone-expiry.cron';
import { CylinderRecoveryCron } from '../cylinder/recovery/cylinder-recovery.cron';
import { DriverSettlementCron } from '../driver-settlement/application/driver-settlement.cron';
import { FinanceReconciliationCron } from '../finance/application/finance-reconciliation.cron';
import { MaintenancePlannerCron } from '../fleet/planner/maintenance-planner.cron';
import { VehicleUsageCron } from '../fleet/planner/vehicle-usage.cron';
import { MpReconciliationCron } from '../mp-reconciliation/application/mp-reconciliation.cron';
import { ReceiverRetentionCron } from '../order/application/receiver-retention.cron';
import { DispatchService } from '../order/dispatch.service';
import { RepurchaseCron } from '../repurchase-forecast/repurchase.cron';
import { RouteBatchCron } from '../route-batch/route-batch.cron';
import { RoutePlanningCron } from '../route-batch/route-planning.cron';
import { StockLowCron } from '../stock/application/stock-low.cron';
import { StockReconciliationCron } from '../stock/application/stock-reconciliation.cron';
import { dentroDeCorrida, nuevaCorrida } from './process-run.context';

/**
 * Cada proceso con cerrojo avisa al registrador cuando no lo consigue: esa
 * corrida no hizo nada y no puede pasar por una corrida válida (`ok` con `{}`),
 * porque taparía a la de otra instancia que falló.
 */
const sinCerrojo = () => ({
  withLock: jest.fn().mockResolvedValue({ obtenido: false }),
  acquireLock: jest.fn().mockResolvedValue(null),
});
const nada = {} as never;

const corridaObservada = async (fn: () => Promise<unknown>) => {
  const estado = nuevaCorrida();
  await dentroDeCorrida(estado, fn);
  return estado;
};

type Caso = [string, () => Promise<unknown>];

const casos = (): Caso[] => {
  const r = sinCerrojo() as never;
  const recompra = new RepurchaseCron(nada, nada, nada, r, nada);
  const lotes = new RouteBatchCron(nada, r, nada);
  const planificador = new MaintenancePlannerCron(nada, r, nada);
  return [
    ['M3 recompra: anticipar', () => recompra.anticipar()],
    ['M3 recompra: vencer', () => recompra.vencer()],
    ['M4 recorridos: armar', () => lotes.armar()],
    ['M4 recorridos: vencer', () => lotes.vencer()],
    [
      'M4 hoja de ruta: proponer',
      () => new RoutePlanningCron(nada, nada, r, nada, nada, nada).proponer(),
    ],
    [
      'M4 hoja de ruta: cerrar días',
      () => new RoutePlanningCron(nada, nada, r, nada, nada, nada).cerrarDias(),
    ],
    ['M2 planificador: planificar', () => planificador.planificar()],
    [
      'M2 planificador: vencer propuestas',
      () => planificador.vencerPropuestas(),
    ],
    ['M2 uso de vehículos', () => new VehicleUsageCron(nada, r).alimentar()],
    [
      'M5 recupero de envases',
      () => new CylinderRecoveryCron(nada, r, nada).recuperar(),
    ],
    [
      'zonas de cobertura vencidas',
      () => new CoverageZoneExpiryCron(nada, r, nada).desactivarVencidas(),
    ],
    [
      'conciliación de MP',
      () => new MpReconciliationCron(nada, r).sincronizarPendientes(),
    ],
    [
      'retención de datos del receptor',
      () => new ReceiverRetentionCron(nada, r).anularVencidos(),
    ],
    [
      'rendiciones: generar',
      () =>
        new DriverSettlementCron(
          nada,
          nada,
          nada,
          nada,
          r,
        ).generarRendicionesDelDia(),
    ],
    [
      'rendiciones: avisar',
      () =>
        new DriverSettlementCron(
          nada,
          nada,
          nada,
          nada,
          r,
        ).avisarRendicionesSinCerrar(),
    ],
    [
      'conciliación de finanzas',
      () => new FinanceReconciliationCron(nada, nada, nada, r).conciliar(),
    ],
    [
      'conciliación de stock',
      () => new StockReconciliationCron(nada, nada, r).conciliarTodas(),
    ],
    [
      'aviso de stock bajo',
      () => new StockLowCron(nada, nada, r).avisarStockBajo(),
    ],
    [
      'M1 despacho',
      () => new DispatchService(nada, r, nada, nada, nada, nada).tick(),
    ],
  ];
};

describe('sin cerrojo, la corrida queda salteada', () => {
  it.each(casos())('%s', async (_nombre, correr) => {
    const estado = await corridaObservada(correr);
    expect(estado.skipped).toBe(true);
    expect(estado.errors).toBe(0);
  });

  it('con el cerrojo tomado la corrida no queda salteada (control)', async () => {
    const redis = {
      withLock: jest.fn((_k: string, _t: number, fn: () => Promise<unknown>) =>
        fn().then((valor) => ({ obtenido: true, valor })),
      ),
    } as never;
    const zonas = {
      manager: {
        transaction: jest.fn().mockResolvedValue({ zonas: [], sinZonas: [] }),
      },
    } as never;
    const estado = await corridaObservada(() =>
      new CoverageZoneExpiryCron(zonas, redis, nada).desactivarVencidas(),
    );
    expect(estado.skipped).toBe(false);
  });
});
