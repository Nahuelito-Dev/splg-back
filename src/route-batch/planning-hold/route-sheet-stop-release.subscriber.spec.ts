import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, QueryRunner, UpdateEvent } from 'typeorm';
import { Order, OrderStatus } from '../../order/entities/order.entity';
import {
  EVENTO_PARADA_EN_CURSO,
  RouteSheetStopReleaseSubscriber,
  causaEnCurso,
} from './route-sheet-stop-release.subscriber';

const S = OrderStatus;

describe('causaEnCurso', () => {
  const c = (
    antes: [OrderStatus, string | null],
    despues: [OrderStatus, string | null],
  ) =>
    causaEnCurso(
      { status: antes[0], deliveryId: antes[1] },
      { status: despues[0], deliveryId: despues[1] },
    );

  it.each([
    [[S.ACCEPTED, 'd1'], [S.CANCELLED, 'd1'], 'cancelled'],
    [[S.ON_THE_WAY, 'd1'], [S.CANCELLED, 'd1'], 'cancelled'],
    [[S.ACCEPTED, 'd1'], [S.PENDING, null], 'released'],
    [[S.ON_THE_WAY, 'd1'], [S.PENDING, null], 'released'],
    [[S.ACCEPTED, 'd1'], [S.ACCEPTED, 'd2'], 'reassigned'],
    [[S.PENDING, null], [S.ACCEPTED, 'd2'], 'reassigned'],
    [[S.ON_THE_WAY, 'd1'], [S.DELIVERED, 'd1'], 'delivered'],
    [[S.ACCEPTED, 'd1'], [S.ON_THE_WAY, 'd1'], 'on_the_way'],
  ] as const)('%j → %j es %s', (antes, despues, esperado) => {
    expect(c([...antes], [...despues])).toBe(esperado);
  });

  it.each([
    [
      [S.CANCELLED, null],
      [S.CANCELLED, null],
    ],
    [
      [S.RESERVED, null],
      [S.PENDING, null],
    ],
    [
      [S.PENDING, null],
      [S.PENDING, null],
    ],
    [
      [S.ACCEPTED, 'd1'],
      [S.ACCEPTED, 'd1'],
    ],
    [
      [S.ACCEPTED, 'd1'],
      [S.ACCEPTED, null],
    ],
  ] as const)('%j → %j no le importa a la hoja', (antes, despues) => {
    expect(c([...antes], [...despues])).toBeNull();
  });
});

describe('RouteSheetStopReleaseSubscriber', () => {
  const armar = (devuelve: unknown[] = []) => {
    const ds = { subscribers: [] as unknown[] };
    const events = { emit: jest.fn() };
    const sub = new RouteSheetStopReleaseSubscriber(
      ds as unknown as DataSource,
      events as unknown as EventEmitter2,
    );
    const query = jest.fn<Promise<unknown[]>, [string, unknown[]]>(() =>
      Promise.resolve(devuelve),
    );
    const qr = { isTransactionActive: true } as unknown as QueryRunner;
    const evento = (
      antes: [OrderStatus, string | null] | null,
      despues: [OrderStatus, string | null] | null,
      runner: QueryRunner | undefined = qr,
    ) =>
      ({
        entity: despues
          ? { orderId: 'o1', status: despues[0], deliveryId: despues[1] }
          : undefined,
        databaseEntity: antes
          ? { orderId: 'o1', status: antes[0], deliveryId: antes[1] }
          : undefined,
        manager: { query },
        queryRunner: runner,
      }) as unknown as UpdateEvent<Order>;
    return { ds, sub, query, evento, events, qr };
  };

  it('se registra en el DataSource y escucha los pedidos', () => {
    const { ds, sub } = armar();
    expect(ds.subscribers).toContain(sub);
    expect(sub.listenTo()).toBe(Order);
  });

  it.each([
    [OrderStatus.CANCELLED, 'cancelled'],
    [OrderStatus.DELIVERED, 'unavailable'],
  ])(
    'al pasar a %s saca la parada de la hoja en borrador o confirmada, en la misma transacción',
    async (estado, motivo) => {
      const { sub, query, evento } = armar();
      await sub.afterUpdate(evento([S.PENDING, null], [estado, null]));
      const [sql, params] = query.mock.calls[0];
      expect(params).toEqual(['o1', motivo]);
      expect(sql).toContain(
        `b."kind" = 'planned' AND b."status" IN ('draft', 'confirmed')`,
      );
      expect(sql).toContain('"active" = false');
    },
  );

  it('otros cambios (o sin cambio de estado) no tocan las paradas', async () => {
    const { sub, query, evento } = armar();
    await sub.afterUpdate(evento([S.RESERVED, null], [S.PENDING, null]));
    await sub.afterUpdate(evento([S.CANCELLED, null], [S.CANCELLED, null]));
    await sub.afterUpdate(evento(null, [S.CANCELLED, null]));
    await sub.afterUpdate(evento([S.PENDING, null], null));
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['released', [S.ACCEPTED, 'd1'], [S.PENDING, null], 'needs_reschedule'],
    ['cancelled', [S.ACCEPTED, 'd1'], [S.CANCELLED, 'd1'], 'cancelled'],
    ['reassigned', [S.ACCEPTED, 'd1'], [S.ACCEPTED, 'd2'], 'reassigned'],
  ] as const)(
    'hoja en curso: %s saca la parada (sólo activas de hojas assigned) y avisa después del commit',
    async (causa, antes, despues, motivo) => {
      const { sub, query, evento, events, qr } = armar([{ batchId: 'h1' }]);
      await sub.afterUpdate(evento([...antes], [...despues]));
      const llamada = query.mock.calls.find((c) =>
        String(c[0]).includes(`b."status" = 'assigned'`),
      ) as [string, unknown[]];
      expect(llamada[0]).toContain('"active" = false');
      expect(llamada[0]).toContain('s."active"');
      expect(llamada[1]).toEqual([
        'o1',
        motivo,
        causa === 'reassigned' ? 'd2' : null,
      ]);
      // Nada sale antes del commit.
      expect(events.emit).not.toHaveBeenCalled();
      sub.afterTransactionCommit({ queryRunner: qr } as never);
      expect(events.emit).toHaveBeenCalledWith(EVENTO_PARADA_EN_CURSO, {
        batchId: 'h1',
        orderId: 'o1',
        cause: causa,
      });
      // Un segundo commit del mismo runner no repite el aviso.
      sub.afterTransactionCommit({ queryRunner: qr } as never);
      expect(events.emit).toHaveBeenCalledTimes(1);
    },
  );

  it('reasignado: sólo si el chofer nuevo no es el de la hoja', async () => {
    const { sub, query, evento } = armar([]);
    await sub.afterUpdate(evento([S.PENDING, null], [S.ACCEPTED, 'd2']));
    const [sql] = query.mock.calls.find((c) =>
      String(c[0]).includes(`'assigned'`),
    ) as [string, unknown[]];
    expect(sql).toContain('IS DISTINCT FROM $3::uuid');
  });

  it('entregado: la parada se queda (sólo se busca la hoja) y se avisa', async () => {
    const { sub, query, evento, events, qr } = armar([{ batchId: 'h1' }]);
    await sub.afterUpdate(evento([S.ON_THE_WAY, 'd1'], [S.DELIVERED, 'd1']));
    const enCurso = query.mock.calls.find((c) =>
      String(c[0]).includes(`b."status" = 'assigned'`),
    ) as [string, unknown[]];
    expect(enCurso[0]).toMatch(/^\s*SELECT/);
    sub.afterTransactionCommit({ queryRunner: qr } as never);
    expect(events.emit).toHaveBeenCalledWith(EVENTO_PARADA_EN_CURSO, {
      batchId: 'h1',
      orderId: 'o1',
      cause: 'delivered',
    });
  });

  it('si la transacción se revierte, no avisa', async () => {
    const { sub, evento, events, qr } = armar([{ batchId: 'h1' }]);
    await sub.afterUpdate(evento([S.ACCEPTED, 'd1'], [S.ON_THE_WAY, 'd1']));
    sub.afterTransactionRollback({ queryRunner: qr } as never);
    sub.afterTransactionCommit({ queryRunner: qr } as never);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('sin transacción abierta avisa enseguida; sin hoja en curso, nada', async () => {
    const { sub, evento, events } = armar([{ batchId: 'h1' }]);
    await sub.afterUpdate(
      evento([S.ACCEPTED, 'd1'], [S.ON_THE_WAY, 'd1'], {
        isTransactionActive: false,
      } as unknown as QueryRunner),
    );
    expect(events.emit).toHaveBeenCalledTimes(1);
    const vacio = armar([]);
    await vacio.sub.afterUpdate(
      vacio.evento([S.ACCEPTED, 'd1'], [S.ON_THE_WAY, 'd1']),
    );
    vacio.sub.afterTransactionCommit({ queryRunner: vacio.qr } as never);
    expect(vacio.events.emit).not.toHaveBeenCalled();
  });

  it('un aviso que falla no rompe el commit', async () => {
    const { sub, evento, events, qr } = armar([{ batchId: 'h1' }]);
    events.emit.mockImplementation(() => {
      throw new Error('bus caído');
    });
    await sub.afterUpdate(evento([S.ACCEPTED, 'd1'], [S.ON_THE_WAY, 'd1']));
    expect(() =>
      sub.afterTransactionCommit({ queryRunner: qr } as never),
    ).not.toThrow();
  });
});
