import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  VERSION_NEUTRAL,
  VersioningType,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { Server } from 'http';
import request from 'supertest';
import { PermissionGuard } from '../../admin/guards/permission.guard';
import { StaffPermissionsService } from '../../admin/staff-permissions.service';
import { RoleType } from '../../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { GlobalExceptionFilter } from '../../common/filters/global-exception.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { crearValidationPipe } from '../../common/validation/validation-pipe';
import { AccesoDeLaEmpresa } from '../../platform/access/acceso-de-la-empresa.service';
import { ModuloGuard } from '../../platform/access/modulo.guard';
import {
  cupoDeRecorridosAgotado,
  proveedorDeRutasCaido,
  sinProveedorDeRutas,
} from '../../routes/route-path.service';
import { RouteSheetCloseService } from '../application/route-sheet-close.service';
import { RouteSheetEditingService } from '../application/route-sheet-editing.service';
import { RouteSheetExecutionQueryService } from '../application/route-sheet-execution-query.service';
import { RouteSheetInProgressEditingService } from '../application/route-sheet-in-progress-editing.service';
import { RouteSheetLifecycleService } from '../application/route-sheet-lifecycle.service';
import { RouteSheetPathService } from '../application/route-sheet-path.service';
import { RouteSheetPdfService } from '../application/route-sheet-pdf.service';
import { RouteSheetQueryService } from '../application/route-sheet-query.service';
import { RouteSheetStartService } from '../application/route-sheet-start.service';
import { RouteSheetStopsService } from '../application/route-sheet-stops.service';
import { hojaNoEncontrada } from '../application/route-sheet.exceptions';
import { RouteSheetsController } from './route-sheets.controller';

const ID = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';
const DIST = 'dist-a';

/** Lo que hace el `AuthGuard` real: sin token, 401; con token, el usuario del rol pedido. */
class AuthDePrueba implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.headers.authorization) {
      throw new UnauthorizedException('Sin token o token inválido');
    }
    const rol = req.headers['x-rol'] as RoleType;
    req.user = { user_id: 'u1', role: rol } as AuthenticatedUser;
    req.distributorId =
      rol === RoleType.SUPER_ADMIN
        ? ((req.headers['x-distributor'] as string | undefined) ?? null)
        : DIST;
    return true;
  }
}

/**
 * Matriz HTTP de `GET /v2/route-sheets/:id/path`: con los guards reales de
 * rol, permiso y módulo, el pipe de validación y el filtro global. El servicio
 * se simula (su regla se prueba en `route-sheet-path.service.spec.ts`); acá,
 * que cada caso llegue con su código HTTP y su `code`.
 */
describe('GET /v2/route-sheets/:id/path: matriz HTTP', () => {
  let app: INestApplication<Server>;
  let permisos: string[];
  let hojaDeRutaEncendida: boolean;
  const paths = { recorrido: jest.fn() };
  const vacio = {} as never;

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [RouteSheetsController],
      providers: [
        { provide: RouteSheetEditingService, useValue: vacio },
        { provide: RouteSheetLifecycleService, useValue: vacio },
        { provide: RouteSheetQueryService, useValue: vacio },
        { provide: RouteSheetPdfService, useValue: vacio },
        { provide: RouteSheetStartService, useValue: vacio },
        { provide: RouteSheetStopsService, useValue: vacio },
        { provide: RouteSheetCloseService, useValue: vacio },
        { provide: RouteSheetInProgressEditingService, useValue: vacio },
        { provide: RouteSheetExecutionQueryService, useValue: vacio },
        { provide: RouteSheetPathService, useValue: paths },
        {
          provide: StaffPermissionsService,
          useValue: {
            deUsuario: jest.fn(() =>
              Promise.resolve({ todos: false, rol: null, permisos }),
            ),
          },
        },
        {
          provide: AccesoDeLaEmpresa,
          useValue: {
            habilitado: jest.fn((_d: string, m: string) =>
              Promise.resolve(m !== 'route_planning' || hojaDeRutaEncendida),
            ),
          },
        },
        Reflector,
        { provide: APP_GUARD, useClass: AuthDePrueba },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: APP_GUARD, useClass: ModuloGuard },
      ],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: [VERSION_NEUTRAL, '1'],
    });
    app.useGlobalFilters(new GlobalExceptionFilter(app.getHttpAdapter()));
    app.useGlobalPipes(crearValidationPipe());
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    permisos = ['despacho.gestionar'];
    hojaDeRutaEncendida = true;
    paths.recorrido.mockResolvedValue({ sheetId: ID, provider: 'google' });
  });

  const llamar = (
    id: string,
    rol: RoleType | null,
    extra: Record<string, string> = {},
  ) => {
    const r = request(app.getHttpServer()).get(
      `/api/v2/route-sheets/${id}/path`,
    );
    if (rol) r.set('Authorization', 'Bearer x').set('x-rol', rol);
    for (const [k, v] of Object.entries(extra)) r.set(k, v);
    return r;
  };
  const resultado = async (r: request.Test) => {
    const res = await r;
    return [res.status, (res.body as { code?: string }).code ?? null];
  };

  it('200: el admin con permiso de despacho recibe el recorrido de su distribuidora', async () => {
    const res = await llamar(ID, RoleType.ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sheetId: ID, provider: 'google' });
    expect(paths.recorrido).toHaveBeenCalledWith(DIST, ID);
  });

  it('200: el super admin con X-Distributor (la del header, nunca otra)', async () => {
    expect(
      await resultado(
        llamar(ID, RoleType.SUPER_ADMIN, { 'x-distributor': 'dist-b' }),
      ),
    ).toEqual([200, null]);
    expect(paths.recorrido).toHaveBeenCalledWith('dist-b', ID);
  });

  it('400: id que no es UUID, o super admin sin distribuidora', async () => {
    expect(await resultado(llamar('no-es-uuid', RoleType.ADMIN))).toEqual([
      400,
      'INVALID_ID',
    ]);
    expect(await resultado(llamar(ID, RoleType.SUPER_ADMIN))).toEqual([
      400,
      'MISSING_DISTRIBUTOR',
    ]);
    expect(paths.recorrido).not.toHaveBeenCalled();
  });

  it('401: sin token', async () => {
    expect(await resultado(llamar(ID, null))).toEqual([401, null]);
    expect(paths.recorrido).not.toHaveBeenCalled();
  });

  it('403: rol de app, admin sin permiso de despacho, hoja de ruta apagada', async () => {
    expect(await resultado(llamar(ID, RoleType.DELIVERY))).toEqual([403, null]);
    expect(await resultado(llamar(ID, RoleType.CUSTOMER))).toEqual([403, null]);
    permisos = ['pedidos.ver'];
    expect(await resultado(llamar(ID, RoleType.ADMIN))).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
    permisos = ['despacho.gestionar'];
    hojaDeRutaEncendida = false;
    const res = await llamar(ID, RoleType.ADMIN);
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('MODULE_DISABLED');
    // Hacia la empresa no se habla de «módulo» ni de «plan».
    expect((res.body as { message: string }).message).not.toMatch(
      /m[oó]dulo|plan\b/i,
    );
    expect(paths.recorrido).not.toHaveBeenCalled();
  });

  it('404: hoja de otra distribuidora o inexistente', async () => {
    paths.recorrido.mockRejectedValue(hojaNoEncontrada());
    expect(await resultado(llamar(ID, RoleType.ADMIN))).toEqual([
      404,
      'ROUTE_SHEET_NOT_FOUND',
    ]);
  });

  it('429: cupo diario de recorridos agotado, con mensaje en castellano', async () => {
    paths.recorrido.mockRejectedValue(cupoDeRecorridosAgotado());
    const res = await llamar(ID, RoleType.ADMIN);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      code: 'ROUTE_PATH_DAILY_LIMIT',
      message:
        'La distribuidora llegó al máximo de recorridos por día: probá mañana',
    });
  });

  it('502 si ningún proveedor responde; 503 sin proveedor configurado', async () => {
    paths.recorrido.mockRejectedValueOnce(proveedorDeRutasCaido());
    expect(await resultado(llamar(ID, RoleType.ADMIN))).toEqual([
      502,
      'ROUTE_PROVIDER_FAILED',
    ]);
    paths.recorrido.mockRejectedValueOnce(sinProveedorDeRutas());
    expect(await resultado(llamar(ID, RoleType.ADMIN))).toEqual([
      503,
      'ROUTE_PROVIDER_UNAVAILABLE',
    ]);
  });
});
