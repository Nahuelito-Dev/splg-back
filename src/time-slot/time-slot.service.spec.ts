import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
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
  const franja = {
    time_slot_id: 't1',
    name: 'Mañana',
    capacity: 2,
    startTime: '09:00',
    endTime: '13:00',
  };
  const franjaNoche = {
    ...franja,
    name: 'Noche',
    startTime: '20:00',
    endTime: '23:30',
  };

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

  describe('el "hoy" es el día argentino, no el UTC', () => {
    // 22:30 del 10/10 en Argentina = 01:30 UTC del 11/10.
    beforeEach(() => {
      jest.useFakeTimers({ now: new Date('2026-10-11T01:30:00Z') });
      slots.findOne.mockResolvedValue(franjaNoche);
      orders.countBooked.mockResolvedValue(0);
    });
    afterEach(() => jest.useRealTimers());

    it('a las 22:30 ART se puede agendar para hoy', async () => {
      await expect(
        service.assertSlotAvailable('t1', '2026-10-10'),
      ).resolves.toBeUndefined();
    });

    it('a las 22:30 ART se puede agendar para hoy (dentro de la transacción)', async () => {
      const manager = { findOne: jest.fn().mockResolvedValue(franjaNoche) };
      await expect(
        service.assertSlotAvailableTx(
          manager as unknown as EntityManager,
          't1',
          '2026-10-10',
        ),
      ).resolves.toBeUndefined();
    });

    it('ayer argentino sigue siendo pasado', async () => {
      await expect(
        service.assertSlotAvailable('t1', '2026-10-09'),
      ).rejects.toThrow('fecha pasada');
    });

    it('una franja de hoy que ya terminó (fin 13:00) se rechaza', async () => {
      slots.findOne.mockResolvedValue(franja);
      await expect(
        service.assertSlotAvailable('t1', '2026-10-10'),
      ).rejects.toThrow('La franja ya terminó, elegí otra');
    });

    it('lo mismo dentro de la transacción', async () => {
      const manager = { findOne: jest.fn().mockResolvedValue(franja) };
      await expect(
        service.assertSlotAvailableTx(
          manager as unknown as EntityManager,
          't1',
          '2026-10-10',
        ),
      ).rejects.toThrow('La franja ya terminó, elegí otra');
    });

    it('la misma franja mañana sigue disponible', async () => {
      slots.findOne.mockResolvedValue(franja);
      await expect(
        service.assertSlotAvailable('t1', '2026-10-11'),
      ).resolves.toBeUndefined();
    });

    it('la disponibilidad de hoy muestra sin cupos las franjas terminadas', async () => {
      slots.find.mockResolvedValue([
        { ...franja, timeSlotId: 'a' },
        { ...franjaNoche, timeSlotId: 'b' },
      ]);
      const r = await service.getAvailability('2026-10-10');
      expect(r.map((x) => [x.timeSlotId, x.remaining])).toEqual([
        ['a', 0],
        ['b', 2],
      ]);
    });
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

  describe('findAll', () => {
    it('por defecto lista sólo las activas', async () => {
      slots.find.mockResolvedValue([]);
      await service.findAll(undefined, 'd1');
      expect(
        (slots.find.mock.calls[0] as [{ where: object }])[0].where,
      ).toEqual({
        isActive: true,
        distributorId: 'd1',
      });
    });

    it('con includeInactive no filtra por isActive pero sigue acotando al tenant', async () => {
      slots.find.mockResolvedValue([]);
      await service.findAll(undefined, 'd1', true);
      expect(
        (slots.find.mock.calls[0] as [{ where: object }])[0].where,
      ).toEqual({
        distributorId: 'd1',
      });
    });
  });

  describe('create', () => {
    let manager: {
      query: jest.Mock;
      find: jest.Mock;
      create: jest.Mock;
      save: jest.Mock;
    };
    const dto = {
      name: 'Tarde',
      startTime: '14:00',
      endTime: '18:00',
      capacity: 30,
    };
    const otra = (nombre: string, desde: string, hasta: string) => ({
      timeSlotId: 'x',
      name: nombre,
      startTime: desde,
      endTime: hasta,
    });

    beforeEach(() => {
      manager = {
        query: jest.fn().mockResolvedValue(undefined),
        find: jest.fn().mockResolvedValue([]),
        create: jest.fn((_e: unknown, d: object) => d),
        save: jest.fn((x: unknown) => Promise.resolve(x)),
      };
      (slots as unknown as { manager: unknown }).manager = {
        transaction: (fn: (m: unknown) => unknown) => fn(manager),
      };
    });

    it.each([
      ['inicio = fin', '14:00', '14:00'],
      ['inicio > fin', '18:00', '09:00'],
    ])('%s es 400 y no toca la base', async (_c, startTime, endTime) => {
      await expect(
        service.create({ ...dto, startTime, endTime }, 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('guarda la franja de la distribuidora, tras tomar el lock de sus franjas', async () => {
      await service.create(dto, 'd1');
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('pg_advisory_xact_lock'),
        ['time_slot:d1'],
      );
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Tarde', distributorId: 'd1' }),
      );
    });

    it('el nombre de otra franja activa, sin distinguir mayúsculas, es 409', async () => {
      manager.find.mockResolvedValue([otra(' TARDE', '07:00:00', '08:00:00')]);
      await expect(service.create(dto, 'd1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('un horario que pisa a otra franja activa es 409 y dice con cuál', async () => {
      manager.find.mockResolvedValue([otra('Mañana', '09:00:00', '15:00:00')]);
      const error = await service.create(dto, 'd1').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toContain('«Mañana» (09:00 a 15:00)');
    });

    it('el borde compartido no es un choque (9–14 y 14–18 conviven)', async () => {
      manager.find.mockResolvedValue([otra('Mañana', '09:00:00', '14:00:00')]);
      await expect(service.create(dto, 'd1')).resolves.toBeDefined();
    });

    it('sólo compara con las franjas activas de la distribuidora', async () => {
      await service.create(dto, 'd1');
      expect(manager.find).toHaveBeenCalledWith(TimeSlot, {
        where: { distributorId: 'd1', isActive: true },
      });
    });
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
    let manager: {
      findOne: jest.Mock;
      save: jest.Mock;
      query: jest.Mock;
      find: jest.Mock;
    };
    beforeEach(() => {
      manager = {
        findOne: jest.fn(),
        save: jest.fn((x: unknown) => Promise.resolve(x)),
        query: jest.fn().mockResolvedValue(undefined),
        // Las otras franjas activas de la distribuidora.
        find: jest.fn().mockResolvedValue([]),
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

    it('a las 22:30 ART la baja de capacidad cuenta lo agendado desde HOY argentino (no el día UTC)', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-11T01:30:00Z') });
      try {
        manager.findOne.mockResolvedValue(existente());
        await service.update('t1', { capacity: 5 }, 'd1');
        expect(orders.maxBookedFrom).toHaveBeenCalledWith(
          't1',
          '2026-10-10',
          manager,
        );
      } finally {
        jest.useRealTimers();
      }
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

    it('mover el horario encima de otra franja activa es 409 con cuál es', async () => {
      manager.findOne.mockResolvedValue({ ...existente(), isActive: true });
      manager.find.mockResolvedValue([
        {
          timeSlotId: 't2',
          name: 'Tarde',
          startTime: '13:00:00',
          endTime: '18:00:00',
        },
      ]);
      const error = await service
        .update('t1', { endTime: '14:00' }, 'd1')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toContain('«Tarde» (13:00 a 18:00)');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('reactivar una franja que hoy pisa a otra activa es 409', async () => {
      manager.findOne.mockResolvedValue(existente());
      manager.find.mockResolvedValue([
        {
          timeSlotId: 't2',
          name: 'Media mañana',
          startTime: '10:00:00',
          endTime: '12:00:00',
        },
      ]);
      await expect(
        service.update('t1', { isActive: true }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('renombrar con el nombre de otra franja activa es 409', async () => {
      manager.findOne.mockResolvedValue({ ...existente(), isActive: true });
      manager.find.mockResolvedValue([
        {
          timeSlotId: 't2',
          name: 'tarde',
          startTime: '14:00:00',
          endTime: '18:00:00',
        },
      ]);
      await expect(
        service.update('t1', { name: 'Tarde' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('desactivar una franja no controla choques', async () => {
      manager.findOne.mockResolvedValue({ ...existente(), isActive: true });
      manager.find.mockResolvedValue([
        {
          timeSlotId: 't2',
          name: 'Mañana',
          startTime: '09:00:00',
          endTime: '13:00:00',
        },
      ]);
      await expect(
        service.update('t1', { isActive: false }, 'd1'),
      ).resolves.toMatchObject({ isActive: false });
      expect(manager.find).not.toHaveBeenCalled();
    });

    it('una franja de otro tenant es 404', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(
        service.update('t1', { name: 'x' }, 'otra'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
