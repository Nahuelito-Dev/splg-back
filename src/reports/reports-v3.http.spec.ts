import { NotFoundException, type INestApplication } from '@nestjs/common';
import { VersioningType, VERSION_NEUTRAL } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Server } from 'http';
import request from 'supertest';
import { PermissionGuard } from '../admin/guards/permission.guard';
import { StaffPermissionsService } from '../admin/staff-permissions.service';
import { AuthService } from '../auth/auth.service';
import { AuthGuard } from '../auth/guards/jwt-auth.guard';
import { RoleType } from '../common/constants/role-type.enum';
import { soporteTerminado } from '../common/errors/soporte';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter';
import { AlcanceGuard } from '../common/guards/alcance.guard';
import { AppThrottlerGuard } from '../common/guards/app-throttler.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { crearValidationPipe } from '../common/validation/validation-pipe';
import { DistributorService } from '../distributor/distributor.service';
import { SupportSessionResolver } from '../support/application/support-session.resolver';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { ReportsV3Controller } from './reports-v3.controller';
import { ReportsService } from './reports.service';

/** Las cuentas del token de prueba (el token ES el email). */
const CUENTAS: Record<string, User> = {
  'admin@a': {
    userId: 'u-admin-a',
    email: 'admin@a',
    blocked: false,
    role: { type: RoleType.ADMIN },
    admins: [{ distributorId: 'dist-a' }],
  } as unknown as User,
  'chofer@a': {
    userId: 'u-chofer',
    email: 'chofer@a',
    blocked: false,
    role: { type: RoleType.DELIVERY },
    delivery: { distributorId: 'dist-a' },
  } as unknown as User,
  'cliente@a': {
    userId: 'u-cliente',
    email: 'cliente@a',
    blocked: false,
    role: { type: RoleType.CUSTOMER },
  } as unknown as User,
  'super@splg': {
    userId: 'u-super',
    email: 'super@splg',
    blocked: false,
    role: { type: RoleType.SUPER_ADMIN },
  } as unknown as User,
};

const ORIGEN: Partial<Record<RoleType, string>> = {
  [RoleType.DELIVERY]: 'driver-app',
  [RoleType.CUSTOMER]: 'customer-app',
};

const UUID = '3f0c3b4e-6a1d-4c55-9c0e-0d3c6a9d2b11';
const RUTA = '/api/v3/reports/vehicle-utilization';
const INFORME = {
  rows: [{ vehicleId: UUID, plate: 'AA123BB', deliveries: 3 }],
  totals: { vehicles: 1, deliveries: 3 },
};

const reports = { getVehicleUtilization: jest.fn() };
const sesionesDeSoporte = { vigente: jest.fn() };
let permisos: string[];

interface Cuerpo {
  message?: string | string[];
  code?: string;
  statusCode?: number;
}
const cuerpo = (res: request.Response) => res.body as Cuerpo;

let app: INestApplication<Server>;

function pedir(
  query: Record<string, string>,
  {
    como,
    headers = {},
  }: { como?: string; headers?: Record<string, string> } = {},
) {
  const r = request(app.getHttpServer()).get(RUTA).query(query);
  if (como) {
    const rol = CUENTAS[como]?.role?.type as RoleType;
    r.set('Authorization', `Bearer ${como}`).set(
      'X-Client-Source',
      ORIGEN[rol] ?? 'panel-app',
    );
  }
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  return r;
}

beforeAll(async () => {
  const modulo = await Test.createTestingModule({
    imports: [
      ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 1000 }] }),
    ],
    controllers: [ReportsV3Controller],
    providers: [
      { provide: ReportsService, useValue: reports },
      {
        provide: AuthService,
        useValue: {
          decodeToken: jest.fn((token: string) =>
            Promise.resolve({ email: token }),
          ),
        },
      },
      {
        provide: UsersService,
        useValue: {
          findOneByEmail: jest.fn((email: string) => {
            const cuenta = CUENTAS[email];
            return cuenta
              ? Promise.resolve(cuenta)
              : Promise.reject(new Error('no existe'));
          }),
        },
      },
      {
        provide: DistributorService,
        useValue: { empresaPropiaVigente: jest.fn(() => null) },
      },
      { provide: SupportSessionResolver, useValue: sesionesDeSoporte },
      {
        provide: StaffPermissionsService,
        useValue: {
          deUsuario: jest.fn(() =>
            Promise.resolve({ todos: false, rol: null, permisos }),
          ),
        },
      },
      Reflector,
      // Los mismos guards globales y en el mismo orden que `AppModule`.
      { provide: APP_GUARD, useClass: AppThrottlerGuard },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_GUARD, useClass: RolesGuard },
      { provide: APP_GUARD, useClass: PermissionGuard },
      { provide: APP_GUARD, useClass: AlcanceGuard },
    ],
  }).compile();
  app = modulo.createNestApplication<INestApplication<Server>>({
    logger: false,
  });
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
  permisos = ['flota.ver'];
  reports.getVehicleUtilization.mockResolvedValue(INFORME);
  sesionesDeSoporte.vigente.mockImplementation((id: string) =>
    id === 'sesion-b'
      ? Promise.resolve({
          id,
          distributorId: 'dist-b',
          scope: [],
          expiresAt: new Date(Date.now() + 60_000),
        })
      : Promise.reject(soporteTerminado()),
  );
});

describe('GET /api/v3/reports/vehicle-utilization (matriz)', () => {
  describe('200', () => {
    it('el admin con permiso recibe el informe de SU distribuidora, con el rango en días argentinos', async () => {
      const res = await pedir(
        { from: '2026-10-01', to: '2026-10-31', vehicleId: UUID },
        { como: 'admin@a', headers: { 'X-Distributor': 'dist-b' } },
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual(INFORME);
      expect(reports.getVehicleUtilization).toHaveBeenCalledWith(
        {
          from: '2026-10-01',
          to: '2026-10-31',
          startDate: new Date('2026-10-01T03:00:00.000Z'),
          endDate: new Date('2026-11-01T03:00:00.000Z'),
        },
        'dist-a',
        UUID,
      );
    });

    it('el super admin con sesión de soporte ve la empresa de la sesión', async () => {
      const res = await pedir(
        { from: '2026-10-01', to: '2026-10-02' },
        { como: 'super@splg', headers: { 'X-Support-Session': 'sesion-b' } },
      );
      expect(res.status).toBe(200);
      expect(reports.getVehicleUtilization).toHaveBeenCalledWith(
        expect.objectContaining({ from: '2026-10-01' }),
        'dist-b',
        undefined,
      );
    });
  });

  describe('400', () => {
    it('vehicleId que no es uuid', async () => {
      const res = await pedir({ vehicleId: 'no-es-uuid' }, { como: 'admin@a' });
      expect(res.status).toBe(400);
      expect(cuerpo(res).message).toEqual(['Vehículo: no es válido']);
      expect(reports.getVehicleUtilization).not.toHaveBeenCalled();
    });

    it('fecha mal formada', async () => {
      const res = await pedir({ from: '01/10/2026' }, { como: 'admin@a' });
      expect(res.status).toBe(400);
      expect(cuerpo(res).message).toContain(
        'Desde: debe ser una fecha en formato YYYY-MM-DD',
      );
      expect(reports.getVehicleUtilization).not.toHaveBeenCalled();
    });

    it('rango mayor al máximo: code estable y mensaje en castellano', async () => {
      const res = await pedir(
        { from: '2020-01-01', to: '2025-01-05' },
        { como: 'admin@a' },
      );
      expect(res.status).toBe(400);
      expect(cuerpo(res).code).toBe('DATE_RANGE_TOO_LARGE');
      expect(cuerpo(res).message).toBe('El rango no puede superar 1830 días');
      expect(reports.getVehicleUtilization).not.toHaveBeenCalled();
    });

    it('from posterior a to', async () => {
      const res = await pedir(
        { from: '2026-10-10', to: '2026-10-01' },
        { como: 'admin@a' },
      );
      expect(res.status).toBe(400);
      expect(cuerpo(res).message).toBe('from no puede ser posterior a to');
    });
  });

  describe('401', () => {
    it('sin token', async () => {
      const res = await pedir({});
      expect(res.status).toBe(401);
      expect(reports.getVehicleUtilization).not.toHaveBeenCalled();
    });
  });

  describe('403', () => {
    it('el super admin sin sesión de soporte no ve datos de una empresa (REST no pide X-Distributor: exige modo soporte)', async () => {
      const res = await pedir({}, { como: 'super@splg' });
      expect(res.status).toBe(403);
      expect(cuerpo(res).code).toBe('SUPPORT_SESSION_REQUIRED');
      expect(reports.getVehicleUtilization).not.toHaveBeenCalled();
    });

    it.each(['chofer@a', 'cliente@a'])(
      'una cuenta de las apps (%s) no accede',
      async (como) => {
        const res = await pedir({}, { como });
        expect(res.status).toBe(403);
        expect(reports.getVehicleUtilization).not.toHaveBeenCalled();
      },
    );

    it('el admin cuyo rol de personal no tiene flota.ver (los costos son de flota)', async () => {
      permisos = ['reportes.ver'];
      const res = await pedir({}, { como: 'admin@a' });
      expect(res.status).toBe(403);
      expect(cuerpo(res).code).toBe('PERMISSION_DENIED');
      expect(reports.getVehicleUtilization).not.toHaveBeenCalled();
    });
  });

  describe('404', () => {
    it('vehículo de otra distribuidora: el servicio lo busca en la del token', async () => {
      reports.getVehicleUtilization.mockImplementation(
        (_rango: unknown, distribuidora: string) =>
          distribuidora === 'dist-a'
            ? Promise.reject(new NotFoundException('Vehículo no encontrado'))
            : Promise.resolve(INFORME),
      );
      const res = await pedir({ vehicleId: UUID }, { como: 'admin@a' });
      expect(res.status).toBe(404);
      expect(cuerpo(res).message).toBe('Vehículo no encontrado');
      expect(reports.getVehicleUtilization).toHaveBeenCalledWith(
        expect.anything(),
        'dist-a',
        UUID,
      );
    });
  });
});
