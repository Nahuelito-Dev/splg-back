import { Order } from '../order/entities/order.entity';
import { RepurchaseEstimateSource } from './domain/estimacion-de-recompra';
import { RepurchaseAcceptService } from './repurchase-accept.service';
import { RepurchaseAdminController } from './repurchase-admin.controller';
import { RepurchaseCustomerController } from './repurchase-customer.controller';
import { RepurchaseCustomerService } from './repurchase-customer.service';
import { RepurchaseForecastService } from './repurchase-forecast.service';
import { RepurchaseReportService } from './repurchase-report.service';
import {
  RepurchaseInvitation,
  RepurchaseInvitationStatus as Estado,
} from './entities/repurchase-invitation.entity';
import { RecompraEstimada } from './repurchase-estimator.service';

const DETALLE = {
  garrafas: new Map(),
  direccion: null,
  franja: null,
  cotizacion: null,
};

const invitacion = (
  parcial: Partial<RepurchaseInvitation> = {},
): RepurchaseInvitation =>
  ({
    invitationId: 'i1',
    distributorId: 'd1',
    userId: 'u1',
    status: Estado.PENDING,
    estimateSource: RepurchaseEstimateSource.HISTORY,
    suggestedItems: [{ gasCylinderId: 'g', quantity: 2 }],
    projectedDepletionAt: new Date('2026-11-02T00:00:00Z'),
    expiresAt: new Date('2026-11-01T00:00:00Z'),
    createdAt: new Date('2026-10-31T00:00:00Z'),
    respondedAt: null,
    orderId: null,
    user: { fullName: 'Lucía' },
    ...parcial,
  }) as RepurchaseInvitation;

const cliente = (): RecompraEstimada =>
  ({
    userId: 'u1',
    fullName: 'Lucía',
    estimate: {
      estimatedAt: new Date(Date.now() + 2 * 86_400_000),
      source: RepurchaseEstimateSource.HISTORY,
      kgPerDay: 1,
      ordersUsed: 3,
      lastDeliveredAt: new Date(),
      lastKg: 10,
    },
    habits: { items: [{ gasCylinderId: 'g', quantity: 1 }] },
    noticeDays: 3,
    noticeEnabled: true,
  }) as unknown as RecompraEstimada;

describe('RepurchaseAdminController', () => {
  let report: {
    proximas: jest.Mock;
    delCliente: jest.Mock;
    listar: jest.Mock;
    resumen: jest.Mock;
  };
  let forecast: { ejecutar: jest.Mock };
  let controller: RepurchaseAdminController;

  beforeEach(() => {
    report = {
      proximas: jest.fn().mockResolvedValue({ filas: [], total: 0 }),
      delCliente: jest.fn(),
      listar: jest.fn().mockResolvedValue([[], 0]),
      resumen: jest.fn(),
    };
    forecast = {
      ejecutar: jest.fn().mockResolvedValue({
        evaluated: 0,
        invited: 0,
        expired: 0,
        skipped: {},
        candidates: [],
      }),
    };
    controller = new RepurchaseAdminController(
      report as unknown as RepurchaseReportService,
      forecast as unknown as RepurchaseForecastService,
    );
  });

  it('forecast: ventana de 14 días y página de 20 por omisión', async () => {
    const r = await controller.proximas({}, 'd1');
    expect(report.proximas).toHaveBeenCalledWith(
      'd1',
      14,
      { limit: 20, offset: 0 },
      expect.any(Date),
    );
    expect(r).toMatchObject({ data: [], total: 0, days: 14 });
  });

  it('forecast: arma las filas con la invitación abierta', async () => {
    report.proximas.mockResolvedValue({
      filas: [{ cliente: cliente(), abierta: invitacion() }],
      total: 1,
    });
    const r = await controller.proximas(
      { days: 30, limit: 5, offset: 2 },
      'd1',
    );
    expect(report.proximas).toHaveBeenCalledWith(
      'd1',
      30,
      { limit: 5, offset: 2 },
      expect.any(Date),
    );
    expect(r.data[0].openInvitation?.invitationId).toBe('i1');
    expect(r.data[0].customer.userId).toBe('u1');
  });

  it('forecast de un cliente: con estimación', async () => {
    report.delCliente.mockResolvedValue({
      evaluacion: { cliente: cliente(), reason: null },
      abierta: null,
    });
    const r = await controller.delCliente('u1', 'd1');
    expect(r.forecast?.customer.userId).toBe('u1');
    expect(r.reason).toBeNull();
  });

  it('forecast de un cliente: sin estimación explica por qué', async () => {
    report.delCliente.mockResolvedValue({
      evaluacion: { cliente: null, reason: 'no_purchases' },
      abierta: null,
    });
    expect(await controller.delCliente('u1', 'd1')).toEqual({
      forecast: null,
      reason: 'no_purchases',
    });
  });

  it('invitaciones: las de la distribuidora con el cliente', async () => {
    report.listar.mockResolvedValue([[invitacion()], 1]);
    const query = { status: Estado.PENDING };
    const r = await controller.invitaciones(query, 'd1');
    expect(report.listar).toHaveBeenCalledWith('d1', query);
    expect(r.total).toBe(1);
    expect(r.data[0]).toMatchObject({ invitationId: 'i1', totalUnits: 2 });
  });

  it('stats: el resumen del período', async () => {
    report.resumen.mockResolvedValue({
      resumen: {
        counts: {
          pending: 0,
          accepted: 1,
          rejected: 0,
          expired: 0,
          cancelled: 0,
        },
        acceptedRevenue: 100,
      },
      accuracy: {
        measured: 2,
        meanAbsoluteErrorDays: 1.5,
        withinMarginRate: 1,
        marginDays: 3,
        meanBiasDays: -0.5,
      },
      desde: new Date('2026-10-01T03:00:00Z'),
      hasta: new Date('2026-11-01T03:00:00Z'),
    });
    const r = await controller.stats({ from: '2026-10-01' }, 'd1');
    expect(report.resumen).toHaveBeenCalledWith(
      'd1',
      '2026-10-01',
      undefined,
      expect.any(Date),
    );
    expect(r).toMatchObject({ sent: 1, accepted: 1, conversionRate: 1 });
    expect(r.accuracy).toMatchObject({ measured: 2, meanBiasDays: -0.5 });
  });

  it('run: corre la anticipación de la distribuidora, simulada si se pide', async () => {
    await controller.correr({ dryRun: true }, 'd1');
    expect(forecast.ejecutar).toHaveBeenCalledWith('d1', expect.any(Date), {
      dryRun: true,
    });
    await controller.correr({}, 'd1');
    expect(forecast.ejecutar).toHaveBeenLastCalledWith('d1', expect.any(Date), {
      dryRun: undefined,
    });
  });
});

describe('RepurchaseCustomerController', () => {
  let customer: {
    miRecompra: jest.Mock;
    aviso: jest.Mock;
    actualizarAviso: jest.Mock;
    listar: jest.Mock;
    una: jest.Mock;
    conDetalle: jest.Mock;
  };
  let accept: { aceptar: jest.Mock; descartar: jest.Mock };
  let controller: RepurchaseCustomerController;

  const aviso = { enabled: true, days: null, distributorDays: 3 };

  beforeEach(() => {
    customer = {
      miRecompra: jest.fn().mockResolvedValue({
        estimacion: null,
        reason: 'no_purchases',
        aviso,
        abierta: null,
      }),
      aviso: jest.fn().mockResolvedValue(aviso),
      actualizarAviso: jest.fn().mockResolvedValue(aviso),
      listar: jest
        .fn()
        .mockResolvedValue([{ invitacion: invitacion(), detalle: DETALLE }]),
      una: jest
        .fn()
        .mockResolvedValue({ invitacion: invitacion(), detalle: DETALLE }),
      conDetalle: jest
        .fn()
        .mockResolvedValue({ invitacion: invitacion(), detalle: DETALLE }),
    };
    accept = {
      descartar: jest
        .fn()
        .mockResolvedValue(invitacion({ status: Estado.REJECTED })),
      aceptar: jest.fn().mockResolvedValue({
        invitation: invitacion({ status: Estado.ACCEPTED }),
        order: { orderId: 'o1', orderItems: [] } as unknown as Order,
        paymentUrl: 'https://mp',
      }),
    };
    controller = new RepurchaseCustomerController(
      customer as unknown as RepurchaseCustomerService,
      accept as unknown as RepurchaseAcceptService,
    );
  });

  it('mi recompra: la del cliente del token en la distribuidora del header', async () => {
    const r = await controller.miRecompra('u1', 'd1');
    expect(customer.miRecompra).toHaveBeenCalledWith(
      'u1',
      'd1',
      expect.any(Date),
    );
    expect(r).toMatchObject({ estimatedAt: null, reason: 'no_purchases' });
    expect(r.notice.effectiveDays).toBe(3);
  });

  it('el aviso se lee y se cambia (CU-145)', async () => {
    expect((await controller.aviso('u1', 'd1')).effectiveDays).toBe(3);
    await controller.actualizarAviso({ days: 5 }, 'u1', null);
    expect(customer.actualizarAviso).toHaveBeenCalledWith(
      'u1',
      { days: 5 },
      null,
    );
  });

  it('lista las abiertas por omisión y todas con all=true', async () => {
    const r = await controller.invitaciones(undefined, 'u1', 'd1');
    expect(r).toHaveLength(1);
    expect(customer.listar).toHaveBeenCalledWith(
      'u1',
      'd1',
      true,
      expect.any(Date),
    );
    await controller.invitaciones('true', 'u1', null);
    expect(customer.listar).toHaveBeenLastCalledWith(
      'u1',
      null,
      false,
      expect.any(Date),
    );
  });

  it('una invitación', async () => {
    expect((await controller.invitacion('i1', 'u1')).invitationId).toBe('i1');
    expect(customer.una).toHaveBeenCalledWith('u1', 'i1');
  });

  it('aceptar: el pedido sale con el contrato de pedidos y la invitación aceptada', async () => {
    const r = await controller.aceptar('i1', { timeSlotId: 't1' }, 'u1');
    expect(accept.aceptar).toHaveBeenCalledWith('i1', 'u1', {
      timeSlotId: 't1',
    });
    expect(r.order.id).toBe('o1');
    expect(r.order.paymentUrl).toBe('https://mp');
    expect(customer.conDetalle).toHaveBeenCalled();
    expect(r.invitation.invitationId).toBe('i1');
  });

  it('descartar devuelve la invitación descartada', async () => {
    customer.conDetalle.mockResolvedValueOnce({
      invitacion: invitacion({ status: Estado.REJECTED }),
      detalle: DETALLE,
    });
    const r = await controller.descartar('i1', 'u1');
    expect(accept.descartar).toHaveBeenCalledWith('i1', 'u1');
    expect(r.status).toBe(Estado.REJECTED);
  });
});
