import { DataSource } from 'typeorm';
import {
  DeliveryKind,
  FailedVisitOutcome,
  FailedVisitReason,
  RevisitStatus,
} from './domain/nueva-visita';
import { FailedVisitQueryService } from './failed-visit-query.service';

function armar(filas: Array<Record<string, unknown>> = []) {
  const query = jest
    .fn()
    .mockResolvedValueOnce([{ total: filas.length }])
    .mockResolvedValueOnce(filas);
  const qb = {
    leftJoin: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawAndEntities: jest.fn(),
  };
  const ds = {
    query,
    getRepository: jest.fn(() => ({ createQueryBuilder: () => qb })),
  };
  return {
    svc: new FailedVisitQueryService(ds as unknown as DataSource),
    query,
    qb,
  };
}

const sqlDe = (query: jest.Mock, n: number): [string, unknown[]] =>
  query.mock.calls[n] as [string, unknown[]];

describe('FailedVisitQueryService.listar', () => {
  it('por omisión: sólo la distribuidora y los pedidos pendientes sin chofer con una nueva visita abierta, primero los que esperan al admin', async () => {
    const t = armar();
    const r = await t.svc.listar('dist', {});
    const [contar, paramsContar] = sqlDe(t.query, 0);
    const [listar, params] = sqlDe(t.query, 1);
    expect(contar).toContain(`o."distributor_id" = $1`);
    expect(contar).toContain(`o."failed_visit_count" > 0`);
    expect(contar).toContain(
      `o."status"::text = 'pending' AND o."delivery_id" IS NULL AND o."revisit_status" IS NOT NULL`,
    );
    expect(paramsContar).toEqual(['dist']);
    expect(listar).toContain(
      `ORDER BY (o."revisit_status" = 'awaiting_admin') DESC, v."failed_at" DESC`,
    );
    expect(params).toEqual(['dist', 20, 0]);
    expect(r).toEqual({ data: [], total: 0, limit: 20, offset: 0 });
  });

  it('filtra por estado, motivo, fechas y texto (escapando los comodines), siempre con parámetros', async () => {
    const t = armar();
    await t.svc.listar('dist', {
      status: RevisitStatus.AWAITING_ADMIN,
      reason: FailedVisitReason.REJECTED,
      from: '2026-11-01',
      to: '2026-11-30',
      term: ' 50%_a ',
      limit: 5,
      offset: 10,
    });
    const [sql, params] = sqlDe(t.query, 1);
    expect(sql).toContain(`o."revisit_status" = $2`);
    expect(sql).toContain(`v."reason" = $3`);
    expect(sql).toContain(`>= $4::date`);
    expect(sql).toContain(`<= $5::date`);
    expect(sql).toContain(`cu."full_name" ILIKE $6`);
    expect(params).toEqual([
      'dist',
      RevisitStatus.AWAITING_ADMIN,
      FailedVisitReason.REJECTED,
      '2026-11-01',
      '2026-11-30',
      '%50\\%\\_a%',
      5,
      10,
    ]);
  });

  it('`all` incluye los pedidos ya entregados o cancelados', async () => {
    const t = armar();
    await t.svc.listar('dist', { status: 'all' });
    expect(sqlDe(t.query, 0)[0]).not.toContain(`'pending'`);
  });

  it('arma cada renglón con la etiqueta del motivo y los números como números', async () => {
    const t = armar([
      {
        orderId: 'o1',
        orderStatus: 'pending',
        deliveryMode: 'standard',
        revisitStatus: 'awaiting_admin',
        failedVisitCount: '2',
        lastFailedAt: '2026-11-21T13:00:00.000Z',
        lastReason: 'address_closed',
        lastNote: null,
        lastDeliveryKind: 'single',
        lastDistanceMeters: '35',
        lastOutOfRange: false,
        customerName: 'Ana',
        total: '15000.00',
      },
    ]);
    const r = await t.svc.listar('dist', {});
    expect(r.total).toBe(1);
    expect(r.data[0]).toMatchObject({
      orderId: 'o1',
      revisitStatus: RevisitStatus.AWAITING_ADMIN,
      failedVisitCount: 2,
      lastReasonLabel: 'El domicilio estaba cerrado',
      lastDistanceMeters: 35,
      total: 15000,
      lastFailedAt: new Date('2026-11-21T13:00:00.000Z'),
    });
  });

  it('una visita informada sin ubicación deja la distancia en null', async () => {
    const t = armar([
      {
        orderId: 'o1',
        revisitStatus: null,
        failedVisitCount: 1,
        lastFailedAt: '2026-11-21T13:00:00.000Z',
        lastReason: 'other',
        lastDistanceMeters: null,
        lastOutOfRange: null,
        total: 1,
      },
    ]);
    const r = await t.svc.listar('dist', { status: 'all' });
    expect(r.data[0]).toMatchObject({
      revisitStatus: null,
      lastDistanceMeters: null,
      lastOutOfRange: false,
    });
  });
});

describe('FailedVisitQueryService.historial', () => {
  it('cada visita con su punto, distancia, quién la informó y los nombres de las franjas', async () => {
    const t = armar();
    t.qb.getRawAndEntities.mockResolvedValue({
      entities: [
        {
          failedVisitId: 'v2',
          orderId: 'o1',
          visitNumber: 1,
          deliveryKind: DeliveryKind.SINGLE,
          reason: FailedVisitReason.CUSTOMER_ABSENT,
          note: null,
          failedAt: new Date('2026-11-21T13:00:00Z'),
          point: { type: 'Point', coordinates: [-55.9, -27.36] },
          accuracyM: 9,
          distanceM: 11,
          outOfRange: false,
          reportedByRole: 'delivery',
          outcome: FailedVisitOutcome.PROPOSED,
          agreedWithCustomer: false,
          proposedDate: '2026-11-23',
          proposedTimeSlotId: 'tarde',
          resolution: null,
          resolvedAt: null,
          finalDate: null,
        },
        {
          failedVisitId: 'v1',
          reason: FailedVisitReason.OTHER,
          point: null,
          reportedByRole: 'admin',
          outcome: FailedVisitOutcome.REQUEUED,
        },
      ],
      raw: [
        {
          reportedByName: 'Juan',
          proposedTimeSlotName: 'Tarde',
          finalTimeSlotName: null,
        },
        {},
      ],
    });
    const r = await t.svc.historial('o1');
    expect(t.qb.where).toHaveBeenCalledWith('v.orderId = :orderId', {
      orderId: 'o1',
    });
    expect(r[0]).toMatchObject({
      failedVisitId: 'v2',
      reasonLabel: 'El cliente no estaba',
      latitude: -27.36,
      longitude: -55.9,
      accuracyMeters: 9,
      distanceMeters: 11,
      outOfRange: false,
      reportedByName: 'Juan',
      proposedDate: '2026-11-23',
      proposedTimeSlotName: 'Tarde',
      finalTimeSlotName: null,
      resolution: null,
    });
    expect(r[1]).toMatchObject({
      latitude: null,
      longitude: null,
      distanceMeters: null,
      reportedByName: null,
      note: null,
      agreedWithCustomer: false,
    });
  });
});
