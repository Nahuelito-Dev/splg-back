import {
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, Repository } from 'typeorm';
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
  let firebase: {
    deleteUserSafe: jest.Mock;
    updateUser: jest.Mock;
    revokeRefreshTokensSafe: jest.Mock;
  };
  let eventos: { emitAsync: jest.Mock; emit: jest.Mock };
  let orderLookup: {
    countActiveByDelivery: jest.Mock;
    countActiveByCustomer: jest.Mock;
  };
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
    firebase = {
      deleteUserSafe: jest.fn(),
      updateUser: jest.fn(),
      revokeRefreshTokensSafe: jest.fn().mockResolvedValue(undefined),
    };
    eventos = { emitAsync: jest.fn().mockResolvedValue([]), emit: jest.fn() };
    redis = { removeDriver: jest.fn().mockResolvedValue(undefined) };
    orderLookup = {
      countActiveByDelivery: jest.fn().mockResolvedValue(0),
      countActiveByCustomer: jest.fn().mockResolvedValue(0),
    };
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
        relations: ['customer', 'delivery', 'addresses', 'role', 'admins'],
      });
      expect(manager.softRemove).toHaveBeenCalledWith(user);
      expect(users.delete).not.toHaveBeenCalled();
    });

    it('con la baja hecha revoca las sesiones de Firebase', async () => {
      users.findOne.mockResolvedValue({ userId: 'u1', firebaseUid: 'fb' });
      await service.remove('u1');
      expect(firebase.revokeRefreshTokensSafe).toHaveBeenCalledWith(
        'fb',
        expect.anything(),
      );
    });

    it('sin cuenta de acceso no hay nada que revocar', async () => {
      users.findOne.mockResolvedValue({ userId: 'u1', firebaseUid: null });
      await service.remove('u1');
      expect(firebase.revokeRefreshTokensSafe).not.toHaveBeenCalled();
    });

    it('con la baja hecha corta sus conexiones de tiempo real', async () => {
      users.findOne.mockResolvedValue({ userId: 'u1', firebaseUid: 'fb' });
      await service.remove('u1');
      expect(eventos.emit).toHaveBeenCalledWith(
        'usuario.acceso-revocado',
        expect.objectContaining({ userId: 'u1', motivo: 'baja' }),
      );
    });

    describe('no dejar sin administrador', () => {
      const admin = (over: object = {}) => ({
        userId: 'u1',
        blocked: false,
        role: { type: RoleType.ADMIN },
        admins: [{ distributorId: 'd1' }],
        ...over,
      });
      /** `bloqueado`: lo que dice la base del destino, leído dentro del lock. */
      const base = (otros: number, bloqueado = false) =>
        manager.query.mockImplementation((sql: string) => {
          if (sql.includes('count(*)'))
            return Promise.resolve([{ n: String(otros) }]);
          if (sql.includes('SELECT blocked')) {
            return Promise.resolve([{ blocked: bloqueado }]);
          }
          return Promise.resolve([]);
        });

      it('el último admin activo de la distribuidora es 409, con lock por distribuidora', async () => {
        users.findOne.mockResolvedValue(admin());
        base(0);
        await expect(service.remove('u1')).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(manager.query).toHaveBeenCalledWith(
          expect.stringContaining('pg_advisory_xact_lock'),
          ['admin-baja:d1'],
        );
        expect(manager.softRemove).not.toHaveBeenCalled();
      });

      it('el último super admin activo es 409, con su propio lock', async () => {
        users.findOne.mockResolvedValue(
          admin({
            role: { type: RoleType.SUPER_ADMIN },
            admins: [{ distributorId: null }],
          }),
        );
        base(0);
        await expect(service.remove('u1')).rejects.toThrow(/super/);
        expect(manager.query).toHaveBeenCalledWith(
          expect.stringContaining('pg_advisory_xact_lock'),
          ['admin-baja:super'],
        );
      });

      it('con otro activo se da de baja', async () => {
        users.findOne.mockResolvedValue(admin());
        base(1);
        await service.remove('u1');
        expect(manager.softRemove).toHaveBeenCalled();
      });

      /** Hay otro admin activo, pero el destino es el único que gestiona roles. */
      const unicoGestor = () =>
        manager.query.mockImplementation((sql: string, params?: unknown[]) => {
          if (sql.includes('"is_system" OR')) {
            // Sin excluir a nadie: 1 (el destino). Excluyéndolo: 0.
            return Promise.resolve([{ n: params?.[3] ? 0 : 1 }]);
          }
          if (sql.includes('count(*)')) return Promise.resolve([{ n: '1' }]);
          if (sql.includes('SELECT blocked')) {
            return Promise.resolve([{ blocked: false }]);
          }
          return Promise.resolve([]);
        });

      it('el último que gestiona los roles (F37) es 409 LAST_ROLES_MANAGER, con el lock de roles después del de bajas', async () => {
        users.findOne.mockResolvedValue(admin());
        unicoGestor();
        const error = await service.remove('u1').catch((e: unknown) => e);
        expect(
          (error as ConflictException).getResponse() as Record<string, unknown>,
        ).toMatchObject({ statusCode: 409, code: 'LAST_ROLES_MANAGER' });
        expect(manager.softRemove).not.toHaveBeenCalled();
        const locks = (manager.query.mock.calls as [string, unknown[]][])
          .filter(([q]) => q.includes('pg_advisory_xact_lock'))
          .map(([, p]) => p[0]);
        expect(locks).toEqual(['admin-baja:d1', 'staff-role:d1']);
      });

      it('bloquear al último que gestiona los roles también es 409', async () => {
        users.findOne.mockResolvedValue(admin());
        unicoGestor();
        await expect(service.toggleBlockUser('u1', true)).rejects.toThrow(
          'gestionar los roles y permisos',
        );
      });

      it('si el destino ya está bloqueado en la base (leído tras el lock), no hay que contar a nadie', async () => {
        // la copia cargada antes de la transacción dice que no está bloqueado
        users.findOne.mockResolvedValue(admin({ blocked: false }));
        base(0, true);
        await service.remove('u1');
        expect(manager.softRemove).toHaveBeenCalled();
        const sqls = (manager.query.mock.calls as [string][]).map(([q]) => q);
        expect(sqls.some((q) => q.includes('count(*)'))).toBe(false);
        // y el lock se tomó ANTES de leer el estado
        expect(sqls[0]).toContain('pg_advisory_xact_lock');
        expect(sqls[1]).toContain('SELECT blocked');
      });
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
      expect(eventos.emitAsync).toHaveBeenCalledTimes(1);
      expect(eventos.emitAsync).toHaveBeenCalledWith(
        'usuario.dado-de-baja',
        expect.anything(),
      );
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

  describe('update: la contraseña se cambia al final de la transacción', () => {
    const conTransaccion = () => {
      const qr = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: { save: jest.fn(), findOne: jest.fn() },
      };
      (
        dataSource as unknown as { createQueryRunner: () => unknown }
      ).createQueryRunner = () => qr;
      return qr;
    };

    it('con los controles pasados, la cambia antes del commit', async () => {
      users.preload.mockResolvedValue({ userId: 'u1', firebaseUid: 'fb1' });
      const qr = conTransaccion();
      await service.update('u1', { password: 'Nueva1234' });
      expect(firebase.updateUser).toHaveBeenCalledWith(
        'fb1',
        expect.objectContaining({ password: 'Nueva1234' }),
      );
      expect(qr.commitTransaction).toHaveBeenCalled();
    });

    it('cambiar la clave de otro revoca sus sesiones, después del commit', async () => {
      users.preload.mockResolvedValue({ userId: 'u1', firebaseUid: 'fb1' });
      const qr = conTransaccion();
      await service.update('u1', { password: 'Nueva1234' });
      expect(firebase.revokeRefreshTokensSafe).toHaveBeenCalledWith(
        'fb1',
        expect.anything(),
      );
      expect(qr.commitTransaction.mock.invocationCallOrder[0]).toBeLessThan(
        firebase.revokeRefreshTokensSafe.mock.invocationCallOrder[0],
      );
    });

    it('bloquear por PATCH revoca las sesiones', async () => {
      users.preload.mockResolvedValue({ userId: 'u1', firebaseUid: 'fb1' });
      const qr = conTransaccion();
      qr.manager.findOne.mockResolvedValue(null);
      await service.update('u1', { blocked: true });
      expect(firebase.revokeRefreshTokensSafe).toHaveBeenCalledWith(
        'fb1',
        expect.anything(),
      );
    });

    it('editar sólo el nombre no revoca', async () => {
      users.preload.mockResolvedValue({ userId: 'u1', firebaseUid: 'fb1' });
      conTransaccion();
      await service.update('u1', { full_name: 'Ana' });
      expect(firebase.revokeRefreshTokensSafe).not.toHaveBeenCalled();
    });

    it('si falla la transacción no se revoca', async () => {
      users.preload.mockResolvedValue({ userId: 'u1', firebaseUid: 'fb1' });
      conTransaccion();
      const autorizar = jest.fn(() => Promise.reject(new ForbiddenException()));
      await expect(
        service.update('u1', { password: 'Nueva1234' }, autorizar),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(firebase.revokeRefreshTokensSafe).not.toHaveBeenCalled();
    });

    it('si un control de la transacción falla, no queda cambiada', async () => {
      users.preload.mockResolvedValue({ userId: 'u1', firebaseUid: 'fb1' });
      const qr = conTransaccion();
      const autorizar = jest.fn(() => Promise.reject(new ForbiddenException()));
      await expect(
        service.update('u1', { password: 'Nueva1234' }, autorizar),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(firebase.updateUser).not.toHaveBeenCalled();
      expect(qr.rollbackTransaction).toHaveBeenCalled();
    });
  });

  describe('update: teléfono único', () => {
    it('un teléfono que ya tiene otro usuario (aunque esté dado de baja) es 409 y no guarda', async () => {
      users.findOne.mockResolvedValue({ userId: 'otro' });
      await expect(
        service.update('u1', { phone_number: '+5493764000001' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(users.findOne).toHaveBeenCalledWith({
        where: { phoneNumber: '+5493764000001' },
        withDeleted: true,
      });
      expect(users.preload).not.toHaveBeenCalled();
    });

    it('el propio teléfono no choca consigo mismo', async () => {
      users.findOne.mockResolvedValue({ userId: 'u1' });
      users.preload.mockResolvedValue(undefined);
      await expect(
        service.update('u1', { phone_number: '+5493764000001' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(users.preload).toHaveBeenCalled();
    });
  });

  describe('removeOwnAccount', () => {
    const cliente = (over: object = {}) => ({
      userId: 'u1',
      firebaseUid: 'fb1',
      customer: { customerId: 'c1' },
      ...over,
    });

    it('da de baja lógica la cuenta, deshabilita Firebase y avisa a los oyentes', async () => {
      const user = cliente();
      users.findOne
        .mockResolvedValueOnce({ userId: 'u1', firebaseUid: 'fb1' })
        .mockResolvedValueOnce(user);
      await expect(service.removeOwnAccount('u1')).resolves.toEqual({
        message: 'Tu cuenta fue dada de baja',
      });
      expect(orderLookup.countActiveByCustomer).toHaveBeenCalledWith(
        'u1',
        manager,
      );
      expect(manager.softRemove).toHaveBeenCalledWith(user);
      expect(users.delete).not.toHaveBeenCalled();
      expect(firebase.updateUser).toHaveBeenCalledWith('fb1', {
        disabled: true,
      });
      expect(eventos.emitAsync).toHaveBeenCalledWith(
        'usuario.dado-de-baja',
        expect.objectContaining({ userId: 'u1' }),
      );
    });

    it('con pedidos en curso es 409 y no toca nada', async () => {
      users.findOne
        .mockResolvedValueOnce({ userId: 'u1', firebaseUid: 'fb1' })
        .mockResolvedValueOnce(cliente());
      orderLookup.countActiveByCustomer.mockResolvedValue(2);
      const error: unknown = await service
        .removeOwnAccount('u1')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toMatch(
        /2 pedido\(s\) en curso/,
      );
      expect(manager.softRemove).not.toHaveBeenCalled();
      expect(firebase.updateUser).not.toHaveBeenCalled();
    });

    it('cuenta los pedidos del usuario autenticado, de cualquier distribuidora', async () => {
      users.findOne
        .mockResolvedValueOnce({ userId: 'u1' })
        .mockResolvedValueOnce(cliente({ firebaseUid: null }));
      await service.removeOwnAccount('u1');
      // Sin filtro de tenant: lo del otro tenant también bloquea la baja.
      expect(orderLookup.countActiveByCustomer.mock.calls[0]).toEqual([
        'u1',
        manager,
      ]);
      expect(firebase.updateUser).not.toHaveBeenCalled();
    });

    it('repetida sobre una cuenta ya dada de baja es inocua: no vuelve a darla de baja', async () => {
      users.findOne.mockResolvedValueOnce({
        userId: 'u1',
        firebaseUid: 'fb1',
        deletedAt: new Date(),
      });
      await expect(service.removeOwnAccount('u1')).resolves.toEqual({
        message: 'Tu cuenta ya estaba dada de baja',
      });
      expect(manager.softRemove).not.toHaveBeenCalled();
      expect(eventos.emitAsync).not.toHaveBeenCalled();
      expect(firebase.updateUser).toHaveBeenCalledWith('fb1', {
        disabled: true,
      });
    });

    it('un usuario inexistente es 404', async () => {
      users.findOne.mockResolvedValueOnce(null);
      await expect(service.removeOwnAccount('nadie')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('bloquea la cuenta (FOR NO KEY UPDATE) antes de contar los pedidos', async () => {
      users.findOne
        .mockResolvedValueOnce({ userId: 'u1' })
        .mockResolvedValueOnce(cliente());
      manager.query.mockResolvedValueOnce([{ deleted: false }]);
      await service.removeOwnAccount('u1');
      const [sql, params] = manager.query.mock.calls[0] as [string, string[]];
      expect(sql).toContain('FROM "user"');
      expect(sql).toContain('FOR NO KEY UPDATE');
      expect(params).toEqual(['u1']);
      expect(manager.query.mock.invocationCallOrder[0]).toBeLessThan(
        orderLookup.countActiveByCustomer.mock.invocationCallOrder[0],
      );
    });

    it('doble baja concurrente: la que llega después de la otra no repite la baja', async () => {
      users.findOne
        .mockResolvedValueOnce({ userId: 'u1', firebaseUid: 'fb1' })
        .mockResolvedValueOnce(cliente());
      manager.query.mockResolvedValueOnce([{ deleted: true }]);
      await expect(service.removeOwnAccount('u1')).resolves.toEqual({
        message: 'Tu cuenta fue dada de baja',
      });
      expect(orderLookup.countActiveByCustomer).not.toHaveBeenCalled();
      expect(manager.softRemove).not.toHaveBeenCalled();
      expect(eventos.emitAsync).not.toHaveBeenCalled();
    });

    it('la baja que hace un admin (remove) no mira los pedidos del cliente', async () => {
      users.findOne.mockResolvedValue(cliente());
      orderLookup.countActiveByCustomer.mockResolvedValue(5);
      await service.remove('u1');
      expect(manager.softRemove).toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    const armarQb = () => {
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
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

    it('orden estable: la fecha de alta y, con la misma fecha, el id', async () => {
      const qb = armarQb();
      await service.findAll({});
      expect(qb.orderBy).toHaveBeenCalledWith('user.createdAt', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('user.userId', 'ASC');
    });

    it('sin role ni distribuidora (plataforma) lista sólo las cuentas del panel', async () => {
      const qb = armarQb();
      await service.findAll({});
      expect(qb.andWhere).toHaveBeenCalledTimes(1);
      expect(qb.andWhere).toHaveBeenCalledWith(
        'role.type IN (:...cuentasDePlataforma)',
        { cuentasDePlataforma: [RoleType.SUPER_ADMIN, RoleType.ADMIN] },
      );
    });

    it('con distribuidora no se limita a las cuentas del panel', async () => {
      const qb = armarQb();
      await service.findAll({}, 'd1');
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        'role.type IN (:...cuentasDePlataforma)',
        expect.anything(),
      );
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

  describe('toggleBlockUser', () => {
    const admin = {
      userId: 'u1',
      email: 'a@splg.com',
      blocked: false,
      role: { type: RoleType.ADMIN },
      admins: [{ distributorId: 'd1' }],
    };
    const conManager = (otros: number) => {
      const m = {
        query: jest.fn((sql: string) =>
          Promise.resolve(
            sql.includes('count(*)')
              ? [{ n: String(otros) }]
              : sql.includes('SELECT blocked')
                ? [{ blocked: false }]
                : [],
          ),
        ),
        findOneByOrFail: jest
          .fn()
          .mockResolvedValue({ userId: 'u1', blocked: false }),
        save: jest.fn(),
      };
      dataSource.transaction.mockImplementation(
        (fn: (x: unknown) => Promise<unknown>) => fn(m),
      );
      return m;
    };

    it('bloquear al último admin activo es 409 y no guarda nada', async () => {
      users.findOne.mockResolvedValue(admin);
      const m = conManager(0);
      await expect(service.toggleBlockUser('u1', true)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(m.save).not.toHaveBeenCalled();
      expect(eventos.emit).not.toHaveBeenCalled();
    });

    it('bloquear corta sus conexiones; desbloquear no', async () => {
      users.findOne.mockResolvedValue(admin);
      conManager(1);
      await service.toggleBlockUser('u1', true);
      expect(eventos.emit).toHaveBeenCalledWith(
        'usuario.acceso-revocado',
        expect.objectContaining({ userId: 'u1', motivo: 'bloqueo' }),
      );
      eventos.emit.mockClear();
      await service.toggleBlockUser('u1', false);
      expect(eventos.emit).not.toHaveBeenCalled();
    });

    it('bloquear revoca las sesiones de Firebase; desbloquear no', async () => {
      users.findOne.mockResolvedValue({ ...admin, firebaseUid: 'fb1' });
      conManager(1);
      await service.toggleBlockUser('u1', true);
      expect(firebase.revokeRefreshTokensSafe).toHaveBeenCalledWith(
        'fb1',
        expect.anything(),
      );
      firebase.revokeRefreshTokensSafe.mockClear();
      await service.toggleBlockUser('u1', false);
      expect(firebase.revokeRefreshTokensSafe).not.toHaveBeenCalled();
    });

    it('el bloqueo que no se concreta (último admin) no revoca nada', async () => {
      users.findOne.mockResolvedValue({ ...admin, firebaseUid: 'fb1' });
      conManager(0);
      await expect(service.toggleBlockUser('u1', true)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(firebase.revokeRefreshTokensSafe).not.toHaveBeenCalled();
    });

    it('con otro activo bloquea, y desbloquear no pasa por la regla', async () => {
      users.findOne.mockResolvedValue(admin);
      const m = conManager(1);
      await service.toggleBlockUser('u1', true);
      expect(m.save).toHaveBeenCalledWith(
        expect.objectContaining({ blocked: true }),
      );
      m.query.mockClear();
      await service.toggleBlockUser('u1', false);
      expect(m.query).not.toHaveBeenCalled();
    });
  });

  describe('la regla sobre la cuenta de otro corre dentro de la transacción que escribe', () => {
    const admin = {
      userId: 'u1',
      email: 'a@splg.com',
      blocked: false,
      firebaseUid: 'fb',
      role: { type: RoleType.ADMIN },
      admins: [{ distributorId: 'd1' }],
    };
    const rechaza = () =>
      jest.fn((m: unknown) => {
        orden.push(m === manager ? 'regla-en-tx' : 'regla-fuera');
        return Promise.reject(new ForbiddenException());
      });
    let orden: string[];

    beforeEach(() => {
      orden = [];
      manager.query.mockImplementation((sql: string) => {
        orden.push(sql.includes('pg_advisory') ? 'lock' : 'consulta');
        return Promise.resolve(
          sql.includes('count(*)')
            ? [{ n: '1' }]
            : sql.includes('SELECT blocked')
              ? [{ blocked: false }]
              : [],
        );
      });
      users.findOne.mockResolvedValue(admin);
    });

    it('baja: primero la regla, con el manager de la transacción; si dice que no, no da de baja', async () => {
      const autorizar = rechaza();
      await expect(service.remove('u1', { autorizar })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(orden[0]).toBe('regla-en-tx');
      expect(manager.softRemove).not.toHaveBeenCalled();
      expect(firebase.deleteUserSafe).not.toHaveBeenCalled();
    });

    it('bloqueo: primero la regla; si dice que no, no guarda ni corta conexiones', async () => {
      const m = {
        query: manager.query,
        findOneByOrFail: jest.fn().mockResolvedValue({ userId: 'u1' }),
        save: jest.fn(),
      };
      dataSource.transaction.mockImplementation(
        (fn: (x: unknown) => Promise<unknown>) => fn(m),
      );
      const autorizar = jest.fn(() => Promise.reject(new ForbiddenException()));
      await expect(
        service.toggleBlockUser('u1', true, autorizar),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(autorizar).toHaveBeenCalledWith(m);
      expect(m.save).not.toHaveBeenCalled();
      expect(eventos.emit).not.toHaveBeenCalled();
    });

    it('edición: la regla corre en la transacción y, si dice que no, no guarda', async () => {
      users.preload.mockResolvedValue({ ...admin, fullName: 'Otro' });
      const qr = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: { save: jest.fn(), findOne: jest.fn() },
      };
      (
        dataSource as unknown as { createQueryRunner: () => unknown }
      ).createQueryRunner = () => qr;
      const autorizar = jest.fn(() => Promise.reject(new ForbiddenException()));
      await expect(
        service.update('u1', { full_name: 'Otro' }, autorizar),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(autorizar).toHaveBeenCalledWith(qr.manager);
      expect(qr.manager.save).not.toHaveBeenCalled();
      expect(qr.rollbackTransaction).toHaveBeenCalled();
      expect(qr.commitTransaction).not.toHaveBeenCalled();
    });
  });

  describe('revocarSesionesDe', () => {
    it('revoca por el uid del usuario', async () => {
      users.findOne.mockResolvedValue({ userId: 'u1', firebaseUid: 'fb1' });
      await service.revocarSesionesDe('u1');
      expect(firebase.revokeRefreshTokensSafe).toHaveBeenCalledWith(
        'fb1',
        expect.anything(),
      );
    });

    it('sin cuenta de acceso o inexistente no hace nada', async () => {
      users.findOne.mockResolvedValueOnce({ userId: 'u1', firebaseUid: null });
      await service.revocarSesionesDe('u1');
      users.findOne.mockResolvedValueOnce(null);
      await service.revocarSesionesDe('u2');
      expect(firebase.revokeRefreshTokensSafe).not.toHaveBeenCalled();
    });
  });

  describe('bloquearEnTransaccion (egreso de un empleado)', () => {
    const conAdmin = (otros: number) => {
      const m = {
        findOne: jest.fn().mockResolvedValue({
          userId: 'u1',
          blocked: false,
          role: { type: RoleType.ADMIN },
          admins: [{ distributorId: 'd1' }],
        }),
        query: jest.fn((sql: string) =>
          Promise.resolve(
            sql.includes('count(*)')
              ? [{ n: String(otros) }]
              : sql.includes('SELECT blocked')
                ? [{ blocked: false }]
                : [],
          ),
        ),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      return m;
    };

    it('el último administrador activo de la empresa no se bloquea por el egreso (409)', async () => {
      const m = conAdmin(0);
      await expect(
        service.bloquearEnTransaccion(m as unknown as EntityManager, 'u1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(m.update).not.toHaveBeenCalled();
    });

    it('con otro administrador activo, bloquea', async () => {
      const m = conAdmin(1);
      await service.bloquearEnTransaccion(m as unknown as EntityManager, 'u1');
      expect(m.update).toHaveBeenCalledWith(
        User,
        { userId: 'u1' },
        { blocked: true },
      );
    });
  });
});
