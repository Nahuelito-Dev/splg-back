import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { RoleType } from '../common/constants/role-type.enum';
import { FirebaseAuthPort } from '../firebase/ports/firebase-auth.port';
import { OrderLookupService } from '../order/lookup/order-lookup.service';
import { RedisService } from '../redis/redis.service';
import { EVENTO_CHOFER_DADO_DE_BAJA } from '../delivery/events/chofer-dado-de-baja.event';

describe('UsersService', () => {
  let service: UsersService;
  let users: {
    exists: jest.Mock;
    findOne: jest.Mock;
    delete: jest.Mock;
    softRemove: jest.Mock;
    preload: jest.Mock;
  };
  let firebase: { deleteUserSafe: jest.Mock; updateUser: jest.Mock };
  let eventos: { emitAsync: jest.Mock };
  let orderLookup: { countActiveByDelivery: jest.Mock };
  let redis: { removeDriver: jest.Mock };
  let manager: { softRemove: jest.Mock; query: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(() => {
    users = {
      exists: jest.fn().mockResolvedValue(false),
      findOne: jest.fn(),
      delete: jest.fn(),
      softRemove: jest.fn(),
      preload: jest.fn(),
    };
    firebase = { deleteUserSafe: jest.fn(), updateUser: jest.fn() };
    eventos = { emitAsync: jest.fn().mockResolvedValue([]) };
    redis = { removeDriver: jest.fn().mockResolvedValue(undefined) };
    orderLookup = { countActiveByDelivery: jest.fn().mockResolvedValue(0) };
    manager = { softRemove: jest.fn(), query: jest.fn().mockResolvedValue([]) };
    dataSource = {
      transaction: jest.fn((fn: (m: unknown) => Promise<unknown>) =>
        fn(manager),
      ),
    };
    service = new UsersService(
      users as unknown as Repository<User>,
      dataSource as unknown as DataSource,
      {} as ConfigService,
      firebase as unknown as FirebaseAuthPort,
      eventos as unknown as EventEmitter2,
      orderLookup as unknown as OrderLookupService,
      redis as unknown as RedisService,
    );
  });

  describe('checkUserExists', () => {
    it('informa el correo y el teléfono por separado', async () => {
      // El correo está libre; el teléfono lo usa otra persona.
      users.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      await expect(
        service.checkUserExists('libre@splg.com', '+5493764000000'),
      ).resolves.toEqual({ exists: true, email: false, phoneNumber: true });
    });

    it('cuenta también a los dados de baja, igual que el alta (assertDisponible)', async () => {
      await service.checkUserExists('baja@splg.com', '+5493764000001');
      for (const [consulta] of users.exists.mock.calls as [
        { withDeleted?: boolean },
      ][]) {
        expect(consulta.withDeleted).toBe(true);
      }
      expect(users.exists).toHaveBeenCalledTimes(2);
    });

    it('sin datos no consulta la base', async () => {
      await expect(service.checkUserExists()).resolves.toEqual({
        exists: false,
        email: false,
        phoneNumber: false,
      });
      expect(users.exists).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('da de baja lógica al usuario y a sus perfiles, sin borrar', async () => {
      const user = { userId: 'u1', firebaseUid: 'fb' };
      users.findOne.mockResolvedValue(user);
      await service.remove('u1');
      expect(users.findOne).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        relations: ['customer', 'delivery', 'addresses'],
      });
      expect(manager.softRemove).toHaveBeenCalledWith(user);
      expect(users.delete).not.toHaveBeenCalled();
    });

    it('un chofer dado de baja sale del radar de Redis, por user_id y después del commit', async () => {
      const user = {
        userId: 'u1',
        firebaseUid: 'fb',
        delivery: { deliveryId: 'dl1' },
      };
      users.findOne.mockResolvedValue(user);
      let radarAntesDelCommit = false;
      dataSource.transaction.mockImplementation(
        async (fn: (m: unknown) => Promise<unknown>) => {
          await fn(manager);
          radarAntesDelCommit = redis.removeDriver.mock.calls.length > 0;
        },
      );
      await service.remove('u1');
      expect(radarAntesDelCommit).toBe(false);
      expect(redis.removeDriver).toHaveBeenCalledWith('u1');
    });

    it('si la baja falla (409) el chofer NO sale del radar', async () => {
      users.findOne.mockResolvedValue({
        userId: 'u1',
        delivery: { deliveryId: 'dl1' },
      });
      orderLookup.countActiveByDelivery.mockResolvedValue(1);
      await expect(service.remove('u1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(redis.removeDriver).not.toHaveBeenCalled();
    });

    it('si Redis falla la baja igual queda hecha', async () => {
      users.findOne.mockResolvedValue({
        userId: 'u1',
        delivery: { deliveryId: 'dl1' },
      });
      redis.removeDriver.mockRejectedValue(new Error('redis caído'));
      await expect(service.remove('u1')).resolves.toBeDefined();
    });

    it('un usuario que no es chofer no toca Redis', async () => {
      users.findOne.mockResolvedValue({ userId: 'u1' });
      await service.remove('u1');
      expect(redis.removeDriver).not.toHaveBeenCalled();
    });

    it('no carga `cars` para la baja: la flota es de la distribuidora, no se le lleva puesta al usuario', async () => {
      const user = { userId: 'u1', firebaseUid: 'fb' };
      users.findOne.mockResolvedValue(user);
      await service.remove('u1');
      const [{ relations }] = users.findOne.mock.calls[0] as [
        { relations: string[] },
      ];
      expect(relations).not.toContain('cars');
    });

    it('si tenía perfil de chofer, libera su vehículo en uso con el mismo evento que `DeliveryService.remove`', async () => {
      const user = {
        userId: 'u1',
        firebaseUid: 'fb',
        delivery: { deliveryId: 'dl1' },
      };
      users.findOne.mockResolvedValue(user);
      await service.remove('u1');
      // Con la transacción de la baja, para que liberar el vehículo vaya en ella.
      expect(eventos.emitAsync).toHaveBeenCalledWith(
        EVENTO_CHOFER_DADO_DE_BAJA,
        expect.objectContaining({ deliveryId: 'dl1', manager }),
      );
    });

    it('409 si el chofer tiene pedidos aceptados o en camino: no se da de baja nada', async () => {
      users.findOne.mockResolvedValue({
        userId: 'u1',
        firebaseUid: 'fb',
        delivery: { deliveryId: 'dl1' },
      });
      orderLookup.countActiveByDelivery.mockResolvedValue(2);
      await expect(service.remove('u1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(orderLookup.countActiveByDelivery).toHaveBeenCalledWith(
        'dl1',
        manager,
      );
      expect(manager.softRemove).not.toHaveBeenCalled();
      expect(eventos.emitAsync).not.toHaveBeenCalled();
      expect(firebase.updateUser).not.toHaveBeenCalled();
    });

    it('bloquea la fila del chofer ANTES de contar sus pedidos en curso', async () => {
      users.findOne.mockResolvedValue({
        userId: 'u1',
        delivery: { deliveryId: 'dl1' },
      });
      await service.remove('u1');
      const [consulta, parametros] = manager.query.mock.calls[0] as [
        string,
        string[][],
      ];
      expect(consulta).toContain('FOR NO KEY UPDATE');
      expect(parametros).toEqual([['dl1']]);
      expect(manager.query.mock.invocationCallOrder[0]).toBeLessThan(
        orderLookup.countActiveByDelivery.mock.invocationCallOrder[0],
      );
    });

    it('si liberar el vehículo falla, la baja se revierte y no se toca Firebase', async () => {
      users.findOne.mockResolvedValue({
        userId: 'u1',
        firebaseUid: 'fb',
        delivery: { deliveryId: 'dl1' },
      });
      eventos.emitAsync.mockRejectedValue(new Error('no se pudo liberar'));
      await expect(service.remove('u1')).rejects.toThrow('no se pudo liberar');
      expect(firebase.updateUser).not.toHaveBeenCalled();
    });

    it('sin perfil de chofer, no emite el evento de baja de chofer', async () => {
      const user = { userId: 'u1', firebaseUid: 'fb', delivery: null };
      users.findOne.mockResolvedValue(user);
      await service.remove('u1');
      expect(eventos.emitAsync).not.toHaveBeenCalled();
      expect(orderLookup.countActiveByDelivery).not.toHaveBeenCalled();
    });

    it('deshabilita la cuenta de Firebase en vez de borrarla', async () => {
      users.findOne.mockResolvedValue({ userId: 'u1', firebaseUid: 'fb' });
      await service.remove('u1');
      expect(firebase.updateUser).toHaveBeenCalledWith('fb', {
        disabled: true,
      });
      expect(firebase.deleteUserSafe).not.toHaveBeenCalled();
    });

    it('si Firebase falla, la baja igual queda hecha y se reintenta 3 veces', async () => {
      users.findOne.mockResolvedValue({ userId: 'u1', firebaseUid: 'fb' });
      firebase.updateUser.mockRejectedValue(new Error('caído'));
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      await expect(service.remove('u1')).resolves.toEqual({
        message: 'Usuario dado de baja',
      });
      expect(firebase.updateUser).toHaveBeenCalledTimes(3);
      // Queda registrado qué cuenta sigue habilitada.
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('sigue HABILITADA'),
      );
      error.mockRestore();
    });

    it('si Firebase falla una vez y después responde, la cuenta queda deshabilitada sin error', async () => {
      users.findOne.mockResolvedValue({ userId: 'u1', firebaseUid: 'fb' });
      firebase.updateUser
        .mockRejectedValueOnce(new Error('transitorio'))
        .mockResolvedValue(undefined);
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      await service.remove('u1');
      expect(firebase.updateUser).toHaveBeenCalledTimes(2);
      expect(error).not.toHaveBeenCalled();
      error.mockRestore();
    });

    it('un usuario inexistente es 404', async () => {
      users.findOne.mockResolvedValue(null);
      await expect(service.remove('u9')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  it('no cambia la contraseña de quien no tiene cuenta de acceso', async () => {
    users.preload.mockResolvedValue({ userId: 'u1', firebaseUid: null });
    await expect(
      service.update('u1', { password: 'Nueva1234' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(firebase.updateUser).not.toHaveBeenCalled();
  });

  describe('findAll', () => {
    const armarQb = () => {
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      (
        users as unknown as { createQueryBuilder: jest.Mock }
      ).createQueryBuilder = jest.fn().mockReturnValue(qb);
      return qb;
    };

    it('sin role no filtra por rol', async () => {
      const qb = armarQb();
      await service.findAll({});
      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('filtra por el tipo de rol y acota por distribuidora', async () => {
      const qb = armarQb();
      await service.findAll({ role: RoleType.DELIVERY }, 'd1');
      expect(qb.andWhere).toHaveBeenCalledWith('role.type = :role', {
        role: 'delivery',
      });
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('pert_d.distributor_id = :distributorId'),
        { distributorId: 'd1' },
      );
    });
  });
});
