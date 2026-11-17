import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Server } from 'http';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { StaffRoleService } from './staff-role.service';
import { RoleType } from '../common/constants/role-type.enum';
import { crearValidationPipe } from '../common/validation/validation-pipe';

const EMPRESA_A = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';
const EMPRESA_B = '9d8e7f60-1b2c-4d3e-8f4a-5b6c7d8e9f01';

/**
 * `GET /admin?distributorId=`: el super admin fuera de soporte lista los
 * admins de UNA empresa (o todos); en modo soporte queda en la empresa de la
 * sesión, como un admin de ella; un admin de empresa nunca ve los de otra. El guard global no corre acá: un middleware deja en la request el
 * usuario y la distribuidora que el guard dejaría.
 */
describe('AdminController · GET /admin', () => {
  let app: INestApplication<Server>;
  let admins: { findAll: jest.Mock };
  let rol: RoleType;
  let contexto: string | null;

  beforeEach(async () => {
    admins = { findAll: jest.fn().mockResolvedValue([]) };
    const modulo = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: AdminService, useValue: admins },
        {
          provide: StaffRoleService,
          useValue: { assertPuedeAdministrarA: () => Promise.resolve() },
        },
      ],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = {
        email: 'x@splg.com',
        role: rol,
        user_id: 'u1',
        distributor_id: contexto,
        // Con empresa en contexto, el super admin sólo puede estar en soporte.
        support_session_id:
          rol === RoleType.SUPER_ADMIN && contexto ? 'sesion-1' : null,
      };
      req.distributorId = contexto;
      next();
    });
    app.useGlobalPipes(crearValidationPipe({ forbidNonWhitelisted: false }));
    await app.listen(0, '127.0.0.1'); // una sola vez y en loopback, adonde se conecta supertest: si no, falla al azar con carga
  });

  afterEach(async () => {
    await app.close();
  });

  describe('super admin', () => {
    beforeEach(() => {
      rol = RoleType.SUPER_ADMIN;
    });

    it('fuera de soporte, con ?distributorId= lista los de esa empresa', async () => {
      contexto = null;
      await request(app.getHttpServer())
        .get(`/admin?distributorId=${EMPRESA_B}`)
        .expect(200);
      expect(admins.findAll).toHaveBeenCalledWith(EMPRESA_B);
    });

    it('en modo soporte, sin el parámetro usa la empresa de la sesión', async () => {
      contexto = EMPRESA_A;
      await request(app.getHttpServer()).get('/admin').expect(200);
      expect(admins.findAll).toHaveBeenCalledWith(EMPRESA_A);
    });

    it('en modo soporte, pedir los de OTRA empresa es 403 y no consulta nada', async () => {
      contexto = EMPRESA_A;
      await request(app.getHttpServer())
        .get(`/admin?distributorId=${EMPRESA_B}`)
        .expect(403);
      expect(admins.findAll).not.toHaveBeenCalled();
    });

    it('sin parámetro ni contexto lista todos', async () => {
      contexto = null;
      await request(app.getHttpServer()).get('/admin').expect(200);
      expect(admins.findAll).toHaveBeenCalledWith(null);
    });

    it('un distributorId que no es UUID es 400', async () => {
      contexto = null;
      await request(app.getHttpServer())
        .get('/admin?distributorId=abc')
        .expect(400);
    });
  });

  describe('admin de empresa', () => {
    beforeEach(() => {
      rol = RoleType.ADMIN;
      contexto = EMPRESA_A;
    });

    it('pedir los de OTRA empresa es 403 y no consulta nada', async () => {
      await request(app.getHttpServer())
        .get(`/admin?distributorId=${EMPRESA_B}`)
        .expect(403);
      expect(admins.findAll).not.toHaveBeenCalled();
    });

    it('pedir los de la suya anda', async () => {
      await request(app.getHttpServer())
        .get(`/admin?distributorId=${EMPRESA_A}`)
        .expect(200);
      expect(admins.findAll).toHaveBeenCalledWith(EMPRESA_A);
    });

    it('sin el parámetro ve los de la suya', async () => {
      await request(app.getHttpServer()).get('/admin').expect(200);
      expect(admins.findAll).toHaveBeenCalledWith(EMPRESA_A);
    });
  });
});

/**
 * `PATCH` y `DELETE /admin/:id`: el super admin llega a cualquiera; un admin de
 * empresa no se toca a sí mismo ni a un super admin (404 para no revelarlo).
 */
describe('AdminController · PATCH y DELETE /admin/:id', () => {
  const ID = '7c1f0b3e-5a2d-4e8f-9b6a-1d2c3e4f5a60';
  let app: INestApplication<Server>;
  let admins: { findDetail: jest.Mock; update: jest.Mock; remove: jest.Mock };
  let rol: RoleType;

  const perfil = (over: object = {}) => ({
    adminId: ID,
    userId: 'otro',
    distributorId: EMPRESA_A,
    user: { role: { type: RoleType.ADMIN } },
    ...over,
  });

  beforeEach(async () => {
    admins = {
      findDetail: jest.fn().mockResolvedValue(perfil()),
      update: jest.fn().mockResolvedValue(perfil()),
      remove: jest.fn().mockResolvedValue({ message: 'ok' }),
    };
    const modulo = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: AdminService, useValue: admins },
        {
          provide: StaffRoleService,
          useValue: { assertPuedeAdministrarA: () => Promise.resolve() },
        },
      ],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = {
        email: 'x@splg.com',
        role: rol,
        user_id: 'yo',
        distributor_id: EMPRESA_A,
      };
      req.distributorId = EMPRESA_A;
      next();
    });
    app.useGlobalPipes(crearValidationPipe());
    await app.listen(0, '127.0.0.1'); // una sola vez y en loopback, adonde se conecta supertest: si no, falla al azar con carga
  });

  afterEach(async () => {
    await app.close();
  });

  it('un admin de empresa edita y da de baja a otro de su empresa', async () => {
    rol = RoleType.ADMIN;
    await request(app.getHttpServer())
      .patch(`/admin/${ID}`)
      .send({ fullName: 'Ana' })
      .expect(200);
    expect(admins.update).toHaveBeenCalledWith(
      ID,
      { fullName: 'Ana' },
      EMPRESA_A,
      expect.any(Function),
    );
    await request(app.getHttpServer()).delete(`/admin/${ID}`).expect(200);
    expect(admins.remove).toHaveBeenCalledWith(
      ID,
      EMPRESA_A,
      expect.any(Function),
    );
  });

  it('un admin de empresa no se edita ni se da de baja a sí mismo (403)', async () => {
    rol = RoleType.ADMIN;
    admins.findDetail.mockResolvedValue(perfil({ userId: 'yo' }));
    await request(app.getHttpServer())
      .patch(`/admin/${ID}`)
      .send({ fullName: 'Ana' })
      .expect(403);
    await request(app.getHttpServer()).delete(`/admin/${ID}`).expect(403);
    expect(admins.update).not.toHaveBeenCalled();
    expect(admins.remove).not.toHaveBeenCalled();
  });

  it('un super admin tampoco se da de baja a sí mismo (403), pero sí edita su perfil', async () => {
    rol = RoleType.SUPER_ADMIN;
    admins.findDetail.mockResolvedValue(
      perfil({
        userId: 'yo',
        user: { role: { type: RoleType.SUPER_ADMIN } },
      }),
    );
    await request(app.getHttpServer()).delete(`/admin/${ID}`).expect(403);
    expect(admins.remove).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .patch(`/admin/${ID}`)
      .send({ fullName: 'Yo' })
      .expect(200);
  });

  it('un admin de empresa no toca a un super admin (404)', async () => {
    rol = RoleType.ADMIN;
    admins.findDetail.mockResolvedValue(
      perfil({ user: { role: { type: RoleType.SUPER_ADMIN } } }),
    );
    await request(app.getHttpServer()).delete(`/admin/${ID}`).expect(404);
    expect(admins.remove).not.toHaveBeenCalled();
  });

  it('el super admin llega a cualquiera, incluso a otro super admin', async () => {
    rol = RoleType.SUPER_ADMIN;
    admins.findDetail.mockResolvedValue(
      perfil({ user: { role: { type: RoleType.SUPER_ADMIN } } }),
    );
    await request(app.getHttpServer()).delete(`/admin/${ID}`).expect(200);
  });

  it('rechaza el correo y los campos que no son editables (400)', async () => {
    rol = RoleType.SUPER_ADMIN;
    await request(app.getHttpServer())
      .patch(`/admin/${ID}`)
      .send({ email: 'x@y.com' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/admin/${ID}`)
      .send({ phoneNumber: '1234' })
      .expect(400);
  });
});
