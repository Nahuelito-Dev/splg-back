import type { ApolloDriverConfig } from '@nestjs/apollo';
import { type INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
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
import { opcionesDeGraphql } from '../graphql/opciones-de-graphql';
import { SupportSessionResolver } from '../support/application/support-session.resolver';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { ReportsResolver } from './reports.resolver';
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
  'admin@b': {
    userId: 'u-admin-b',
    email: 'admin@b',
    blocked: false,
    role: { type: RoleType.ADMIN },
    admins: [{ distributorId: 'dist-b' }],
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

const RESUMEN = { totalSales: 1500.5, totalOrders: 3, averageTicket: 500.17 };
const POR_CHOFER = {
  rows: [
    { driverId: 'd1', driverName: 'Ana', totalOrders: 2, totalSales: 1000 },
    { driverId: 'd2', driverName: null, totalOrders: 1, totalSales: 500.5 },
  ],
  totals: { totalOrders: 3, totalSales: 1500.5 },
};

interface ErrorDeGraphql {
  message: string;
  extensions?: { code?: string; statusCode?: number; stacktrace?: unknown };
}
interface RespuestaGraphql {
  data?: Record<string, unknown> | null;
  errors?: ErrorDeGraphql[];
}

const reports = {
  getSalesSummary: jest.fn(),
  getSalesByDriverConTotales: jest.fn(),
  getSalesByProductConTotales: jest.fn(),
  getSalesByPaymentMethodConTotales: jest.fn(),
  getSalesEvolution: jest.fn(),
};
let permisos: string[];
const sesionesDeSoporte = { vigente: jest.fn() };

async function levantar(
  opciones: ApolloDriverConfig,
  limiteDePedidos = 1000,
): Promise<INestApplication<Server>> {
  const modulo = await Test.createTestingModule({
    imports: [
      GraphQLModule.forRoot<ApolloDriverConfig>(opciones),
      ThrottlerModule.forRoot({
        throttlers: [{ ttl: 60_000, limit: limiteDePedidos }],
      }),
    ],
    providers: [
      ReportsResolver,
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
  const app = modulo.createNestApplication<INestApplication<Server>>({
    logger: false,
  });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new GlobalExceptionFilter(app.getHttpAdapter()));
  app.useGlobalPipes(crearValidationPipe());
  await app.listen(0, '127.0.0.1');
  return app;
}

function consultar(
  app: INestApplication<Server>,
  query: string,
  {
    como,
    variables,
    headers = {},
  }: {
    como?: string;
    variables?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
) {
  const r = request(app.getHttpServer())
    .post('/api/graphql')
    .set('Content-Type', 'application/json');
  if (como) {
    const rol = CUENTAS[como]?.role?.type as RoleType;
    r.set('Authorization', `Bearer ${como}`).set(
      'X-Client-Source',
      ORIGEN[rol] ?? 'panel-app',
    );
  }
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  return r.send({ query, variables });
}

const cuerpo = (res: request.Response) => res.body as RespuestaGraphql;
const primerError = (res: request.Response) => {
  const error = cuerpo(res).errors?.[0];
  return [
    error?.extensions?.statusCode ?? null,
    error?.extensions?.code ?? null,
    error?.message ?? null,
  ];
};

const RESUMEN_Y_CHOFERES = `
  query ResumenYChoferes($from: String, $to: String) {
    salesSummary(from: $from, to: $to) {
      current { totalSales totalOrders averageTicket }
      previous { totalSales }
      currentRange { from to }
      previousRange { from to }
    }
    salesByDriver(from: $from, to: $to) {
      rows { driverId driverName totalOrders totalSales }
      totals { totalOrders totalSales }
    }
  }
`;

const SOLO_RESUMEN = `query { salesSummary { current { totalSales } } }`;

beforeEach(() => {
  jest.clearAllMocks();
  permisos = ['reportes.ver'];
  reports.getSalesSummary.mockResolvedValue(RESUMEN);
  reports.getSalesByDriverConTotales.mockResolvedValue(POR_CHOFER);
  reports.getSalesByProductConTotales.mockResolvedValue({
    rows: [
      {
        productType: '10kg',
        description: 'Garrafa 10 kg',
        totalQuantity: 4,
        totalSales: 800,
      },
    ],
    totals: { totalQuantity: 4, totalSales: 800 },
  });
  reports.getSalesByPaymentMethodConTotales.mockResolvedValue({
    rows: [{ method: 'cash', totalOrders: 2, totalSales: 700 }],
    totals: { totalOrders: 2, totalSales: 700 },
  });
  reports.getSalesEvolution.mockResolvedValue([
    {
      period: new Date('2026-10-05T03:00:00.000Z'),
      totalOrders: 2,
      totalSales: 700,
    },
  ]);
  sesionesDeSoporte.vigente.mockImplementation((id: string) => {
    if (id === 'sesion-b') {
      return Promise.resolve({
        id,
        distributorId: 'dist-b',
        scope: [],
        expiresAt: new Date(Date.now() + 60_000),
      });
    }
    return Promise.reject(soporteTerminado());
  });
});

describe('POST /api/graphql: informes de ventas (matriz)', () => {
  let app: INestApplication<Server>;

  beforeAll(async () => {
    app = await levantar(opcionesDeGraphql({ NODE_ENV: 'test' }));
  });

  afterAll(async () => {
    await app.close();
  });

  describe('200', () => {
    it('el admin con permiso pide el resumen y las ventas por chofer en una sola consulta, de SU distribuidora', async () => {
      const res = await consultar(app, RESUMEN_Y_CHOFERES, {
        como: 'admin@a',
        variables: { from: '2026-10-01', to: '2026-10-10' },
      });

      expect(res.status).toBe(200);
      expect(cuerpo(res)).toEqual({
        data: {
          salesSummary: {
            current: RESUMEN,
            previous: { totalSales: 1500.5 },
            currentRange: { from: '2026-10-01', to: '2026-10-10' },
            previousRange: { from: '2026-09-21', to: '2026-09-30' },
          },
          salesByDriver: POR_CHOFER,
        },
      });
      // Período actual y anterior: los días argentinos (UTC-3) en [desde, hasta).
      expect(reports.getSalesSummary).toHaveBeenNthCalledWith(
        1,
        new Date('2026-10-01T03:00:00.000Z'),
        new Date('2026-10-11T03:00:00.000Z'),
        'dist-a',
      );
      expect(reports.getSalesSummary).toHaveBeenNthCalledWith(
        2,
        new Date('2026-09-21T03:00:00.000Z'),
        new Date('2026-10-01T03:00:00.000Z'),
        'dist-a',
      );
      expect(reports.getSalesByDriverConTotales).toHaveBeenCalledWith(
        new Date('2026-10-01T03:00:00.000Z'),
        new Date('2026-10-11T03:00:00.000Z'),
        'dist-a',
      );
    });

    it('compare en false: no calcula el período anterior', async () => {
      const res = await consultar(
        app,
        `query { salesSummary(from: "2026-10-01", to: "2026-10-10", compare: false) {
          previous { totalSales } previousRange { from }
        } }`,
        { como: 'admin@a' },
      );

      expect(cuerpo(res).data).toEqual({
        salesSummary: { previous: null, previousRange: null },
      });
      expect(reports.getSalesSummary).toHaveBeenCalledTimes(1);
    });

    it('ventas por producto, por medio de pago y evolución semanal, con el mismo rango', async () => {
      const res = await consultar(
        app,
        `query {
          salesByProduct(from: "2026-10-01", to: "2026-10-31") {
            rows { productType description totalQuantity totalSales }
            totals { totalQuantity totalSales }
          }
          salesByPayment(from: "2026-10-01", to: "2026-10-31") {
            rows { method totalOrders totalSales } totals { totalSales }
          }
          salesEvolution(from: "2026-10-01", to: "2026-10-31", granularity: WEEK) {
            period totalOrders totalSales
          }
        }`,
        { como: 'admin@a' },
      );

      expect(cuerpo(res).errors).toBeUndefined();
      expect(cuerpo(res).data).toEqual({
        salesByProduct: {
          rows: [
            {
              productType: '10kg',
              description: 'Garrafa 10 kg',
              totalQuantity: 4,
              totalSales: 800,
            },
          ],
          totals: { totalQuantity: 4, totalSales: 800 },
        },
        salesByPayment: {
          rows: [{ method: 'cash', totalOrders: 2, totalSales: 700 }],
          totals: { totalSales: 700 },
        },
        salesEvolution: [
          {
            period: '2026-10-05T03:00:00.000Z',
            totalOrders: 2,
            totalSales: 700,
          },
        ],
      });
      const rango = [
        new Date('2026-10-01T03:00:00.000Z'),
        new Date('2026-11-01T03:00:00.000Z'),
      ];
      expect(reports.getSalesByProductConTotales).toHaveBeenCalledWith(
        ...rango,
        'dist-a',
      );
      expect(reports.getSalesByPaymentMethodConTotales).toHaveBeenCalledWith(
        ...rango,
        'dist-a',
      );
      expect(reports.getSalesEvolution).toHaveBeenCalledWith(
        ...rango,
        'week',
        'dist-a',
      );
    });

    it('la evolución sin agrupamiento va por día', async () => {
      await consultar(
        app,
        `query { salesEvolution(from: "2026-10-01") { totalSales } }`,
        { como: 'admin@a' },
      );
      expect(reports.getSalesEvolution).toHaveBeenCalledWith(
        new Date('2026-10-01T03:00:00.000Z'),
        new Date('2026-10-02T03:00:00.000Z'),
        'day',
        'dist-a',
      );
    });

    it('otra distribuidora: el admin de B ve lo de B y un X-Distributor ajeno no cambia nada', async () => {
      await consultar(app, SOLO_RESUMEN, {
        como: 'admin@b',
        headers: { 'X-Distributor': 'dist-a' },
      });
      expect(reports.getSalesSummary).toHaveBeenCalledWith(
        expect.any(Date),
        expect.any(Date),
        'dist-b',
      );
      expect(reports.getSalesSummary).not.toHaveBeenCalledWith(
        expect.any(Date),
        expect.any(Date),
        'dist-a',
      );
    });

    it('el super admin con sesión de soporte ve la empresa de la sesión (una query es lectura aunque viaje por POST)', async () => {
      const res = await consultar(app, SOLO_RESUMEN, {
        como: 'super@splg',
        headers: { 'X-Support-Session': 'sesion-b' },
      });
      expect(cuerpo(res).errors).toBeUndefined();
      expect(reports.getSalesSummary).toHaveBeenCalledWith(
        expect.any(Date),
        expect.any(Date),
        'dist-b',
      );
    });
  });

  describe('400', () => {
    it('fecha con formato inválido: el texto del DTO de la API REST', async () => {
      const res = await consultar(
        app,
        `query { salesByDriver(from: "01/10/2026") { totals { totalSales } } }`,
        { como: 'admin@a' },
      );
      expect(primerError(res)).toEqual([
        400,
        'BAD_REQUEST',
        'Desde: no es una fecha válida. Desde: debe ser una fecha en formato YYYY-MM-DD',
      ]);
      expect(cuerpo(res).data).toBeNull();
      expect(reports.getSalesByDriverConTotales).not.toHaveBeenCalled();
    });

    it('from posterior a to', async () => {
      const res = await consultar(
        app,
        `query { salesSummary(from: "2026-10-10", to: "2026-10-01") { current { totalSales } } }`,
        { como: 'admin@a' },
      );
      expect(primerError(res)).toEqual([
        400,
        'BAD_REQUEST',
        'from no puede ser posterior a to',
      ]);
      expect(reports.getSalesSummary).not.toHaveBeenCalled();
    });

    it('agrupamiento que no existe: lo rechaza el esquema antes de llegar al servicio', async () => {
      const res = await consultar(
        app,
        `query { salesEvolution(granularity: YEAR) { totalSales } }`,
        { como: 'admin@a' },
      );
      expect(cuerpo(res).errors?.[0]?.extensions?.code).toBe(
        'GRAPHQL_VALIDATION_FAILED',
      );
      expect(reports.getSalesEvolution).not.toHaveBeenCalled();
    });

    it('no hay mutaciones: la API es de sólo lectura', async () => {
      const res = await consultar(app, `mutation { salesSummary }`, {
        como: 'admin@a',
      });
      expect(res.status).toBe(400);
      expect(primerError(res)).toEqual([
        400,
        'OPERATION_NOT_ALLOWED',
        'La API GraphQL es de sólo lectura: sólo acepta consultas (query)',
      ]);
    });

    it('complejidad: repetir un informe con alias para multiplicar consultas se rechaza sin tocar la base', async () => {
      const alias = Array.from(
        { length: 10 },
        (_, i) => `r${i}: salesSummary { current { totalSales } }`,
      ).join('\n');
      const res = await consultar(app, `query { ${alias} }`, {
        como: 'admin@a',
      });
      expect(res.status).toBe(400);
      expect(primerError(res)).toEqual([
        400,
        'QUERY_TOO_COMPLEX',
        expect.stringContaining('La consulta es demasiado compleja'),
      ]);
      expect(reports.getSalesSummary).not.toHaveBeenCalled();
    });

    it('CSRF: un GET sin Content-Type JSON ni encabezado propio no se ejecuta', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/graphql')
        .query({ query: SOLO_RESUMEN })
        .set('Authorization', 'Bearer admin@a')
        .set('X-Client-Source', 'panel-app');
      expect(res.status).toBe(400);
      expect(reports.getSalesSummary).not.toHaveBeenCalled();
    });
  });

  describe('401', () => {
    it('sin token', async () => {
      const res = await consultar(app, SOLO_RESUMEN);
      expect(primerError(res)).toEqual([
        401,
        'UNAUTHORIZED',
        'Falta el encabezado X-Client-Source o no es válido',
      ]);
      expect(reports.getSalesSummary).not.toHaveBeenCalled();
    });

    it('con X-Client-Source pero sin token', async () => {
      const res = await consultar(app, SOLO_RESUMEN, {
        headers: { 'X-Client-Source': 'panel-app' },
      });
      expect(primerError(res)).toEqual([
        401,
        'UNAUTHORIZED',
        'Falta el token de acceso',
      ]);
    });
  });

  describe('403', () => {
    it.each(['chofer@a', 'cliente@a'])(
      'una cuenta de las apps (%s) no accede',
      async (como) => {
        const res = await consultar(app, SOLO_RESUMEN, { como });
        expect(primerError(res)).toEqual([
          403,
          'FORBIDDEN',
          expect.stringContaining('No tenés permiso para esta operación'),
        ]);
        expect(reports.getSalesSummary).not.toHaveBeenCalled();
      },
    );

    it('el admin cuyo rol de personal no tiene permiso de reportes', async () => {
      permisos = ['pedidos.ver'];
      const res = await consultar(app, SOLO_RESUMEN, { como: 'admin@a' });
      expect(primerError(res)).toEqual([
        403,
        'PERMISSION_DENIED',
        expect.stringContaining('No tenés permiso para'),
      ]);
      expect(reports.getSalesSummary).not.toHaveBeenCalled();
    });

    it('el super admin sin sesión de soporte no ve datos de una empresa', async () => {
      const res = await consultar(app, SOLO_RESUMEN, { como: 'super@splg' });
      expect(primerError(res)).toEqual([
        403,
        'SUPPORT_SESSION_REQUIRED',
        'Para ver datos de una empresa entrá en modo soporte',
      ]);
      expect(reports.getSalesSummary).not.toHaveBeenCalled();
    });

    it('el super admin con una sesión de soporte terminada', async () => {
      const res = await consultar(app, SOLO_RESUMEN, {
        como: 'super@splg',
        headers: { 'X-Support-Session': 'vencida' },
      });
      expect(primerError(res)).toEqual([
        403,
        'SUPPORT_SESSION_ENDED',
        'La sesión de soporte ya no está activa: volvé a pedir acceso',
      ]);
    });
  });

  describe('500', () => {
    it('una falla interna sale con el texto genérico, sin el detalle ni el stack', async () => {
      reports.getSalesSummary.mockRejectedValue(
        new Error('relation "orders" does not exist'),
      );
      const res = await consultar(app, SOLO_RESUMEN, { como: 'admin@a' });
      expect(primerError(res)).toEqual([
        500,
        'INTERNAL_SERVER_ERROR',
        'Error interno del servidor',
      ]);
      expect(JSON.stringify(res.body)).not.toContain('orders');
      expect(cuerpo(res).errors?.[0]?.extensions?.stacktrace).toBeUndefined();
    });
  });

  describe('explorador fuera de producción', () => {
    it('GraphiQL se sirve en el GET del navegador', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/graphql')
        .set('Accept', 'text/html');
      expect(res.status).toBe(200);
      expect(res.text.toLowerCase()).toContain('graphiql');
    });

    it('la introspección responde', async () => {
      const res = await consultar(
        app,
        `query { __schema { queryType { name } } }`,
      );
      expect(cuerpo(res).data).toEqual({
        __schema: { queryType: { name: 'Query' } },
      });
    });
  });
});

describe('POST /api/graphql con NODE_ENV=production', () => {
  let app: INestApplication<Server>;

  beforeAll(async () => {
    app = await levantar(opcionesDeGraphql({ NODE_ENV: 'production' }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('sin introspección', async () => {
    const res = await consultar(
      app,
      `query { __schema { queryType { name } } }`,
      { como: 'admin@a' },
    );
    expect(res.status).toBe(400);
    expect(cuerpo(res).errors?.[0]?.extensions?.code).toBe(
      'GRAPHQL_VALIDATION_FAILED',
    );
  });

  it('sin explorador: el GET del navegador no sirve GraphiQL', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/graphql')
      .set('Accept', 'text/html');
    expect(res.text.toLowerCase()).not.toContain('graphiql');
  });

  it('las consultas siguen andando', async () => {
    const res = await consultar(app, SOLO_RESUMEN, { como: 'admin@a' });
    expect(cuerpo(res).data).toEqual({
      salesSummary: { current: { totalSales: 1500.5 } },
    });
  });
});

describe('POST /api/graphql: límite de pedidos', () => {
  let app: INestApplication<Server>;

  beforeAll(async () => {
    app = await levantar(opcionesDeGraphql({ NODE_ENV: 'test' }), 2);
  });

  afterAll(async () => {
    await app.close();
  });

  it('429 cuando la sesión pasa el cupo, con el texto de la API REST', async () => {
    await consultar(app, SOLO_RESUMEN, { como: 'admin@a' });
    await consultar(app, SOLO_RESUMEN, { como: 'admin@a' });
    const res = await consultar(app, SOLO_RESUMEN, { como: 'admin@a' });
    expect(primerError(res)).toEqual([
      429,
      'TOO_MANY_REQUESTS',
      expect.any(String),
    ]);
    // Cada resumen consulta el período y el anterior: 2 pedidos, 4 llamadas.
    expect(reports.getSalesSummary).toHaveBeenCalledTimes(4);
  });
});
