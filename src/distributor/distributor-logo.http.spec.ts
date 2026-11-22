import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { Server } from 'http';
import request from 'supertest';
import { PermissionGuard } from '../admin/guards/permission.guard';
import { StaffPermissionsService } from '../admin/staff-permissions.service';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter';
import { AlcanceGuard } from '../common/guards/alcance.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { Permiso } from '../common/permisos/catalogo';
import { crearValidationPipe } from '../common/validation/validation-pipe';
import { EntityPhotoService } from '../s3/entity-photo.service';
import { DistributorController } from './distributor.controller';
import { DistributorLogoService } from './distributor-logo.service';
import { DistributorService } from './distributor.service';

const A = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';
const B = '0d6f0c34-8b7e-4c1a-9f3b-5a2e7d9c1b20';
const SIN_LOGO = '6b1e2a40-9c3d-4e5f-8a7b-1c2d3e4f5a6b';
const INEXISTENTE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const SESION = '11111111-1111-4111-8111-111111111111';

const LOGOS: Record<string, string | null> = {
  [A]: `distributors/${A}/logo/a.png`,
  [B]: `distributors/${B}/logo/b.png`,
  [SIN_LOGO]: null,
};

/**
 * El `AuthGuard` reducido a headers: sin token 401; el rol sale de `x-rol`, la
 * empresa del admin de `x-empresa` y la sesión de soporte del super admin de
 * `x-sesion-en` (la empresa de la sesión), como los deja el guard real.
 */
class AuthDePrueba implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.headers.authorization) {
      throw new UnauthorizedException('Sin token o token inválido');
    }
    const role = req.headers['x-rol'] as RoleType;
    const deSesion = req.headers['x-sesion-en'] as string | undefined;
    const empresa =
      role === RoleType.SUPER_ADMIN
        ? (deSesion ?? null)
        : ((req.headers['x-empresa'] as string | undefined) ?? null);
    req.user = {
      user_id: 'u1',
      email: 'u@splg.local',
      role,
      distributor_id: empresa,
      support_session_id: deSesion ? SESION : null,
    } as AuthenticatedUser;
    req.distributorId = empresa;
    req.supportSession = deSesion
      ? {
          id: SESION,
          distributorId: deSesion,
          scope: ['files'],
          expiresAt: new Date('2099-01-01T00:00:00Z'),
        }
      : undefined;
    return true;
  }
}

/**
 * Matriz HTTP del logo de una empresa (`/distributor/:id/logo`) con los guards
 * reales de rol, permiso y alcance: la plataforma LEE el logo de cualquier
 * empresa sin sesión de soporte (es identidad visual); subirlo o quitarlo, y
 * el resto de lo de una empresa, sigue pidiendo la sesión.
 */
describe('Logo de una empresa: matriz HTTP (GET/PUT/DELETE /distributor/:id/logo)', () => {
  let app: INestApplication<Server>;
  let permisosDelAdmin: Permiso[] = [];

  const distribuidoras = {
    findOne: jest.fn((id: string) =>
      id in LOGOS
        ? Promise.resolve({
            distributorId: id,
            name: 'Gas',
            logoKey: LOGOS[id],
          })
        : Promise.reject(new NotFoundException('Distribuidora no encontrada')),
    ),
  };
  const fotos = {
    enlace: jest.fn((key: string | null) =>
      Promise.resolve(
        key
          ? {
              kind: 'stored',
              signed: {
                url: `https://s3.test/${key}?X-Amz-Signature=abc`,
                expiresAt: new Date('2026-11-21T12:05:00Z'),
                requiresAuth: false,
              },
            }
          : { kind: 'none' },
      ),
    ),
    firmar: jest.fn(() => Promise.resolve()),
    guardar: jest.fn(() => Promise.resolve()),
    quitar: jest.fn(() => Promise.resolve()),
  };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [DistributorController],
      providers: [
        DistributorLogoService,
        { provide: DistributorService, useValue: distribuidoras },
        { provide: EntityPhotoService, useValue: fotos },
        {
          provide: StaffPermissionsService,
          useValue: {
            deUsuario: () =>
              Promise.resolve({
                todos: false,
                rol: null,
                permisos: permisosDelAdmin,
              }),
          },
        },
        Reflector,
        { provide: APP_GUARD, useClass: AuthDePrueba },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: APP_GUARD, useClass: AlcanceGuard },
      ],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.useGlobalFilters(new GlobalExceptionFilter(app.getHttpAdapter()));
    app.useGlobalPipes(crearValidationPipe());
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    permisosDelAdmin = ['configuracion.ver', 'configuracion.gestionar'];
    jest.clearAllMocks();
  });

  const plataforma = {
    authorization: 'Bearer x',
    'x-rol': RoleType.SUPER_ADMIN,
  };
  const enSoporte = (empresa: string) => ({
    ...plataforma,
    'x-sesion-en': empresa,
  });
  const admin = (empresa: string) => ({
    authorization: 'Bearer x',
    'x-rol': RoleType.ADMIN,
    'x-empresa': empresa,
  });
  const http = () => request(app.getHttpServer());
  const cuerpoDe = (res: { body: unknown }) =>
    res.body as Record<string, unknown>;

  describe('GET /distributor/:id/logo', () => {
    it('sin token, 401', async () => {
      await http().get(`/distributor/${A}/logo?modo=url`).expect(401);
    });

    it('un id que no es UUID o un modo desconocido, 400', async () => {
      await http()
        .get('/distributor/no-es-uuid/logo')
        .set(plataforma)
        .expect(400);
      await http()
        .get(`/distributor/${A}/logo?modo=otro`)
        .set(plataforma)
        .expect(400);
    });

    it('el super admin SIN sesión de soporte recibe la URL firmada de cualquier empresa (200)', async () => {
      for (const id of [A, B]) {
        const res = await http()
          .get(`/distributor/${id}/logo?modo=url`)
          .set(plataforma)
          .expect(200);
        expect(cuerpoDe(res).url).toBe(
          `https://s3.test/${LOGOS[id]}?X-Amz-Signature=abc`,
        );
      }
    });

    it('el super admin sin sesión y sin `modo`: redirige a la URL firmada (302)', async () => {
      const res = await http()
        .get(`/distributor/${A}/logo`)
        .set(plataforma)
        .expect(302);
      expect(res.headers.location).toContain(LOGOS[A]);
    });

    it('una empresa sin logo: `url: null` con `modo=url` (200) y 404 sin `modo`', async () => {
      const res = await http()
        .get(`/distributor/${SIN_LOGO}/logo?modo=url`)
        .set(plataforma)
        .expect(200);
      expect(cuerpoDe(res).url).toBeNull();
      await http()
        .get(`/distributor/${SIN_LOGO}/logo`)
        .set(plataforma)
        .expect(404);
    });

    it('una empresa que no existe, 404', async () => {
      await http()
        .get(`/distributor/${INEXISTENTE}/logo?modo=url`)
        .set(plataforma)
        .expect(404);
    });

    it('el super admin CON sesión de soporte ve el de esa empresa (200) y el de otra no (404)', async () => {
      await http()
        .get(`/distributor/${A}/logo?modo=url`)
        .set(enSoporte(A))
        .expect(200);
      await http()
        .get(`/distributor/${B}/logo?modo=url`)
        .set(enSoporte(A))
        .expect(404);
    });

    it('el admin ve el de su empresa (200); el de otra no existe para él (404)', async () => {
      await http()
        .get(`/distributor/${A}/logo?modo=url`)
        .set(admin(A))
        .expect(200);
      const res = await http()
        .get(`/distributor/${B}/logo?modo=url`)
        .set(admin(A))
        .expect(404);
      expect(cuerpoDe(res).message).toBe('Distribuidora no encontrada');
      expect(fotos.enlace).toHaveBeenCalledTimes(1);
    });

    it('el admin sin el permiso de ver la configuración, 403', async () => {
      permisosDelAdmin = [];
      const res = await http()
        .get(`/distributor/${A}/logo?modo=url`)
        .set(admin(A))
        .expect(403);
      expect(cuerpoDe(res).code).toBe('PERMISSION_DENIED');
    });

    it.each([RoleType.CUSTOMER, RoleType.DELIVERY])(
      'una cuenta de las apps (%s), 403',
      async (rol) => {
        await http()
          .get(`/distributor/${A}/logo?modo=url`)
          .set({ authorization: 'Bearer x', 'x-rol': rol, 'x-empresa': A })
          .expect(403);
        expect(fotos.enlace).not.toHaveBeenCalled();
      },
    );
  });

  describe('PUT y DELETE /distributor/:id/logo: lo abierto es sólo la lectura', () => {
    it('el super admin sin sesión de soporte no sube ni quita el logo (403 SUPPORT_SESSION_REQUIRED)', async () => {
      const subir = await http()
        .put(`/distributor/${A}/logo`)
        .set(plataforma)
        .expect(403);
      expect(cuerpoDe(subir).code).toBe('SUPPORT_SESSION_REQUIRED');
      const quitar = await http()
        .delete(`/distributor/${A}/logo`)
        .set(plataforma)
        .expect(403);
      expect(cuerpoDe(quitar).code).toBe('SUPPORT_SESSION_REQUIRED');
      expect(fotos.guardar).not.toHaveBeenCalled();
      expect(fotos.quitar).not.toHaveBeenCalled();
    });

    it('con sesión de soporte tampoco: es sólo lectura (403 SUPPORT_READ_ONLY)', async () => {
      const subir = await http()
        .put(`/distributor/${A}/logo`)
        .set(enSoporte(A))
        .expect(403);
      expect(cuerpoDe(subir).code).toBe('SUPPORT_READ_ONLY');
      const quitar = await http()
        .delete(`/distributor/${A}/logo`)
        .set(enSoporte(A))
        .expect(403);
      expect(cuerpoDe(quitar).code).toBe('SUPPORT_READ_ONLY');
      expect(fotos.quitar).not.toHaveBeenCalled();
    });

    it('el admin quita el de su empresa (200) y no el de otra (404)', async () => {
      await http().delete(`/distributor/${A}/logo`).set(admin(A)).expect(200);
      expect(fotos.quitar).toHaveBeenCalledTimes(1);
      await http().delete(`/distributor/${B}/logo`).set(admin(A)).expect(404);
      expect(fotos.quitar).toHaveBeenCalledTimes(1);
    });
  });
});
