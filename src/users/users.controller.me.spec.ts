import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Server } from 'http';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UserPhotoService } from './user-photo.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

/**
 * `DELETE /users/me`: la baja de la propia cuenta es del cliente y se hace
 * siempre sobre el usuario del token. El guard de autenticación no corre acá:
 * un middleware deja el usuario que dejaría, y se registra el `RolesGuard` real.
 */
describe('UsersController · DELETE /users/me', () => {
  let app: INestApplication<Server>;
  let users: { removeOwnAccount: jest.Mock; remove: jest.Mock };
  let usuario: AuthenticatedUser;

  beforeEach(async () => {
    usuario = { user_id: 'u1', email: 'c@splg.com', role: RoleType.CUSTOMER };
    users = {
      removeOwnAccount: jest
        .fn()
        .mockResolvedValue({ message: 'Tu cuenta fue dada de baja' }),
      remove: jest.fn(),
    };
    const modulo = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: users },
        { provide: UserPhotoService, useValue: {} },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = usuario;
      req.distributorId = 'd1';
      next();
    });
    await app.listen(0, '127.0.0.1'); // una sola vez y en loopback, adonde se conecta supertest: si no, falla al azar con carga
  });

  afterEach(async () => {
    await app.close();
  });

  it('el cliente da de baja SU cuenta (la del token) y no pasa por la baja de admin', async () => {
    const res = await request(app.getHttpServer()).delete('/users/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Tu cuenta fue dada de baja' });
    expect(users.removeOwnAccount).toHaveBeenCalledWith('u1');
    expect(users.remove).not.toHaveBeenCalled();
  });

  it.each([RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY])(
    'el rol %s no entra (403)',
    async (role) => {
      usuario = { ...usuario, role };
      await request(app.getHttpServer()).delete('/users/me').expect(403);
      expect(users.removeOwnAccount).not.toHaveBeenCalled();
    },
  );
});
