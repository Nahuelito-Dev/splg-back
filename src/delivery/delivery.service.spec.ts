// El constructor de DeliveryService hace firebase.initializeApp('delivery-service').
// Lo mockeamos para poder instanciar el servicio en los tests sin credenciales
// reales y sin el error "app already exists" al crear más de una instancia.
jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
}));

import { ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { DeliveryService } from './delivery.service';
import { Delivery } from './entities/delivery.entity';
import { RedisService } from '../redis/redis.service';
import { UsersService } from '../users/users.service';

/**
 * Cubre el fix de CU-022: al ponerse OFFLINE, el chofer debe salir del radar
 * Redis. El radar (`drivers:locations`) se llena por `user_id` (lo setea
 * `driver:update-location` vía `updateDriverLocation(userId,...)`), así que el
 * `removeDriver` tiene que usar `user_id`. Antes usaba `delivery_id` → ZREM
 * no-op → el chofer offline seguía recibiendo ofertas.
 */
describe('DeliveryService.toggleAvailability (CU-022)', () => {
  let service: DeliveryService;
  let deliveryRepo: { findOne: jest.Mock; save: jest.Mock };
  let redis: { removeDriver: jest.Mock };

  beforeEach(() => {
    deliveryRepo = {
      findOne: jest.fn().mockResolvedValue({
        user_id: 'user-123',
        delivery_id: 'delivery-999',
        isEnabled: true,
        validated: true,
        isAvailable: false,
      }),
      save: jest.fn().mockImplementation((d) => Promise.resolve(d)),
    };
    redis = { removeDriver: jest.fn().mockResolvedValue(undefined) };
    service = new DeliveryService(
      deliveryRepo as unknown as Repository<Delivery>,
      redis as unknown as RedisService,
      {} as unknown as UsersService,
    );
  });

  it('al ponerse OFFLINE saca al chofer del radar por user_id (NO delivery_id)', async () => {
    await service.toggleAvailability('user-123', false);
    expect(redis.removeDriver).toHaveBeenCalledWith('user-123');
    expect(redis.removeDriver).not.toHaveBeenCalledWith('delivery-999');
  });

  it('al ponerse ONLINE no toca el radar', async () => {
    await service.toggleAvailability('user-123', true);
    expect(redis.removeDriver).not.toHaveBeenCalled();
  });
});

/**
 * El bug de fondo: `isActive` mezclaba la habilitación administrativa con la
 * presencia del chofer, así que un chofer deshabilitado por el admin podía
 * igual "conectarse" desde su app y volver a recibir pedidos. Ahora
 * `toggleAvailability` exige habilitado + validado para ponerse en línea, y
 * `toggleActiveStatus` saca del radar al deshabilitar.
 */
describe('DeliveryService · habilitación vs. presencia', () => {
  let service: DeliveryService;
  let deliveryRepo: { findOne: jest.Mock; save: jest.Mock };
  let redis: { removeDriver: jest.Mock };

  const delivery = (over: Record<string, unknown> = {}) => ({
    deliveryId: 'delivery-999',
    userId: 'user-123',
    isEnabled: true,
    validated: true,
    isAvailable: false,
    ...over,
  });

  beforeEach(() => {
    deliveryRepo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((d) => Promise.resolve(d)),
    };
    redis = { removeDriver: jest.fn().mockResolvedValue(undefined) };
    service = new DeliveryService(
      deliveryRepo as unknown as Repository<Delivery>,
      redis as unknown as RedisService,
      {} as unknown as UsersService,
    );
  });

  it('un chofer deshabilitado no puede ponerse en línea', async () => {
    deliveryRepo.findOne.mockResolvedValue(delivery({ isEnabled: false }));
    await expect(
      service.toggleAvailability('user-123', true),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(deliveryRepo.save).not.toHaveBeenCalled();
  });

  it('un chofer sin validar no puede ponerse en línea', async () => {
    deliveryRepo.findOne.mockResolvedValue(delivery({ validated: false }));
    await expect(
      service.toggleAvailability('user-123', true),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(deliveryRepo.save).not.toHaveBeenCalled();
  });

  it('habilitado y validado sí puede ponerse en línea', async () => {
    deliveryRepo.findOne.mockResolvedValue(delivery());
    const res = await service.toggleAvailability('user-123', true);
    expect(res.isAvailable).toBe(true);
  });

  it('deshabilitar a un chofer EN LÍNEA lo desconecta y lo saca del radar', async () => {
    const d = delivery({ isAvailable: true });
    const findOne = jest
      .fn()
      .mockResolvedValue(d) as unknown as Repository<Delivery>['findOne'];
    service = new DeliveryService(
      { findOne, save: deliveryRepo.save } as unknown as Repository<Delivery>,
      redis as unknown as RedisService,
      {} as unknown as UsersService,
    );

    const resultado = await service.toggleActiveStatus('delivery-999', false);

    expect(resultado.isEnabled).toBe(false);
    expect(resultado.isAvailable).toBe(false);
    expect(redis.removeDriver).toHaveBeenCalledWith('user-123');
  });

  it('habilitar de nuevo NO toca el radar', async () => {
    const findOne = jest
      .fn()
      .mockResolvedValue(
        delivery({ isEnabled: false, isAvailable: false }),
      ) as unknown as Repository<Delivery>['findOne'];
    service = new DeliveryService(
      { findOne, save: deliveryRepo.save } as unknown as Repository<Delivery>,
      redis as unknown as RedisService,
      {} as unknown as UsersService,
    );

    await service.toggleActiveStatus('delivery-999', true);

    expect(redis.removeDriver).not.toHaveBeenCalled();
  });
});

/**
 * Un chofer es de una sola distribuidora: borrarlo desde el panel da de baja su
 * cuenta entera, no sólo el perfil. Si tiene pedidos en curso, la baja se
 * rechaza: quedarían sin nadie que los entregue. Ya no se rechaza por tener
 * vehículos asignados (son de la flota, no del usuario); si tenía uno en uso,
 * lo libera `UsersService.remove` por el evento `chofer.dado-de-baja` (eso ya
 * lo cubre `users.service.spec.ts`).
 */
describe('DeliveryService.remove', () => {
  let redis: { removeDriver: jest.Mock };
  let users: { remove: jest.Mock };
  let service: DeliveryService;

  beforeEach(() => {
    const findOne = jest.fn().mockResolvedValue({
      deliveryId: 'delivery-999',
      userId: 'user-123',
    });
    redis = { removeDriver: jest.fn().mockResolvedValue(undefined) };
    users = { remove: jest.fn().mockResolvedValue(undefined) };
    service = new DeliveryService(
      { findOne } as unknown as Repository<Delivery>,
      redis as unknown as RedisService,
      users as unknown as UsersService,
    );
  });

  it('da de baja la cuenta del chofer y lo saca del radar', async () => {
    await service.remove('delivery-999');

    expect(users.remove).toHaveBeenCalledWith('user-123');
    expect(redis.removeDriver).toHaveBeenCalledWith('user-123');
  });

  it('el radar se limpia DESPUÉS de la baja: si la baja falla, el chofer sigue en el radar', async () => {
    users.remove.mockRejectedValue(new Error('la baja falló'));

    await expect(service.remove('delivery-999')).rejects.toThrow(
      'la baja falló',
    );
    expect(redis.removeDriver).not.toHaveBeenCalled();
  });

  it('si Redis falla después de la baja, la baja queda hecha y no se propaga', async () => {
    redis.removeDriver.mockRejectedValue(new Error('redis caído'));
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    await expect(service.remove('delivery-999')).resolves.toBeDefined();
    expect(users.remove).toHaveBeenCalledWith('user-123');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('no se pudo sacar del radar'),
    );
    error.mockRestore();
  });

  it('el 409 por pedidos en curso lo da UsersService.remove (con el chofer bloqueado): no se toca el radar', async () => {
    users.remove.mockRejectedValue(new ConflictException('pedidos en curso'));

    await expect(service.remove('delivery-999')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(redis.removeDriver).not.toHaveBeenCalled();
  });
});
