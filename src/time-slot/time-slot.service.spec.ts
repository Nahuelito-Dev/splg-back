import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { TimeSlotService } from './time-slot.service';
import { TimeSlot } from './entities/time-slot.entity';
import { OrderLookupService } from '../order/lookup/order-lookup.service';
import { DistributorService } from '../distributor/distributor.service';

/**
 * El cupo de una franja: no se agenda en una franja inactiva, en el pasado ni
 * cuando ya está llena, y la disponibilidad nunca informa cupos negativos.
 */
describe('TimeSlotService', () => {
  let service: TimeSlotService;
  let slots: { findOne: jest.Mock; find: jest.Mock };
  let orders: { countBooked: jest.Mock; maxBookedFrom: jest.Mock };

  const manana = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const franja = { time_slot_id: 't1', name: 'Mañana', capacity: 2 };

  beforeEach(() => {
    slots = { findOne: jest.fn(), find: jest.fn() };
    orders = { countBooked: jest.fn(), maxBookedFrom: jest.fn() };
    service = new TimeSlotService(
      slots as unknown as Repository<TimeSlot>,
      orders as unknown as OrderLookupService,
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
    orders.countBooked.mockResolvedValue(2);
    await expect(service.assertSlotAvailable('t1', manana)).rejects.toThrow(
      'completa',
    );
  });

  it('con cupo, deja pasar', async () => {
    slots.findOne.mockResolvedValue(franja);
    orders.countBooked.mockResolvedValue(1);
    await expect(
      service.assertSlotAvailable('t1', manana),
    ).resolves.toBeUndefined();
  });

  it('la disponibilidad no baja de cero aunque haya sobreventa', async () => {
    slots.find.mockResolvedValue([
      { ...franja, startTime: '09:00', endTime: '13:00' },
    ]);
    orders.countBooked.mockResolvedValue(5);
    const [d] = await service.getAvailability(manana);
    expect(d).toMatchObject({ capacity: 2, booked: 5, remaining: 0 });
  });

  describe('update', () => {
    const existente = () => ({
      timeSlotId: 't1',
      distributorId: 'd1',
      name: 'Mañana',
      startTime: '09:00:00',
      endTime: '13:00:00',
      capacity: 50,
      isActive: false,
    });
    let manager: { findOne: jest.Mock; save: jest.Mock };
    beforeEach(() => {
      manager = {
        findOne: jest.fn(),
        save: jest.fn((x: unknown) => Promise.resolve(x)),
      };
      (slots as unknown as { manager: unknown }).manager = {
        transaction: (fn: (m: unknown) => unknown) => fn(manager),
      };
      orders.maxBookedFrom = jest.fn().mockResolvedValue(0);
    });

    it('edita sólo lo que viene y reactiva con isActive', async () => {
      manager.findOne.mockResolvedValue(existente());
      const r = await service.update(
        't1',
        { capacity: 10, isActive: true },
        'd1',
      );
      expect(r).toMatchObject({
        name: 'Mañana',
        capacity: 10,
        isActive: true,
        startTime: '09:00:00',
      });
      expect(manager.save).toHaveBeenCalledTimes(1);
    });

    it('toma el lock pesimista de la franja (el mismo que el alta de pedidos)', async () => {
      manager.findOne.mockResolvedValue(existente());
      await service.update('t1', { name: 'x' }, 'd1');
      expect(manager.findOne).toHaveBeenCalledWith(
        TimeSlot,
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
    });

    it('rechaza un rango con inicio >= fin (contando lo que ya tenía)', async () => {
      manager.findOne.mockResolvedValue(existente());
      await expect(
        service.update('t1', { startTime: '14:00' }, 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('no baja la capacidad por debajo de lo ya agendado: 409', async () => {
      manager.findOne.mockResolvedValue(existente());
      orders.maxBookedFrom.mockResolvedValue(7);
      await expect(
        service.update('t1', { capacity: 5 }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('baja la capacidad hasta justo lo agendado', async () => {
      manager.findOne.mockResolvedValue(existente());
      orders.maxBookedFrom.mockResolvedValue(7);
      await expect(
        service.update('t1', { capacity: 7 }, 'd1'),
      ).resolves.toMatchObject({ capacity: 7 });
    });

    it('una franja de otro tenant es 404', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(
        service.update('t1', { name: 'x' }, 'otra'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
