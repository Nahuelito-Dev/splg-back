import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthGuard } from './jwt-auth.guard';
import { AuthService, MENSAJE_TOKEN_INVALIDO } from '../auth.service';
import { UsersService } from '../../users/users.service';
import { DistributorService } from '../../distributor/distributor.service';
import { RoleType } from '../../common/constants/role-type.enum';
import { User } from '../../users/entities/user.entity';
import {
  Public,
  PublicIdentificable,
} from '../../common/decorators/isPublic.decorator';
import { SinDistribuidora } from '../../common/decorators/sin-distribuidora.decorator';
import { Auth } from '../../common/decorators/auth.decorator';
import { soporteTerminado } from '../../common/errors/soporte';
import { SupportSessionResolver } from '../../support/application/support-session.resolver';

/** Un resolvedor de sesiones de soporte que falla si alguien lo llama. */
function soporteNoUsado(): SupportSessionResolver {
  return {
    vigente: jest.fn(() => {
      throw new Error('no debería consultar la sesión de soporte');
    }),
  } as unknown as SupportSessionResolver;
}

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
    getType: () => 'http',
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
  let distributorService: {
    findBySlug: jest.Mock;
    assertActive: jest.Mock;
    empresaPropiaVigente: jest.Mock;
  };
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
    distributorService = {
      findBySlug: jest.fn(),
      assertActive: jest.fn(),
      empresaPropiaVigente: jest.fn().mockResolvedValue(null),
    };
    guard = new AuthGuard(
      reflector,
      authService as unknown as AuthService,
      usersService as unknown as UsersService,
      distributorService as unknown as DistributorService,
      soporteNoUsado(),
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
    expect(distributorService.empresaPropiaVigente).not.toHaveBeenCalled();
  });

  it('super admin SIN la marca: el X-Distributor ya no se lee (modo soporte): queda null', async () => {
    loguearComo(superAdmin);
    distributorService.findBySlug.mockRejectedValue(new NotFoundException());
    const request = requestCon(headerConDistribuidoraInexistente);

    await expect(
      guard.canActivate(contextoCon(request, ControladorSinMarca)),
    ).resolves.toBe(true);
    expect(request.distributorId).toBeNull();
    expect(request.ownedCompanyId).toBeUndefined();
    expect(distributorService.findBySlug).not.toHaveBeenCalled();
    // Sólo se pregunta si es una empresa propia de la plataforma (no lo es).
    expect(distributorService.empresaPropiaVigente).toHaveBeenCalledWith(
      'distribuidora-que-no-existe',
    );
  });

  it('cliente SIN la marca: el mismo header inexistente sigue rompiendo la request', async () => {
    loguearComo({
      email: 'cliente@splg.com',
      blocked: false,
      role: { type: RoleType.CUSTOMER },
    } as unknown as User);
    distributorService.findBySlug.mockRejectedValue(new NotFoundException());
    const request = requestCon({
      ...headerConDistribuidoraInexistente,
      'x-client-source': 'customer-app',
    });

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
  let distributorService: {
    findBySlug: jest.Mock;
    assertActive: jest.Mock;
    empresaPropiaVigente: jest.Mock;
  };
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
    distributorService = {
      findBySlug: jest.fn(),
      assertActive: jest.fn(),
      empresaPropiaVigente: jest.fn().mockResolvedValue(null),
    };
    guard = new AuthGuard(
      reflector,
      authService as unknown as AuthService,
      usersService as unknown as UsersService,
      distributorService as unknown as DistributorService,
      soporteNoUsado(),
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

describe('AuthGuard — mensajes del 401', () => {
  const reflector = new Reflector();
  let authService: { decodeToken: jest.Mock };
  let usersService: { findOneByEmail: jest.Mock };
  let guard: AuthGuard;

  const cabeceras = {
    authorization: 'Bearer token',
    'x-client-source': 'panel-app',
  };

  beforeEach(() => {
    authService = { decodeToken: jest.fn() };
    usersService = { findOneByEmail: jest.fn() };
    guard = new AuthGuard(
      reflector,
      authService as unknown as AuthService,
      usersService as unknown as UsersService,
      {} as unknown as DistributorService,
      soporteNoUsado(),
    );
  });

  it('sin token: «Falta el token de acceso»', async () => {
    const request = requestCon({ 'x-client-source': 'panel-app' });

    await expect(guard.canActivate(contextoCon(request))).rejects.toThrow(
      new UnauthorizedException('Falta el token de acceso'),
    );
  });

  it('token sin correo: el mismo texto de token inválido que auth.service', async () => {
    authService.decodeToken.mockResolvedValue({});

    await expect(
      guard.canActivate(contextoCon(requestCon(cabeceras))),
    ).rejects.toThrow(new UnauthorizedException(MENSAJE_TOKEN_INVALIDO));
  });

  it('login de un usuario sin rol: «Tu usuario no tiene un rol asignado»', async () => {
    usersService.findOneByEmail.mockResolvedValue({
      email: 'x@splg.com',
      blocked: false,
    });
    const request = {
      headers: { 'x-client-source': 'panel-app' },
      method: 'POST',
      url: '/auth/login',
      body: { email: 'x@splg.com' },
    } as unknown as Request;

    await expect(guard.canActivate(contextoCon(request))).rejects.toThrow(
      new UnauthorizedException('Tu usuario no tiene un rol asignado'),
    );
  });

  it('token válido de un usuario sin rol: el 401 no da pistas de más', async () => {
    authService.decodeToken.mockResolvedValue({ email: 'x@splg.com' });
    usersService.findOneByEmail.mockResolvedValue({
      email: 'x@splg.com',
      blocked: false,
    });

    await expect(
      guard.canActivate(contextoCon(requestCon(cabeceras))),
    ).rejects.toThrow(
      'Usuario inexistente o sin un rol válido para esta aplicación',
    );
  });
});

@Auth(RoleType.SUPER_ADMIN)
class ControladorDePlataforma {
  metodo(): void {}
}

/**
 * Modo soporte: el super admin no lee `X-Distributor`; con `X-Support-Session`
 * en una ruta de empresa o de las dos, el tenant es el de la sesión.
 */
describe('AuthGuard — modo soporte del super admin', () => {
  const reflector = new Reflector();
  let authService: { decodeToken: jest.Mock };
  let usersService: { findOneByEmail: jest.Mock };
  let distributorService: {
    findBySlug: jest.Mock;
    assertActive: jest.Mock;
    empresaPropiaVigente: jest.Mock;
  };
  let soporte: { vigente: jest.Mock };
  let guard: AuthGuard;

  const superAdmin = {
    userId: 'super-1',
    email: 'super@splg.com',
    blocked: false,
    role: { type: RoleType.SUPER_ADMIN },
  } as unknown as User;
  const sesion = {
    id: '11111111-1111-4111-8111-111111111111',
    distributorId: 'empresa-de-la-sesion',
    scope: [],
    expiresAt: new Date('2026-11-13T20:00:00Z'),
  };
  const conSesion = {
    authorization: 'Bearer token-valido',
    'x-client-source': 'panel-app',
    'x-distributor': 'otra-empresa',
    'x-support-session': sesion.id,
  };

  beforeEach(() => {
    authService = { decodeToken: jest.fn() };
    usersService = { findOneByEmail: jest.fn() };
    distributorService = {
      findBySlug: jest.fn(),
      assertActive: jest.fn(),
      empresaPropiaVigente: jest.fn().mockResolvedValue(null),
    };
    soporte = { vigente: jest.fn().mockResolvedValue(sesion) };
    guard = new AuthGuard(
      reflector,
      authService as unknown as AuthService,
      usersService as unknown as UsersService,
      distributorService as unknown as DistributorService,
      soporte as unknown as SupportSessionResolver,
    );
  });

  function loguearComo(usuario: User): void {
    authService.decodeToken.mockResolvedValue({ email: usuario.email });
    usersService.findOneByEmail.mockResolvedValue(usuario);
  }

  it('ruta de empresa con sesión: el tenant es el de la sesión, no el del X-Distributor', async () => {
    loguearComo(superAdmin);
    const request = requestCon(conSesion);

    await expect(
      guard.canActivate(contextoCon(request, ControladorSinMarca)),
    ).resolves.toBe(true);

    expect(soporte.vigente).toHaveBeenCalledWith(sesion.id, 'super-1');
    expect(request.distributorId).toBe('empresa-de-la-sesion');
    expect(request.supportSession).toEqual(sesion);
    expect(request.user?.distributor_id).toBe('empresa-de-la-sesion');
    expect(request.user?.support_session_id).toBe(sesion.id);
    expect(distributorService.findBySlug).not.toHaveBeenCalled();
  });

  it('sin el encabezado de soporte: sin tenant ni sesión', async () => {
    loguearComo(superAdmin);
    const request = requestCon({
      authorization: 'Bearer token-valido',
      'x-client-source': 'panel-app',
      'x-distributor': 'otra-empresa',
    });

    await expect(
      guard.canActivate(contextoCon(request, ControladorSinMarca)),
    ).resolves.toBe(true);
    expect(request.distributorId).toBeNull();
    expect(request.supportSession).toBeUndefined();
    expect(request.user?.support_session_id).toBeNull();
    expect(soporte.vigente).not.toHaveBeenCalled();
  });

  it('ruta de plataforma: la sesión no se mira (tenant null)', async () => {
    loguearComo(superAdmin);
    const request = requestCon(conSesion);

    await expect(
      guard.canActivate(contextoCon(request, ControladorDePlataforma)),
    ).resolves.toBe(true);
    expect(soporte.vigente).not.toHaveBeenCalled();
    expect(request.distributorId).toBeNull();
    expect(request.supportSession).toBeUndefined();
  });

  it('ruta @SinDistribuidora: la sesión tampoco se mira', async () => {
    loguearComo(superAdmin);
    const request = requestCon(conSesion);

    await expect(
      guard.canActivate(contextoCon(request, ControladorMarcadoEnClase)),
    ).resolves.toBe(true);
    expect(soporte.vigente).not.toHaveBeenCalled();
    expect(request.distributorId).toBeNull();
  });

  it('una sesión terminada corta la request con el 403 del resolvedor', async () => {
    loguearComo(superAdmin);
    soporte.vigente.mockRejectedValue(soporteTerminado());
    const request = requestCon(conSesion);

    await expect(
      guard.canActivate(contextoCon(request, ControladorSinMarca)),
    ).rejects.toMatchObject({
      response: { statusCode: 403, code: 'SUPPORT_SESSION_ENDED' },
    });
    expect(request.supportSession).toBeUndefined();
  });

  it('un admin que manda X-Support-Session: se ignora, sigue en su distribuidora', async () => {
    loguearComo({
      userId: 'admin-1',
      email: 'admin@splg.com',
      blocked: false,
      role: { type: RoleType.ADMIN },
      admins: [{ distributorId: 'distribuidora-del-admin' }],
    } as unknown as User);
    const request = requestCon(conSesion);

    await expect(
      guard.canActivate(contextoCon(request, ControladorSinMarca)),
    ).resolves.toBe(true);
    expect(soporte.vigente).not.toHaveBeenCalled();
    expect(request.distributorId).toBe('distribuidora-del-admin');
    expect(request.supportSession).toBeUndefined();
  });
});

describe('AuthGuard — empresa propia de la plataforma', () => {
  const reflector = new Reflector();
  let authService: { decodeToken: jest.Mock };
  let usersService: { findOneByEmail: jest.Mock };
  let distributorService: {
    findBySlug: jest.Mock;
    assertActive: jest.Mock;
    empresaPropiaVigente: jest.Mock;
  };
  let soporte: { vigente: jest.Mock };
  let guard: AuthGuard;

  const superAdmin = {
    userId: 'super-1',
    email: 'super@splg.com',
    blocked: false,
    role: { type: RoleType.SUPER_ADMIN },
  } as unknown as User;
  const PROPIA = 'id-de-la-propia';
  const conHeader = (xDistributor: string, extra: object = {}) => ({
    authorization: 'Bearer token-valido',
    'x-client-source': 'panel-app',
    'x-distributor': xDistributor,
    ...extra,
  });

  beforeEach(() => {
    authService = { decodeToken: jest.fn() };
    usersService = { findOneByEmail: jest.fn() };
    distributorService = {
      findBySlug: jest.fn(),
      assertActive: jest.fn(),
      // Sólo `prueba-orixtech` es propia (vigente); el resto no.
      empresaPropiaVigente: jest.fn((ref: string) =>
        Promise.resolve(ref === 'prueba-orixtech' ? PROPIA : null),
      ),
    };
    soporte = {
      vigente: jest.fn().mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        distributorId: 'empresa-de-la-sesion',
        scope: [],
        expiresAt: new Date('2099-01-01T00:00:00Z'),
      }),
    };
    guard = new AuthGuard(
      reflector,
      authService as unknown as AuthService,
      usersService as unknown as UsersService,
      distributorService as unknown as DistributorService,
      soporte as unknown as SupportSessionResolver,
    );
  });

  function loguearComo(usuario: User): void {
    authService.decodeToken.mockResolvedValue({ email: usuario.email });
    usersService.findOneByEmail.mockResolvedValue(usuario);
  }

  it('el X-Distributor de una propia fija el tenant y marca la request', async () => {
    loguearComo(superAdmin);
    const request = requestCon(conHeader('prueba-orixtech'));

    await expect(
      guard.canActivate(contextoCon(request, ControladorSinMarca)),
    ).resolves.toBe(true);
    expect(request.distributorId).toBe(PROPIA);
    expect(request.ownedCompanyId).toBe(PROPIA);
    expect(request.supportSession).toBeUndefined();
    expect(request.user).toMatchObject({
      role: RoleType.ADMIN,
      distributor_id: PROPIA,
      actuaComoEmpresaPropia: true,
      actor_real_role: RoleType.SUPER_ADMIN,
      support_session_id: null,
    });
  });

  it('el X-Distributor de una empresa que no es propia no abre nada', async () => {
    loguearComo(superAdmin);
    const request = requestCon(conHeader('gas-andino'));

    await expect(
      guard.canActivate(contextoCon(request, ControladorSinMarca)),
    ).resolves.toBe(true);
    expect(request.distributorId).toBeNull();
    expect(request.ownedCompanyId).toBeUndefined();
    expect(request.user).toMatchObject({
      distributor_id: null,
      actuaComoEmpresaPropia: false,
    });
    // Ni siquiera se valida como lo haría un cliente.
    expect(distributorService.findBySlug).not.toHaveBeenCalled();
    expect(distributorService.assertActive).not.toHaveBeenCalled();
  });

  it('con X-Support-Session manda la sesión: el X-Distributor de la propia no se mira', async () => {
    loguearComo(superAdmin);
    const request = requestCon(
      conHeader('prueba-orixtech', {
        'x-support-session': '11111111-1111-4111-8111-111111111111',
      }),
    );

    await expect(
      guard.canActivate(contextoCon(request, ControladorSinMarca)),
    ).resolves.toBe(true);
    expect(request.distributorId).toBe('empresa-de-la-sesion');
    expect(request.ownedCompanyId).toBeUndefined();
    expect(request.user?.actuaComoEmpresaPropia).toBe(false);
    expect(distributorService.empresaPropiaVigente).not.toHaveBeenCalled();
  });

  it('una ruta de plataforma no mira el X-Distributor (tenant null)', async () => {
    loguearComo(superAdmin);
    const request = requestCon(conHeader('prueba-orixtech'));

    await expect(
      guard.canActivate(contextoCon(request, ControladorDePlataforma)),
    ).resolves.toBe(true);
    expect(request.distributorId).toBeNull();
    expect(request.ownedCompanyId).toBeUndefined();
    expect(distributorService.empresaPropiaVigente).not.toHaveBeenCalled();
  });

  it('una ruta @SinDistribuidora tampoco', async () => {
    loguearComo(superAdmin);
    const request = requestCon(conHeader('prueba-orixtech'));

    await expect(
      guard.canActivate(contextoCon(request, ControladorMarcadoEnClase)),
    ).resolves.toBe(true);
    expect(request.distributorId).toBeNull();
    expect(distributorService.empresaPropiaVigente).not.toHaveBeenCalled();
  });

  it('un admin de otra empresa con el X-Distributor de la propia sigue en la suya', async () => {
    loguearComo({
      userId: 'admin-1',
      email: 'admin@splg.com',
      blocked: false,
      role: { type: RoleType.ADMIN },
      admins: [{ distributorId: 'distribuidora-del-admin' }],
    } as unknown as User);
    const request = requestCon(conHeader('prueba-orixtech'));

    await expect(
      guard.canActivate(contextoCon(request, ControladorSinMarca)),
    ).resolves.toBe(true);
    expect(request.distributorId).toBe('distribuidora-del-admin');
    expect(request.ownedCompanyId).toBeUndefined();
    expect(distributorService.empresaPropiaVigente).not.toHaveBeenCalled();
  });

  it('un cliente con el X-Distributor de la propia la elige como cliente, sin marca', async () => {
    loguearComo({
      userId: 'cliente-1',
      email: 'cliente@splg.com',
      blocked: false,
      role: { type: RoleType.CUSTOMER },
    } as unknown as User);
    distributorService.findBySlug.mockResolvedValue({ distributorId: PROPIA });
    const request = requestCon({
      ...conHeader('prueba-orixtech'),
      'x-client-source': 'customer-app',
    });

    await expect(
      guard.canActivate(contextoCon(request, ControladorSinMarca)),
    ).resolves.toBe(true);
    expect(request.distributorId).toBe(PROPIA);
    expect(request.ownedCompanyId).toBeUndefined();
    expect(request.user?.actuaComoEmpresaPropia).toBe(false);
  });
});
