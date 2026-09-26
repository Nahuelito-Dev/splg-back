import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { TimeSlotService } from './time-slot.service';
import { TimeSlot } from './entities/time-slot.entity';
import { Order } from '../order/entities/order.entity';
import { DistributorService } from '../distributor/distributor.service';

/**
 * El cupo de una franja: no se agenda en una franja inactiva, en el pasado ni
 * cuando ya está llena, y la disponibilidad nunca informa cupos negativos.
 */
describe('TimeSlotService', () => {
  let service: TimeSlotService;
  let slots: { findOne: jest.Mock; find: jest.Mock };
  let orders: { count: jest.Mock };

  const manana = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const franja = { time_slot_id: 't1', name: 'Mañana', capacity: 2 };

  beforeEach(() => {
    slots = { findOne: jest.fn(), find: jest.fn() };
    orders = { count: jest.fn() };
    service = new TimeSlotService(
      slots as unknown as Repository<TimeSlot>,
      orders as unknown as Repository<Order>,
      {} as DistributorService,
    );
  });

  it('una franja inactiva o inexistente no admite pedidos', async () => {
    slots.findOne.mockResolvedValue(null);
    await expect(
      service.assertSlotAvailable('t1', manana),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('no se agenda en una fecha pasada', async () => {
    slots.findOne.mockResolvedValue(franja);
    await expect(
      service.assertSlotAvailable('t1', '2020-01-01'),
    ).rejects.toThrow('fecha pasada');
  });

  it('una franja llena rechaza el pedido', async () => {
    slots.findOne.mockResolvedValue(franja);
    orders.count.mockResolvedValue(2);
    await expect(service.assertSlotAvailable('t1', manana)).rejects.toThrow(
      'completa',
    );
  });

  it('con cupo, deja pasar', async () => {
    slots.findOne.mockResolvedValue(franja);
    orders.count.mockResolvedValue(1);
    await expect(
      service.assertSlotAvailable('t1', manana),
    ).resolves.toBeUndefined();
  });

  it('la disponibilidad no baja de cero aunque haya sobreventa', async () => {
    slots.find.mockResolvedValue([
      { ...franja, startTime: '09:00', endTime: '13:00' },
    ]);
    orders.count.mockResolvedValue(5);
    const [d] = await service.getAvailability(manana);
    expect(d).toMatchObject({ capacity: 2, booked: 5, remaining: 0 });
  });
});
