import { Logger } from '@nestjs/common';
import { UnpaidCashController } from './unpaid-cash.controller';
import {
  Incident,
  IncidentStatus,
  IncidentType,
} from './entities/incident.entity';
import { Order, PaymentStatus } from '../order/entities/order.entity';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

describe('UnpaidCashController', () => {
  const order = {
    orderId: 'o1',
    paymentStatus: PaymentStatus.UNPAID,
  } as unknown as Order;
  const incident = {
    incidentId: 'i1',
    orderId: 'o1',
    type: IncidentType.UNPAID_COLLECTION,
    status: IncidentStatus.OPEN,
    createdAt: new Date(),
  } as unknown as Incident;
  const usuario = (role: RoleType) =>
    ({ user_id: 'u1', role }) as unknown as AuthenticatedUser;

  let unpaidCash: { report: jest.Mock; reportByAdmin: jest.Mock };
  let photo: { firmar: jest.Mock };
  let controller: UnpaidCashController;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    unpaidCash = {
      report: jest.fn().mockResolvedValue({ order, incident }),
      reportByAdmin: jest.fn().mockResolvedValue({ order, incident }),
    };
    photo = { firmar: jest.fn().mockResolvedValue(undefined) };
    controller = new UnpaidCashController(unpaidCash as never, photo as never);
  });

  it('el chofer informa el impago con su distribuidora', async () => {
    const res = await controller.report(
      'o1',
      { note: 'no pagó' },
      usuario(RoleType.DELIVERY),
      'd1',
    );
    expect(unpaidCash.report).toHaveBeenCalledWith(
      'o1',
      { note: 'no pagó' },
      'u1',
      'd1',
    );
    expect(res).toMatchObject({
      orderId: 'o1',
      paymentStatus: PaymentStatus.UNPAID,
    });
    expect(res.incident.incident_id).toBe('i1');
    expect(photo.firmar).toHaveBeenCalledWith(incident);
  });

  it('el admin informa el impago con motivo y su distribuidora', async () => {
    const res = await controller.registerUnpaid(
      'o1',
      { reason: 'El chofer no informó que no cobró' },
      usuario(RoleType.ADMIN),
      'd1',
    );
    expect(unpaidCash.reportByAdmin).toHaveBeenCalledWith(
      'o1',
      'El chofer no informó que no cobró',
      'u1',
      'd1',
    );
    expect(res.incident.incident_id).toBe('i1');
    expect(res.paymentStatus).toBe(PaymentStatus.UNPAID);
  });
});
