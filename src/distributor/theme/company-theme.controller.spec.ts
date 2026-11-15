import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, Logger, RequestMethod } from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
  VERSION_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SOLO_LECTURA_KEY } from '../../audit/solo-lectura.decorator';
import { RoleType } from '../../common/constants/role-type.enum';
import { PERMISO_KEY } from '../../common/decorators/permiso.decorator';
import { AlcanceGuard } from '../../common/guards/alcance.guard';
import type { SesionDeSoporteEnCurso } from '../../common/types/sesion-de-soporte';
import { CompanyThemeController } from './company-theme.controller';
import type { DistributorThemeService } from './distributor-theme.service';

type Metodo = 'obtener' | 'vistaPrevia' | 'guardar' | 'restablecer';
const METODOS: Metodo[] = ['obtener', 'vistaPrevia', 'guardar', 'restablecer'];

const handler = (m: Metodo) =>
  CompanyThemeController.prototype[m] as unknown as object;

const SESION: SesionDeSoporteEnCurso = {
  id: '11111111-1111-4111-8111-111111111111',
  distributorId: 'empresa-a',
  scope: [],
  expiresAt: new Date('2099-01-01T00:00:00Z'),
};

function intentar(m: Metodo, request: Partial<Request>): unknown {
  const verbo = Reflect.getMetadata(METHOD_METADATA, handler(m)) as number;
  const ctx = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ ...request, method: RequestMethod[verbo] }),
    }),
    getHandler: () => handler(m),
    getClass: () => CompanyThemeController,
  } as unknown as ExecutionContext;
  try {
    return new AlcanceGuard(new Reflector()).canActivate(ctx);
  } catch (e) {
    return (e as ForbiddenException).getResponse();
  }
}

describe('CompanyThemeController', () => {
  const temas = {
    vigente: jest.fn().mockResolvedValue({ version: 1 }),
    vistaPrevia: jest.fn().mockResolvedValue({ version: 0 }),
    guardar: jest.fn().mockResolvedValue({ version: 2 }),
    restablecer: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new CompanyThemeController(
    temas as unknown as DistributorThemeService,
  );

  it('opera siempre sobre la distribuidora del contexto, con el usuario que lo pide', async () => {
    await expect(controller.obtener('d1')).resolves.toEqual({ version: 1 });
    expect(temas.vigente).toHaveBeenCalledWith('d1');
    const cuerpo = { primaryColor: '#1D4ED8' };
    await controller.vistaPrevia(cuerpo, 'd1');
    expect(temas.vistaPrevia).toHaveBeenCalledWith('d1', cuerpo);
    await controller.guardar(cuerpo, 'd1', 'u1');
    expect(temas.guardar).toHaveBeenCalledWith('d1', cuerpo, 'u1');
    await controller.restablecer('d1', 'u1');
    expect(temas.restablecer).toHaveBeenCalledWith('d1', 'u1');
  });

  it('vive en /v2/company/theme y ningún endpoint acepta un id de distribuidora', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CompanyThemeController)).toBe(
      'company/theme',
    );
    expect(Reflect.getMetadata(VERSION_METADATA, CompanyThemeController)).toBe(
      '2',
    );
    for (const m of METODOS) {
      const args = (Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        CompanyThemeController,
        m,
      ) ?? {}) as Record<string, unknown>;
      const tipos = Object.keys(args).map((k) => Number(k.split(':')[0]));
      expect(tipos).not.toContain(RouteParamtypes.PARAM);
      expect(tipos).not.toContain(RouteParamtypes.QUERY);
    }
  });

  it('permisos: leer lo puede cualquier admin; la vista previa pide ver la configuración; cambiar y restablecer, gestionarla', () => {
    const permisos = (m: Metodo) =>
      Reflect.getMetadata(PERMISO_KEY, handler(m)) as string[] | undefined;
    expect(permisos('obtener')).toBeUndefined();
    expect(permisos('vistaPrevia')).toEqual(['configuracion.ver']);
    expect(permisos('guardar')).toEqual(['configuracion.gestionar']);
    expect(permisos('restablecer')).toEqual(['configuracion.gestionar']);
    expect(Reflect.getMetadata(SOLO_LECTURA_KEY, handler('vistaPrevia'))).toBe(
      true,
    );
  });

  describe('modo soporte del super admin', () => {
    beforeAll(() => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterAll(() => jest.restoreAllMocks());

    const superAdmin = {
      user: { role: RoleType.SUPER_ADMIN, user_id: 's1' },
    } as unknown as Partial<Request>;

    it('sin sesión de soporte: 403 SUPPORT_SESSION_REQUIRED', () => {
      for (const m of METODOS) {
        expect(intentar(m, superAdmin)).toMatchObject({
          code: 'SUPPORT_SESSION_REQUIRED',
        });
      }
    });

    it('con sesión: lee y previsualiza; no cambia ni restablece (SUPPORT_READ_ONLY)', () => {
      const conSesion = { ...superAdmin, supportSession: SESION };
      expect(intentar('obtener', conSesion)).toBe(true);
      expect(intentar('vistaPrevia', conSesion)).toBe(true);
      expect(intentar('guardar', conSesion)).toMatchObject({
        code: 'SUPPORT_READ_ONLY',
      });
      expect(intentar('restablecer', conSesion)).toMatchObject({
        code: 'SUPPORT_READ_ONLY',
      });
    });

    it('un admin (o el super admin en su empresa propia, que entra como admin) no pasa por el modo soporte', () => {
      const admin = {
        user: { role: RoleType.ADMIN, user_id: 'a1' },
      } as unknown as Partial<Request>;
      for (const m of METODOS) expect(intentar(m, admin)).toBe(true);
    });
  });
});
