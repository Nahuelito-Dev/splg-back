import { DataSource, EntityManager } from 'typeorm';

import { DispatchSettingsService } from '../../distributor/dispatch-settings.service';
import {
  Order,
  OrderDeliveryMode,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';
import { MOTIVO_VENCIMIENTO_SIN_CHOFER } from '../domain/vencimiento-sin-chofer';
import {
  CancelOrderOptions,
  CancelOrderUseCase,
} from './cancel-order.use-case';
import { VencimientoSinChoferService } from './vencimiento-sin-chofer.service';

const AHORA = new Date('2026-11-13T13:00:00.000Z');
const HACE = (min: number) => new Date(AHORA.getTime() - min * 60_000);

const bloqueado = (over: Partial<Order> = {}): Order =>
  ({
    orderId: 'o1',
    status: OrderStatus.PENDING,
    deliveryId: null,
    deliveryMode: OrderDeliveryMode.STANDARD,
    paymentMethod: PaymentMethod.CASH,
    paymentStatus: PaymentStatus.PENDING,
    depositPaid: false,
    paymentFraudHold: false,
    createdAt: HACE(500),
    availableSince: HACE(130),
    scheduledDate: null,
    timeSlotId: null,
    ...over,
  }) as Order;

describe('VencimientoSinChoferService', () => {
  let query: jest.Mock;
  let obtener: jest.Mock;
  let execute: jest.Mock<Promise<Partial<Order>>, unknown[]>;
  let service: VencimientoSinChoferService;

  beforeEach(() => {
    query = jest.fn();
    obtener = jest.fn().mockResolvedValue({ noDriverExpiryMinutes: 120 });
    execute = jest
      .fn<Promise<Partial<Order>>, unknown[]>()
      .mockResolvedValue({ status: OrderStatus.CANCELLED });
    service = new VencimientoSinChoferService(
      { query } as unknown as DataSource,
      { obtener } as unknown as DispatchSettingsService,
      { execute } as unknown as CancelOrderUseCase,
    );
  });

  it('cancela cada candidato como sistema, con el motivo para el cliente', async () => {
    query.mockResolvedValue([{ orderId: 'o1' }, { orderId: 'o2' }]);

    const vencidos = await service.vencer(['d1'], () => AHORA);

    expect(vencidos).toBe(2);
    expect(query).toHaveBeenCalledWith(expect.any(String), ['d1', 120, AHORA]);
    expect(execute).toHaveBeenCalledWith(
      'o1',
      'system',
      'system',
      MOTIVO_VENCIMIENTO_SIN_CHOFER,
      expect.objectContaining({
        siSigueCorrespondiendo: expect.any(Function) as unknown,
      }),
    );
  });

  it('un pedido que tira error no corta a los demás ni a la otra distribuidora', async () => {
    query
      .mockResolvedValueOnce([{ orderId: 'roto' }, { orderId: 'o2' }])
      .mockResolvedValueOnce([{ orderId: 'o3' }]);
    execute.mockImplementation((id) =>
      id === 'roto'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ status: OrderStatus.CANCELLED }),
    );

    const vencidos = await service.vencer(['d1', 'd2'], () => AHORA);

    expect(execute.mock.calls.map((c) => c[0])).toEqual(['roto', 'o2', 'o3']);
    expect(vencidos).toBe(2);
  });

  it('si falla la consulta de una distribuidora, sigue con la próxima', async () => {
    query
      .mockRejectedValueOnce(new Error('sin base'))
      .mockResolvedValueOnce([{ orderId: 'o3' }]);
    expect(await service.vencer(['d1', 'd2'], () => AHORA)).toBe(1);
  });

  it('no cuenta el que la condición bajo lock dejó como estaba', async () => {
    query.mockResolvedValue([{ orderId: 'o1' }]);
    execute.mockResolvedValue({ status: OrderStatus.ACCEPTED });
    expect(await service.vencer(['d1'], () => AHORA)).toBe(0);
  });

  describe('la condición bajo lock re-decide con la fila bloqueada', () => {
    const condicion = async (
      locked: Order,
      filas: (sql: string) => unknown[] = () => [],
    ): Promise<boolean> => {
      query.mockResolvedValue([{ orderId: locked.orderId }]);
      await service.vencer(['d1'], () => AHORA);
      const opciones = execute.mock.calls[0][4] as CancelOrderOptions;
      const siSigue = opciones.siSigueCorrespondiendo;
      if (!siSigue) throw new Error('falta la condición bajo lock');
      const manager = {
        query: jest.fn((sql: string) => Promise.resolve(filas(sql))),
      } as unknown as EntityManager;
      return siSigue(locked, manager);
    };

    it('sigue vencido: corresponde cancelar', async () => {
      expect(await condicion(bloqueado())).toBe(true);
    });

    it('un chofer lo aceptó en la ventana: no se cancela', async () => {
      expect(
        await condicion(
          bloqueado({ status: OrderStatus.ACCEPTED, deliveryId: 'c1' }),
        ),
      ).toBe(false);
    });

    it('se liberó recién (available_since nuevo): no se cancela', async () => {
      expect(await condicion(bloqueado({ availableSince: HACE(5) }))).toBe(
        false,
      );
    });

    it('lo reagendaron para más tarde: lee la franja bloqueada y no se cancela', async () => {
      expect(
        await condicion(
          bloqueado({ scheduledDate: '2026-11-13', timeSlotId: 'ts1' }),
          (sql) =>
            sql.includes('time_slot') ? [{ startTime: '09:30:00' }] : [],
        ),
      ).toBe(false);
      // 09:30 AR = 12:30 UTC: a las 13:00 UTC lleva 30 min, menos que 120.
    });

    it('agendado SIN franja fija (reprogramado por la hoja): la espera arranca al abrir la jornada, no a las 00:00', async () => {
      const jornada = (sql: string) =>
        sql.includes('min(j."startTime")') ? [{ startTime: '09:30:00' }] : [];
      expect(
        await condicion(
          bloqueado({ scheduledDate: '2026-11-13', timeSlotId: null }),
          jornada,
        ),
      ).toBe(false);
      // Sin franjas activas, desde las 00:00: ya venció.
      expect(
        await condicion(
          bloqueado({ scheduledDate: '2026-11-13', timeSlotId: null }),
          (sql) =>
            sql.includes('min(j."startTime")') ? [{ startTime: null }] : [],
        ),
      ).toBe(true);
    });

    it('C5: una entrega fallida que espera la decisión del admin no vence sola (ni en la consulta ni con la fila bloqueada)', async () => {
      expect(
        await condicion(
          bloqueado({ revisitStatus: 'awaiting_admin' } as Partial<Order>),
        ),
      ).toBe(false);
      expect((query.mock.calls as unknown[][])[0][0]).toContain(
        `o."revisit_status" IS DISTINCT FROM 'awaiting_admin'`,
      );
    });

    it('la consulta de candidatos usa la jornada para los agendados sin franja', async () => {
      query.mockResolvedValue([]);
      await service.vencer(['d1'], () => AHORA);
      expect((query.mock.calls as unknown[][])[0][0]).toContain(
        'COALESCE(ts."startTime", (SELECT min(j."startTime")',
      );
    });

    it('entró a un lote de recorrido vivo: no se cancela', async () => {
      expect(
        await condicion(bloqueado(), (sql) =>
          sql.includes('route_batch_stop') ? [{ '?column?': 1 }] : [],
        ),
      ).toBe(false);
    });
  });
});
