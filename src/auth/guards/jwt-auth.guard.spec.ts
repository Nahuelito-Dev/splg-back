import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthGuard } from './jwt-auth.guard';
import { AuthService } from '../auth.service';
import { UsersService } from '../../users/users.service';
import { DistributorService } from '../../distributor/distributor.service';
import { RoleType } from '../../common/constants/role-type.enum';
import { User } from '../../users/entities/user.entity';
import {
  Public,
  PublicIdentificable,
} from '../../common/decorators/isPublic.decorator';
import { SinDistribuidora } from '../../common/decorators/sin-distribuidora.decorator';

/** La marca va en la CLASE, no en el método: así la prueba exige que el guard
 * la busque con `getAllAndOverride` sobre handler Y clase (si sólo mirara el
 * handler, quedaría ignorada en silencio). */
@SinDistribuidora()
class ControladorMarcadoEnClase {
  metodo(): void {}
}

class ControladorSinMarca {
  metodo(): void {}
}

class ControladorPublicoIdentificable {
  @PublicIdentificable()
  metodo(): void {}
}

function contextoCon(
  request: Request,
  Controller: new () => { metodo: () => void } = ControladorSinMarca,
): ExecutionContext {
  const instancia = new Controller();
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => instancia.metodo,
    getClass: () => Controller,
  } as unknown as ExecutionContext;
}

function requestCon(headers: Record<string, string>): Request {
  return { headers, method: 'GET', url: '/auth' } as unknown as Request;
}

const headerConDistribuidoraInexistente = {
  authorization: 'Bearer token-valido',
  'x-client-source': 'panel-app',
  'x-distributor': 'distribuidora-que-no-existe',
};

/**
 * `@SinDistribuidora()` ignora sólo el HEADER `X-Distributor`, no el tenant:
 *  - customer/super_admin resuelven por header → con la marca, se comportan
 *    como si no hubiese header (null, sin validar nada contra la base).
 *  - admin/delivery NUNCA leen el header (su distribuidora sale siempre de
 *    su perfil): la marca no les cambia nada, y si no tienen distribuidora
 *    asignada siguen rechazados igual que sin la marca.
 * Se usa un `Reflector` real (no mockeado) para probar de verdad que
 * `getAllAndOverride` encuentra la marca puesta en la CLASE del controller.
 */
describe('AuthGuard — @SinDistribuidora() ignora el header, no el tenant', () => {
  const reflector = new Reflector();
  let authService: { decodeToken: jest.Mock };
  let usersService: { findOneByEmail: jest.Mock };
  let distributorService: { findBySlug: jest.Mock; assertActive: jest.Mock };
  let guard: AuthGuard;

  const superAdmin = {
    email: 'super@splg.com',
    blocked: false,
    role: { type: RoleType.SUPER_ADMIN },
  } as unknown as User;

  const adminConDistribuidora = {
    email: 'admin@splg.com',
    blocked: false,
    role: { type: RoleType.ADMIN },
    admins: [{ distributorId: 'distribuidora-del-admin' }],
  } as unknown as User;

  const adminSinDistribuidora = {
    email: 'admin-huerfano@splg.com',
    blocked: false,
    role: { type: RoleType.ADMIN },
    admins: [],
  } as unknown as User;

  beforeEach(() => {
    authService = { decodeToken: jest.fn() };
    usersService = { findOneByEmail: jest.fn() };
    distributorService = { findBySlug: jest.fn(), assertActive: jest.fn() };
    guard = new AuthGuard(
      reflector,
      authService as unknown as AuthService,
      usersService as unknown as UsersService,
      distributorService as unknown as DistributorService,
    );
  });

  function loguearComo(usuario: User): void {
    authService.decodeToken.mockResolvedValue({
      email: usuario.email,
      user: 'u1',
      sub: 'u1',
    });
    usersService.findOneByEmail.mockResolvedValue(usuario);
  }

  it('super admin CON la marca: un X-Distributor inexistente no rompe la request (queda null)', async () => {
    loguearComo(superAdmin);
    const request = requestCon(headerConDistribuidoraInexistente);

    await expect(
      guard.canActivate(contextoCon(request, ControladorMarcadoEnClase)),
    ).resolves.toBe(true);

    expect(request.distributorId).toBeNull();
    expect(distributorService.findBySlug).not.toHaveBeenCalled();
    expect(distributorService.assertActive).not.toHaveBeenCalled();
  });

  it('super admin SIN la marca: el mismo header inexistente sigue rompiendo la request', async () => {
    loguearComo(superAdmin);
    distributorService.findBySlug.mockRejectedValue(new NotFoundException());
    const request = requestCon(headerConDistribuidoraInexistente);

    await expect(
      guard.canActivate(contextoCon(request, ControladorSinMarca)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('admin CON la marca: sigue acotado a SU distribuidora (la marca no lo cruza de tenant)', async () => {
    loguearComo(adminConDistribuidora);
    const request = requestCon(headerConDistribuidoraInexistente);

    await expect(
      guard.canActivate(contextoCon(request, ControladorMarcadoEnClase)),
    ).resolves.toBe(true);

    expect(request.distributorId).toBe('distribuidora-del-admin');
    // El admin nunca depende del header: ni con la marca ni sin ella se
    // valida contra la base.
    expect(distributorService.findBySlug).not.toHaveBeenCalled();
    expect(distributorService.assertActive).not.toHaveBeenCalled();
  });

  it('admin sin distribuidora en el perfil: CON la marca sigue rechazado (no se degrada a cross-tenant)', async () => {
    loguearComo(adminSinDistribuidora);
    const request = requestCon(headerConDistribuidoraInexistente);

    await expect(
      guard.canActivate(contextoCon(request, ControladorMarcadoEnClase)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthGuard — @PublicIdentificable()', () => {
  const reflector = new Reflector();
  let authService: { decodeToken: jest.Mock };
  let usersService: { findOneByEmail: jest.Mock };
  let distributorService: { findBySlug: jest.Mock; assertActive: jest.Mock };
  let guard: AuthGuard;

  const admin = {
    email: 'admin@splg.com',
    blocked: false,
    role: { type: RoleType.ADMIN },
    admins: [{ distributorId: 'distribuidora-del-admin' }],
  } as unknown as User;

  beforeEach(() => {
    authService = { decodeToken: jest.fn() };
    usersService = { findOneByEmail: jest.fn() };
    distributorService = { findBySlug: jest.fn(), assertActive: jest.fn() };
    guard = new AuthGuard(
      reflector,
      authService as unknown as AuthService,
      usersService as unknown as UsersService,
      distributorService as unknown as DistributorService,
    );
  });

  const conToken = {
    authorization: 'Bearer token-valido',
    'x-client-source': 'panel-app',
  };

  it('con token de un admin deja su distribuidora en la request', async () => {
    authService.decodeToken.mockResolvedValue({ email: admin.email });
    usersService.findOneByEmail.mockResolvedValue(admin);
    const request = requestCon(conToken);

    await expect(
      guard.canActivate(contextoCon(request, ControladorPublicoIdentificable)),
    ).resolves.toBe(true);

    expect(request.distributorId).toBe('distribuidora-del-admin');
  });

  it('sin token queda anónima: distributorId null y no rechaza', async () => {
    const request = requestCon({});

    await expect(
      guard.canActivate(contextoCon(request, ControladorPublicoIdentificable)),
    ).resolves.toBe(true);

    expect(request.distributorId).toBeNull();
    expect(authService.decodeToken).not.toHaveBeenCalled();
  });

  it('con un token inválido tampoco rechaza: queda anónima', async () => {
    authService.decodeToken.mockRejectedValue(
      new UnauthorizedException('token vencido'),
    );
    const request = requestCon(conToken);

    await expect(
      guard.canActivate(contextoCon(request, ControladorPublicoIdentificable)),
    ).resolves.toBe(true);

    expect(request.distributorId).toBeNull();
    expect(request.user).toBeUndefined();
  });

  it('una caída de la base NO se confunde con "sin sesión": se propaga', async () => {
    authService.decodeToken.mockResolvedValue({ email: admin.email });
    usersService.findOneByEmail.mockRejectedValue(
      new Error('connection terminated'),
    );
    const request = requestCon(conToken);

    await expect(
      guard.canActivate(contextoCon(request, ControladorPublicoIdentificable)),
    ).rejects.toThrow('connection terminated');
  });

  it('un usuario inexistente (404 del servicio) sí queda anónimo', async () => {
    authService.decodeToken.mockResolvedValue({ email: admin.email });
    usersService.findOneByEmail.mockRejectedValue(new NotFoundException());
    const request = requestCon(conToken);

    await expect(
      guard.canActivate(contextoCon(request, ControladorPublicoIdentificable)),
    ).resolves.toBe(true);
    expect(request.distributorId).toBeNull();
  });

  it('una ruta @Public común no mira el token', async () => {
    const request = requestCon(conToken);
    class Comun {
      @Public()
      metodo(): void {}
    }
    await expect(guard.canActivate(contextoCon(request, Comun))).resolves.toBe(
      true,
    );
    expect(authService.decodeToken).not.toHaveBeenCalled();
    expect('distributorId' in request).toBe(false);
  });
});
