import { ForbiddenException } from '@nestjs/common';
import { UnpaidCashService } from './unpaid-cash.service';
import {
  Incident,
  IncidentMoment,
  IncidentStatus,
  IncidentType,
} from './entities/incident.entity';
import { Order, PaymentStatus } from '../order/entities/order.entity';

describe('UnpaidCashService', () => {
  let svc: UnpaidCashService;
  let repo: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock };
  let orders: { assertDeLaDistribuidora: jest.Mock };
  let cash: { markUnpaid: jest.Mock };
  let gateway: { notifyAdmins: jest.Mock };

  const order = {
    orderId: 'ord-1',
    distributorId: 'dist-1',
    paymentStatus: PaymentStatus.UNPAID,
  } as unknown as Order;

  beforeEach(() => {
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x: Partial<Incident>) => x),
      save: jest.fn((x: Partial<Incident>) =>
        Promise.resolve({ ...x, incidentId: 'inc-1' }),
      ),
    };
    const manager = { getRepository: jest.fn(() => repo) };
    orders = {
      assertDeLaDistribuidora: jest.fn().mockResolvedValue(undefined),
    };
    // Simula la transacción: corre el trabajo adicional con el manager.
    cash = {
      markUnpaid: jest.fn(
        async (
          _id: string,
          _u: string,
          dentro: (m: unknown, o: Order) => Promise<unknown>,
        ) => ({ order, changed: true, extra: await dentro(manager, order) }),
      ),
    };
    gateway = { notifyAdmins: jest.fn() };
    svc = new UnpaidCashService(
      orders as never,
      cash as never,
      gateway as never,
    );
  });

  it('crea la incidencia DENTRO de la transacción del pago y avisa a los admins después', async () => {
    const r = await svc.report(
      'ord-1',
      { note: ' no tenía plata ' },
      'u-1',
      'dist-1',
    );
    expect(orders.assertDeLaDistribuidora).toHaveBeenCalledWith(
      'ord-1',
      'dist-1',
    );
    expect(cash.markUnpaid).toHaveBeenCalledWith(
      'ord-1',
      'u-1',
      expect.any(Function),
    );
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'ord-1',
        distributorId: 'dist-1',
        reportedBy: 'u-1',
        type: IncidentType.UNPAID_COLLECTION,
        description: 'no tenía plata',
        status: IncidentStatus.OPEN,
        moment: IncidentMoment.POST_DELIVERY,
      }),
    );
    expect(r.incident.incidentId).toBe('inc-1');
    expect(gateway.notifyAdmins).toHaveBeenCalledTimes(1);
    expect(gateway.notifyAdmins).toHaveBeenCalledWith(
      'incident:created',
      expect.objectContaining({ incidentId: 'inc-1' }),
      'dist-1',
    );
  });

  it('sin nota usa una descripción por defecto', async () => {
    await svc.report('ord-1', {}, 'u-1', null);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('no pagó') as string,
      }),
    );
  });

  it('repetido: devuelve la incidencia existente, no crea otra ni re-avisa', async () => {
    repo.findOne.mockResolvedValue({ incidentId: 'inc-0' });
    const r = await svc.report('ord-1', {}, 'u-1', null);
    expect(r.incident.incidentId).toBe('inc-0');
    expect(repo.save).not.toHaveBeenCalled();
    expect(gateway.notifyAdmins).not.toHaveBeenCalled();
  });

  it('si el pago no se puede marcar (otro chofer, estado, método) no crea incidencia', async () => {
    cash.markUnpaid.mockRejectedValue(new ForbiddenException('no tuyo'));
    await expect(svc.report('ord-1', {}, 'u-2', null)).rejects.toThrow(
      ForbiddenException,
    );
    expect(repo.save).not.toHaveBeenCalled();
    expect(gateway.notifyAdmins).not.toHaveBeenCalled();
  });

  it('si la transacción falla no se avisa a nadie', async () => {
    repo.save.mockRejectedValue(new Error('unique violation'));
    await expect(svc.report('ord-1', {}, 'u-1', null)).rejects.toThrow();
    expect(gateway.notifyAdmins).not.toHaveBeenCalled();
  });

  it('si falla el aviso en vivo, la incidencia igual queda', async () => {
    gateway.notifyAdmins.mockImplementation(() => {
      throw new Error('socket caído');
    });
    const r = await svc.report('ord-1', {}, 'u-1', null);
    expect(r.incident.incidentId).toBe('inc-1');
  });
});
