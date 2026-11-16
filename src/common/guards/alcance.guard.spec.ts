import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SoloLectura } from '../../audit/solo-lectura.decorator';
import { RoleType } from '../constants/role-type.enum';
import { Alcance } from '../decorators/alcance.decorator';
import { Auth } from '../decorators/auth.decorator';
import { Public } from '../decorators/isPublic.decorator';
import { RequiereAlcanceDeSoporte } from '../decorators/alcance-de-soporte.decorator';
import type { SesionDeSoporteEnCurso } from '../types/sesion-de-soporte';
import { AlcanceGuard } from './alcance.guard';

class DeEmpresa {
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  metodo(): void {}
}

class DeEmpresaSoloLectura {
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @SoloLectura()
  metodo(): void {}
}

class SinRoles {
  metodo(): void {}
}

class DePlataforma {
  @Auth(RoleType.SUPER_ADMIN)
  metodo(): void {}
}

@Alcance('ambos')
class DeAmbos {
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  metodo(): void {}
}

class DeLasApps {
  @Auth(RoleType.CUSTOMER)
  metodo(): void {}
}

@RequiereAlcanceDeSoporte('files')
class DeArchivos {
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  metodo(): void {}
}

class Publico {
  @Public()
  metodo(): void {}
}

type Controlador = new () => { metodo: () => void };

const SESION: SesionDeSoporteEnCurso = {
  id: '11111111-1111-4111-8111-111111111111',
  distributorId: 'empresa-a',
  scope: [],
  expiresAt: new Date('2099-01-01T00:00:00Z'),
};

function contexto(request: Request, Clase: Controlador): ExecutionContext {
  const instancia = new Clase();
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => instancia.metodo,
    getClass: () => Clase,
  } as unknown as ExecutionContext;
}

function pedido(
  role: RoleType,
  method: string,
  sesion?: SesionDeSoporteEnCurso,
): Request {
  return {
    method,
    path: '/x',
    user: { role, user_id: 'u1', email: 'u@splg.local' },
    supportSession: sesion,
  } as unknown as Request;
}

/** `true` si pasa; si no, el `code` del 403. */
function resultado(
  guard: AlcanceGuard,
  request: Request,
  Clase: Controlador,
): true | string {
  try {
    return guard.canActivate(contexto(request, Clase)) as true;
  } catch (error) {
    return (error as { response: { code: string } }).response.code;
  }
}

describe('AlcanceGuard', () => {
  const guard = new AlcanceGuard(new Reflector());
  const REQ = 'SUPPORT_SESSION_REQUIRED';
  const RO = 'SUPPORT_READ_ONLY';

  // [controlador, método, con sesión, esperado]
  const tabla: Array<[string, Controlador, string, boolean, true | string]> = [
    ['empresa', DeEmpresa, 'GET', false, REQ],
    ['empresa', DeEmpresa, 'POST', false, REQ],
    ['empresa', DeEmpresa, 'GET', true, true],
    ['empresa', DeEmpresa, 'HEAD', true, true],
    ['empresa', DeEmpresa, 'OPTIONS', true, true],
    ['empresa', DeEmpresa, 'POST', true, RO],
    ['empresa', DeEmpresa, 'PATCH', true, RO],
    ['empresa', DeEmpresa, 'PUT', true, RO],
    ['empresa', DeEmpresa, 'DELETE', true, RO],
    ['empresa (@SoloLectura)', DeEmpresaSoloLectura, 'POST', true, true],
    ['empresa (@SoloLectura)', DeEmpresaSoloLectura, 'POST', false, REQ],
    ['sin @Auth (por defecto empresa)', SinRoles, 'GET', false, REQ],
    ['sin @Auth (por defecto empresa)', SinRoles, 'GET', true, true],
    ['plataforma', DePlataforma, 'GET', false, true],
    ['plataforma', DePlataforma, 'DELETE', false, true],
    ['plataforma', DePlataforma, 'DELETE', true, true],
    ['ambos', DeAmbos, 'GET', false, true],
    ['ambos', DeAmbos, 'PATCH', false, true],
    ['ambos', DeAmbos, 'GET', true, true],
    ['ambos', DeAmbos, 'PATCH', true, RO],
    ['de las apps', DeLasApps, 'POST', false, true],
    ['público', Publico, 'POST', false, true],
  ];

  it.each(tabla)(
    'super admin · %s · %s · con sesión=%s → %s',
    (_n, Clase, method, conSesion, esperado) => {
      const request = pedido(
        RoleType.SUPER_ADMIN,
        method,
        conSesion ? SESION : undefined,
      );
      expect(resultado(guard, request, Clase)).toBe(esperado);
    },
  );

  it.each([RoleType.ADMIN, RoleType.CUSTOMER, RoleType.DELIVERY])(
    '%s nunca pasa por el modo soporte (ni escribiendo en una ruta de empresa)',
    (role) => {
      expect(resultado(guard, pedido(role, 'DELETE'), DeEmpresa)).toBe(true);
    },
  );

  describe('alcance de la sesión (archivos y exportes)', () => {
    const SCOPE = 'SUPPORT_SCOPE_REQUIRED';
    it.each([
      ['sesión sin files', [], SCOPE],
      ['sesión con otro alcance', ['personal_data', 'exports'], SCOPE],
      ['sesión con files', ['files'], true],
    ] as const)('%s → %s', (_n, scope, esperado) => {
      const request = pedido(RoleType.SUPER_ADMIN, 'GET', {
        ...SESION,
        scope: [...scope],
      });
      expect(resultado(guard, request, DeArchivos)).toBe(esperado);
    });

    it('sin sesión sigue siendo «entrá en modo soporte», no el alcance', () => {
      expect(
        resultado(guard, pedido(RoleType.SUPER_ADMIN, 'GET'), DeArchivos),
      ).toBe(REQ);
    });

    it('al admin de la empresa la marca no le cambia nada', () => {
      expect(resultado(guard, pedido(RoleType.ADMIN, 'GET'), DeArchivos)).toBe(
        true,
      );
    });
  });

  describe('empresa propia de la plataforma (rol efectivo ADMIN)', () => {
    const PROPIA = 'empresa-propia';
    /** La identidad ya transformada por `AuthGuard`, igual a un admin real. */
    const enPropia = (
      method: string,
      o: {
        tenant?: string | null;
      } = {},
    ): Request => {
      const tenant = o.tenant === undefined ? PROPIA : o.tenant;
      return {
        method,
        path: '/x',
        user: {
          role: RoleType.ADMIN,
          user_id: 'u1',
          email: 'u@splg.local',
          distributor_id: tenant,
          actuaComoEmpresaPropia: true,
          actor_real_role: RoleType.SUPER_ADMIN,
        },
        distributorId: tenant,
        ownedCompanyId: PROPIA,
      } as unknown as Request;
    };

    it.each([
      ['empresa', 'GET', DeEmpresa],
      ['empresa', 'POST', DeEmpresa],
      ['empresa', 'PATCH', DeEmpresa],
      ['empresa', 'PUT', DeEmpresa],
      ['empresa', 'DELETE', DeEmpresa],
      ['sin @Auth (por defecto empresa)', 'DELETE', SinRoles],
      ['ambos', 'PATCH', DeAmbos],
      ['archivos (sin alcance de sesión que pedir)', 'GET', DeArchivos],
    ] as const)('%s · %s → pasa (lectura y escritura)', (_n, m, Clase) => {
      expect(resultado(guard, enPropia(m), Clase)).toBe(true);
    });

    it('el guard no concede privilegios de plataforma: es el AuthGuard quien valida y transforma la identidad', () => {
      expect(
        resultado(guard, enPropia('POST', { tenant: 'otra' }), DeEmpresa),
      ).toBe(true);
    });
  });

  it('fuera de HTTP (sockets, crons) no hace nada', () => {
    const ctx = {
      getType: () => 'ws',
    } as unknown as ExecutionContext;
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('los rechazos van con su mensaje en castellano', () => {
    const sinSesion = (() => {
      try {
        guard.canActivate(
          contexto(pedido(RoleType.SUPER_ADMIN, 'GET'), DeEmpresa),
        );
        return null;
      } catch (error) {
        return (error as { response: { message: string; statusCode: number } })
          .response;
      }
    })();
    expect(sinSesion).toMatchObject({
      statusCode: 403,
      message: 'Para ver datos de una empresa entrá en modo soporte',
    });
  });
});
