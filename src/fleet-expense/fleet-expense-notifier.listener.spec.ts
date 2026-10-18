import { NotFoundException } from '@nestjs/common';
import { AdminService } from '../admin/admin.service';
import { CarService } from '../car/car.service';
import { EmailSenderPort } from '../email/ports/email-sender.port';
import { FleetExpenseNotifierListener } from './fleet-expense-notifier.listener';
import {
  CargaDeCombustibleAnomalaEvent,
  SiniestroConDerrameEvent,
} from './events/fleet-expense.events';

describe('FleetExpenseNotifierListener', () => {
  let listener: FleetExpenseNotifierListener;
  let cars: { findOne: jest.Mock };
  let admins: { findAll: jest.Mock };
  let email: { send: jest.Mock };

  beforeEach(() => {
    cars = { findOne: jest.fn().mockResolvedValue({ carPatent: 'AB123CD' }) };
    admins = {
      findAll: jest
        .fn()
        .mockResolvedValue([
          { user: { email: 'a@splg.app' } },
          { user: { email: 'b@splg.app' } },
          { user: null },
        ]),
    };
    email = { send: jest.fn().mockResolvedValue(undefined) };
    listener = new FleetExpenseNotifierListener(
      cars as unknown as CarService,
      admins as unknown as AdminService,
      email as unknown as EmailSenderPort,
    );
  });

  it('una carga anómala avisa a cada administrador con correo, con la patente', async () => {
    await listener.cargaAnomala(
      new CargaDeCombustibleAnomalaEvent('d1', 'f1', 'c1'),
    );
    expect(email.send).toHaveBeenCalledTimes(2);
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'a@splg.app',
        subject: expect.stringContaining('AB123CD') as string,
      }),
    );
  });

  it('un derrame de gas avisa como urgente', async () => {
    await listener.derrame(new SiniestroConDerrameEvent('d1', 's1', 'c1'));
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('URGENTE') as string,
      }),
    );
  });

  it('si el vehículo ya no está usa su id en el aviso', async () => {
    cars.findOne.mockRejectedValue(new NotFoundException());
    await listener.derrame(new SiniestroConDerrameEvent('d1', 's1', 'c9'));
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('c9') as string,
      }),
    );
  });

  it('si el envío falla no propaga el error: el aviso es best-effort', async () => {
    email.send.mockRejectedValue(new Error('smtp caído'));
    await expect(
      listener.cargaAnomala(
        new CargaDeCombustibleAnomalaEvent('d1', 'f1', 'c1'),
      ),
    ).resolves.toBeUndefined();
  });
});
