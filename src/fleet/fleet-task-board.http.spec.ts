import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  INestApplication,
  NotFoundException,
  UnauthorizedException,
  VERSION_NEUTRAL,
  VersioningType,
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
import { RolesGuard } from '../common/guards/roles.guard';
import { crearValidationPipe } from '../common/validation/validation-pipe';
import { MaintenanceTaskStatus } from './entities/maintenance-task.entity';
import {
  movimientoRechazado,
  tareaCerrada,
  vecinaInvalida,
  assertSinCambiosAjenos,
} from './fleet-task-board.errors';
import { FleetTaskBoardService } from './fleet-task-board.service';
import { FleetTaskV2Controller } from './fleet-task-v2.controller';
import { FleetTaskService } from './fleet-task.service';

const ID = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';
const OTRO = '6b1e2a40-9c3d-4e5f-8a7b-1c2d3e4f5a6b';
const PLAN = '0d6f0c34-8b7e-4c1a-9f3b-5a2e7d9c1b20';
const ACTUALIZADA = '2026-11-17T12:00:00.123Z';

/** Lo que hace el `AuthGuard` real: sin token, 401; con token, el usuario del rol pedido. */
class AuthDePrueba implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.headers.authorization) {
      throw new UnauthorizedException('Sin token o token inválido');
    }
    const rol = req.headers['x-rol'] as RoleType;
    req.user = { user_id: 'u1', role: rol } as AuthenticatedUser;
    req.distributorId = 'dist-a';
    return true;
  }
}

/** La tarea como la devuelve el servicio (lo que necesita el mapper v2). */
const tarea = () => ({
  taskId: ID,
  planId: PLAN,
  plan: undefined,
  distributorId: 'dist-a',
  carId: null,
  deliveryId: null,
  employeeId: null,
  assigneeEmployeeId: OTRO,
  status: MaintenanceTaskStatus.SCHEDULED,
  validFrom: null,
  dueAt: null,
  dueKm: null,
  scheduledAt: null,
  performedAt: null,
  odometerKm: null,
  cost: null,
  provider: null,
  referenceNumber: null,
  category: null,
  notes: null,
  details: null,
  cashMovementId: null,
  paidAt: null,
  paidAmount: null,
  updatedAt: new Date(ACTUALIZADA),
});

/**
 * Matriz HTTP del tablero de flota (v2): cada endpoint con 2xx, 400 por
 * validación, 401, 403 (rol y permiso `flota.ver` / `flota.gestionar`), 404 y
 * 409 con su `code`, con los guards reales de rol y permiso, el pipe de
 * validación y el filtro global. Los servicios se simulan: sus reglas se
 * prueban en sus propios tests.
 */
describe('Tablero de flota: matriz HTTP (v2)', () => {
  let app: INestApplication<Server>;
  let permisos: string[];
  const tasks = { create: jest.fn(), update: jest.fn(), findAll: jest.fn() };
  const board = { tablero: jest.fn(), mover: jest.fn() };

  beforeAll(async () => {
    const staff = {
      deUsuario: jest.fn(() =>
        Promise.resolve({ todos: false, rol: null, permisos }),
      ),
    };
    const modulo = await Test.createTestingModule({
      controllers: [FleetTaskV2Controller],
      providers: [
        { provide: FleetTaskService, useValue: tasks },
        { provide: FleetTaskBoardService, useValue: board },
        { provide: StaffPermissionsService, useValue: staff },
        Reflector,
        { provide: APP_GUARD, useClass: AuthDePrueba },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
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
    permisos = ['flota.ver', 'flota.gestionar'];
    board.tablero.mockResolvedValue({
      columns: { forecast: [], scheduled: [], in_progress: [], done: [] },
      cancelledCount: 0,
    });
    board.mover.mockResolvedValue({ id: ID, column: 'in_progress' });
    tasks.create.mockResolvedValue(tarea());
    tasks.update.mockResolvedValue(tarea());
  });

  type Metodo = 'get' | 'post' | 'patch';
  const llamar = (
    metodo: Metodo,
    ruta: string,
    rol: RoleType | null = RoleType.ADMIN,
    body?: object,
    cabeceras: Record<string, string> = {},
  ) => {
    const r = request(app.getHttpServer())[metodo](`/api/v2${ruta}`);
    if (rol) r.set('Authorization', 'Bearer x').set('x-rol', rol);
    for (const [k, v] of Object.entries(cabeceras)) r.set(k, v);
    return body ? r.send(body) : r;
  };
  const resultado = async (r: request.Test) => {
    const res = await r;
    return [res.status, (res.body as { code?: string }).code ?? null];
  };

  describe('GET /fleet/tasks/board', () => {
    it('200 con los filtros tipados, acotado a la empresa', async () => {
      const res = await llamar(
        'get',
        `/fleet/tasks/board?carId=${ID}&category=vtv&employeeId=${OTRO}&dueBefore=2026-12-31&q=%20AB1%20&doneSince=2026-10-01T00:00:00.000Z`,
      );
      expect(res.status).toBe(200);
      expect(board.tablero).toHaveBeenCalledWith('dist-a', {
        carId: ID,
        category: 'vtv',
        employeeId: OTRO,
        dueBefore: '2026-12-31',
        q: 'AB1',
        doneSince: '2026-10-01T00:00:00.000Z',
      });
    });

    it('no confunde `board` con un id de tarea', async () => {
      await expect(
        resultado(llamar('get', '/fleet/tasks/board')),
      ).resolves.toEqual([200, null]);
    });

    it.each([
      ['carId=no-uuid'],
      ['category=otra'],
      ['dueBefore=2026-13-45'],
      [`q=${'x'.repeat(101)}`],
    ])('400 con un filtro inválido (%s)', async (filtro) => {
      const [status] = await resultado(
        llamar('get', `/fleet/tasks/board?${filtro}`),
      );
      expect(status).toBe(400);
      expect(board.tablero).not.toHaveBeenCalled();
    });

    it('401 sin token', async () => {
      await expect(
        resultado(llamar('get', '/fleet/tasks/board', null)),
      ).resolves.toEqual([401, null]);
    });

    it('403 para un rol de las apps', async () => {
      const [status] = await resultado(
        llamar('get', '/fleet/tasks/board', RoleType.DELIVERY),
      );
      expect(status).toBe(403);
    });

    it('403 PERMISSION_DENIED sin `flota.ver`; con sólo `flota.ver` alcanza', async () => {
      permisos = ['pedidos.gestionar'];
      await expect(
        resultado(llamar('get', '/fleet/tasks/board')),
      ).resolves.toEqual([403, 'PERMISSION_DENIED']);
      permisos = ['flota.ver'];
      await expect(
        resultado(llamar('get', '/fleet/tasks/board')),
      ).resolves.toEqual([200, null]);
    });
  });

  describe('POST /fleet/tasks/:id/move', () => {
    const mover = (
      body: object,
      rol: RoleType | null = RoleType.ADMIN,
      cabeceras: Record<string, string> = {},
    ) => llamar('post', `/fleet/tasks/${ID}/move`, rol, body, cabeceras);

    it('200 con la tarjeta', async () => {
      const res = await mover({ to: 'in_progress', afterId: OTRO });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: ID, column: 'in_progress' });
      expect(board.mover).toHaveBeenCalledWith(
        ID,
        { to: 'in_progress', afterId: OTRO },
        'dist-a',
        'u1',
        undefined,
      );
    });

    it('la precondición llega del cuerpo o de If-Match (con comillas); el cuerpo manda', async () => {
      await mover({ to: 'scheduled' }, RoleType.ADMIN, {
        'If-Match': `"${ACTUALIZADA}"`,
      });
      expect((board.mover.mock.calls[0] as unknown[])[4]).toEqual(
        new Date(ACTUALIZADA),
      );
      await mover(
        { to: 'scheduled', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' },
        RoleType.ADMIN,
        { 'If-Match': ACTUALIZADA },
      );
      expect((board.mover.mock.calls[1] as unknown[])[4]).toEqual(
        new Date('2026-01-01T00:00:00.000Z'),
      );
    });

    it('`scheduledAt: null` pasa como ausente (la regla del turno la da el dominio)', async () => {
      const res = await mover({ to: 'scheduled', scheduledAt: null });
      expect(res.status).toBe(200);
      expect(
        (board.mover.mock.calls[0] as unknown[])[1] as { scheduledAt?: string },
      ).not.toHaveProperty('scheduledAt', null);
    });

    it('400 si If-Match no es una fecha', async () => {
      const [status] = await resultado(
        mover({ to: 'scheduled' }, RoleType.ADMIN, { 'If-Match': 'abc' }),
      );
      expect(status).toBe(400);
      expect(board.mover).not.toHaveBeenCalled();
    });

    it.each([
      ['sin destino', {}],
      ['a «hecha»', { to: 'done' }],
      ['a «cancelada»', { to: 'cancelled' }],
      ['turno que no es fecha', { to: 'scheduled', scheduledAt: 'mañana' }],
      ['vecina que no es UUID', { to: 'scheduled', beforeId: 'x' }],
      ['campo de más', { to: 'scheduled', status: 'done' }],
    ])('400 por validación: %s', async (_caso, body) => {
      const [status] = await resultado(mover(body));
      expect(status).toBe(400);
      expect(board.mover).not.toHaveBeenCalled();
    });

    it('400 INVALID_ID si el id no es UUID', async () => {
      await expect(
        resultado(
          llamar('post', '/fleet/tasks/x/move', RoleType.ADMIN, {
            to: 'scheduled',
          }),
        ),
      ).resolves.toEqual([400, 'INVALID_ID']);
    });

    it.each([
      [
        'falta el turno',
        movimientoRechazado('falta_el_turno', false),
        400,
        'FLEET_TASK_SCHEDULED_AT_REQUIRED',
      ],
      [
        'turno fuera de lugar',
        movimientoRechazado('turno_fuera_de_lugar', false),
        400,
        'FLEET_TASK_SCHEDULED_AT_NOT_ALLOWED',
      ],
      ['vecina inválida', vecinaInvalida(), 400, 'FLEET_TASK_NEIGHBOR_INVALID'],
      [
        'de otra empresa o inexistente',
        new NotFoundException('Tarea no encontrada'),
        404,
        null,
      ],
      ['cerrada', tareaCerrada(true), 409, 'FLEET_TASK_CLOSED'],
      [
        'transición no permitida',
        movimientoRechazado('transicion_no_permitida', false),
        409,
        'FLEET_TASK_TRANSITION_NOT_ALLOWED',
      ],
      [
        'cambió desde que se leyó',
        (() => {
          try {
            assertSinCambiosAjenos(new Date(1), new Date(2));
          } catch (e) {
            return e as Error;
          }
          return new Error('no lanzó');
        })(),
        409,
        'FLEET_TASK_STALE',
      ],
    ])('%s: %i %s', async (_caso, error, status, code) => {
      board.mover.mockRejectedValue(error);
      await expect(resultado(mover({ to: 'scheduled' }))).resolves.toEqual([
        status,
        code,
      ]);
    });

    it('401 sin token y 403 sin `flota.gestionar` (con `flota.ver` no alcanza)', async () => {
      await expect(
        resultado(mover({ to: 'scheduled' }, null)),
      ).resolves.toEqual([401, null]);
      permisos = ['flota.ver'];
      await expect(resultado(mover({ to: 'scheduled' }))).resolves.toEqual([
        403,
        'PERMISSION_DENIED',
      ]);
      expect(board.mover).not.toHaveBeenCalled();
    });

    it('403 para un cliente', async () => {
      const [status] = await resultado(
        mover({ to: 'scheduled' }, RoleType.CUSTOMER),
      );
      expect(status).toBe(403);
    });
  });

  describe('POST /fleet/tasks (v2)', () => {
    const crear = (body: object, rol: RoleType | null = RoleType.ADMIN) =>
      llamar('post', '/fleet/tasks', rol, body);

    it('201 con el responsable y la tarea v2 (con `assigneeEmployeeId` y `updatedAt`)', async () => {
      const res = await crear({
        planId: PLAN,
        carId: ID,
        assigneeEmployeeId: OTRO,
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        taskId: ID,
        assigneeEmployeeId: OTRO,
        updatedAt: ACTUALIZADA,
      });
      expect(tasks.create).toHaveBeenCalledWith(
        { planId: PLAN, carId: ID, assigneeEmployeeId: OTRO },
        'dist-a',
      );
    });

    it('400 si el responsable no es UUID', async () => {
      const [status] = await resultado(
        crear({ planId: PLAN, assigneeEmployeeId: 'x' }),
      );
      expect(status).toBe(400);
    });

    it.each([
      [new NotFoundException('Empleado no encontrado'), 404],
      [new ConflictException('El empleado Ana Paz está egresado'), 409],
    ])('el responsable: %s', async (error, status) => {
      tasks.create.mockRejectedValue(error);
      const [s] = await resultado(crear({ planId: PLAN, carId: ID }));
      expect(s).toBe(status);
    });

    it('403 sin `flota.gestionar`', async () => {
      permisos = ['flota.ver'];
      await expect(resultado(crear({ planId: PLAN }))).resolves.toEqual([
        403,
        'PERMISSION_DENIED',
      ]);
    });
  });

  describe('PATCH /fleet/tasks/:id (v2)', () => {
    const editar = (
      body: object,
      cabeceras: Record<string, string> = {},
      rol: RoleType | null = RoleType.ADMIN,
    ) => llamar('patch', `/fleet/tasks/${ID}`, rol, body, cabeceras);

    it('200: separa el responsable y la precondición del resto de la edición', async () => {
      const res = await editar({
        notes: 'cambio',
        assigneeEmployeeId: null,
        expectedUpdatedAt: ACTUALIZADA,
      });
      expect(res.status).toBe(200);
      expect(tasks.update).toHaveBeenCalledWith(
        ID,
        { notes: 'cambio' },
        'dist-a',
        'u1',
        { assigneeEmployeeId: null, expectedUpdatedAt: new Date(ACTUALIZADA) },
      );
    });

    it('la precondición también por If-Match', async () => {
      await editar({ notes: 'x' }, { 'If-Match': ACTUALIZADA });
      expect((tasks.update.mock.calls[0] as unknown[])[4]).toEqual({
        assigneeEmployeeId: undefined,
        expectedUpdatedAt: new Date(ACTUALIZADA),
      });
    });

    it.each([
      ['un campo que no se edita', { carId: ID }],
      ['responsable que no es UUID', { assigneeEmployeeId: 'x' }],
      ['precondición que no es fecha', { expectedUpdatedAt: 'ayer' }],
    ])('400: %s', async (_caso, body) => {
      const [status] = await resultado(editar(body));
      expect(status).toBe(400);
      expect(tasks.update).not.toHaveBeenCalled();
    });

    it.each([
      [new NotFoundException('Tarea no encontrada'), 404, null],
      [new ConflictException('La tarea ya está hecha'), 409, null],
    ])('%s', async (error, status, code) => {
      tasks.update.mockRejectedValue(error);
      await expect(resultado(editar({ notes: 'x' }))).resolves.toEqual([
        status,
        code,
      ]);
    });

    it('409 FLEET_TASK_STALE', async () => {
      tasks.update.mockImplementation(() => {
        assertSinCambiosAjenos(new Date(1), new Date(2));
      });
      await expect(resultado(editar({ notes: 'x' }))).resolves.toEqual([
        409,
        'FLEET_TASK_STALE',
      ]);
    });

    it('401 y 403', async () => {
      await expect(resultado(editar({}, {}, null))).resolves.toEqual([
        401,
        null,
      ]);
      permisos = ['flota.ver'];
      await expect(resultado(editar({}))).resolves.toEqual([
        403,
        'PERMISSION_DENIED',
      ]);
    });
  });
});
