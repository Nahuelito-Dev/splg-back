import { RoleType } from '../../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { MpReconciliationApplyService } from '../application/mp-reconciliation-apply.service';
import type { MpReconciliationService } from '../application/mp-reconciliation.service';
import { MpReconciliationStatus } from '../domain/mp-reconciliation.enums';
import type { MpReconciliationItem } from '../entities/mp-reconciliation-item.entity';
import type { MpReconciliation } from '../entities/mp-reconciliation.entity';
import { MpReconciliationMapper } from '../mp-reconciliation.mapper';
import { MpReconciliationController } from './mp-reconciliation.controller';

const usuario = (role: RoleType): AuthenticatedUser => ({
  user_id: 'u-1',
  email: 'a@b.c',
  role,
});

const corrida = {
  reconciliationId: 'rec-1',
  fromDate: '2026-10-01',
  toDate: '2026-10-10',
  status: MpReconciliationStatus.READY,
  failureReason: null,
  summary: {
    rows: 2,
    mp: { gross: 3000, fees: 150, taxes: 0, net: 2850 },
    cash: { income: 1000, expense: 50, net: 950 },
    differences: { payment_not_in_cash: 1 },
    alreadyApplied: 0,
    unreadableRows: 0,
    account: { rows: 3, credit: 10, debit: 20 },
  },
  reportAttachmentId: 'adj-1',
  readyAt: new Date('2026-10-11T12:00:00Z'),
  lastCheckedAt: null,
  createdAt: new Date('2026-10-11T11:00:00Z'),
  includeAccountLevel: true,
} as unknown as MpReconciliation;

describe('MpReconciliationController', () => {
  let conciliaciones: Record<string, jest.Mock>;
  let aplicador: { aplicar: jest.Mock };
  let controller: MpReconciliationController;

  beforeEach(() => {
    conciliaciones = {
      crear: jest.fn().mockResolvedValue(corrida),
      listar: jest.fn().mockResolvedValue({ data: [corrida], total: 1 }),
      detalle: jest.fn().mockResolvedValue({
        corrida,
        items: [
          {
            itemId: 'i-1',
            kind: 'payout',
            accountLevel: true,
            mpAmount: 9997,
            status: 'pending',
          } as unknown as MpReconciliationItem,
        ],
      }),
      enlaceDelReporte: jest
        .fn()
        .mockResolvedValue({ url: 'https://s3/x', expiresAt: null }),
    };
    aplicador = { aplicar: jest.fn().mockResolvedValue({ applied: 1 }) };
    controller = new MpReconciliationController(
      conciliaciones as unknown as MpReconciliationService,
      aplicador as unknown as MpReconciliationApplyService,
    );
  });

  it('crea con la distribuidora y el rol de quien pide', async () => {
    const r = await controller.crear(
      { from: '2026-10-01', to: '2026-10-10' },
      'dist-1',
      usuario(RoleType.ADMIN),
    );

    expect(conciliaciones.crear).toHaveBeenCalledWith(
      { from: '2026-10-01', to: '2026-10-10' },
      { distributorId: 'dist-1', userId: 'u-1', role: RoleType.ADMIN },
    );
    expect(r).toMatchObject({
      reconciliationId: 'rec-1',
      from: '2026-10-01',
      to: '2026-10-10',
      hasReport: true,
    });
  });

  it('el resumen de la cuenta sólo llega al super admin', async () => {
    const admin = await controller.listar(
      {},
      'dist-1',
      usuario(RoleType.ADMIN),
    );
    const superAdmin = await controller.listar(
      {},
      'dist-1',
      usuario(RoleType.SUPER_ADMIN),
    );

    expect(admin.data[0].summary?.account).toBeUndefined();
    expect(superAdmin.data[0].summary?.account).toEqual({
      rows: 3,
      credit: 10,
      debit: 20,
    });
    expect(superAdmin.total).toBe(1);
  });

  it('el detalle trae las diferencias que el servicio dejó ver', async () => {
    const r = await controller.detalle(
      'rec-1',
      'dist-1',
      usuario(RoleType.SUPER_ADMIN),
    );

    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ itemId: 'i-1', accountLevel: true });
  });

  it('aplica con el contexto y devuelve el enlace firmado del reporte', async () => {
    await controller.aplicar(
      'rec-1',
      { items: [{ itemId: 'i-1' }] },
      'dist-1',
      usuario(RoleType.ADMIN),
    );
    const enlace = await controller.reporte(
      'rec-1',
      'dist-1',
      usuario(RoleType.ADMIN),
    );

    expect(aplicador.aplicar).toHaveBeenCalledWith(
      'rec-1',
      { items: [{ itemId: 'i-1' }] },
      { distributorId: 'dist-1', userId: 'u-1', role: RoleType.ADMIN },
    );
    expect(enlace).toEqual({
      url: 'https://s3/x',
      expiresAt: null,
      requiresAuth: false,
    });
  });
});

describe('MpReconciliationMapper: qué dice una corrida que espera', () => {
  const espera = (cambios: Partial<MpReconciliation>) =>
    MpReconciliationMapper.corrida(
      {
        ...corrida,
        status: MpReconciliationStatus.REQUESTED,
        summary: null,
        ...cambios,
      } as MpReconciliation,
      false,
    );

  it('sin consulta todavía, dice que no se consultó', () => {
    expect(
      espera({ lastCheckedAt: null, failureReason: null }).statusNote,
    ).toBe('Todavía no se consultó a Mercado Pago.');
  });

  it('si ya se consultó y no figura, dice que Mercado Pago todavía no generó el reporte', () => {
    expect(
      espera({ lastCheckedAt: new Date(), failureReason: null }).statusNote,
    ).toMatch(/todavía no generó el reporte/);
  });

  it('si hubo un error en el último intento, lo dice (y no lo confunde con una falla)', () => {
    const r = espera({
      failureReason: 'Mercado Pago no respondió a tiempo. Se reintenta.',
    });

    expect(r.statusNote).toBe(
      'Mercado Pago no respondió a tiempo. Se reintenta.',
    );
    expect(r.failureReason).toBeNull();
  });

  it('una lista o fallida no trae nota', () => {
    expect(
      MpReconciliationMapper.corrida(corrida, false).statusNote,
    ).toBeNull();
  });
});

describe('MpReconciliationMapper: los totales del resumen los manda el back', () => {
  const conResumen = (
    differences: Record<string, number>,
    mp: number,
    cash: number,
  ) =>
    MpReconciliationMapper.corrida(
      {
        ...corrida,
        status: MpReconciliationStatus.READY,
        summary: {
          rows: 4,
          mp: { gross: 0, fees: 0, taxes: 0, net: mp },
          cash: { income: 0, expense: 0, net: cash },
          differences,
          alreadyApplied: 0,
          unreadableRows: 0,
        },
      } as MpReconciliation,
      false,
    ).summary;

  it('suma las diferencias de todos los tipos', () => {
    expect(
      conResumen({ payment_not_in_cash: 2, fee_pending: 1, payout: 4 }, 0, 0)
        ?.differenceCount,
    ).toBe(7);
    expect(conResumen({}, 0, 0)?.differenceCount).toBe(0);
  });

  it('la brecha neta es Mercado Pago − caja, a centavos', () => {
    expect(conResumen({}, 100.1, 100.3)?.netGap).toBe(-0.2);
    expect(conResumen({}, 1200, 1000)?.netGap).toBe(200);
  });
});
