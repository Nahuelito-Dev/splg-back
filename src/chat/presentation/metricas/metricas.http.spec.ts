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
import { PermissionGuard } from '../../../admin/guards/permission.guard';
import { StaffPermissionsService } from '../../../admin/staff-permissions.service';
import { RoleType } from '../../../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { GlobalExceptionFilter } from '../../../common/filters/global-exception.filter';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { crearValidationPipe } from '../../../common/validation/validation-pipe';
import { AccesoDeLaEmpresa } from '../../../platform/access/acceso-de-la-empresa.service';
import { ModuloGuard } from '../../../platform/access/modulo.guard';
import { ChatMetricsService } from '../../application/chat-metrics.service';
import {
  ajustesDeLaBandejaPorDefecto,
  CompanyChatSettingsService,
} from '../../application/company-chat-settings.service';
import { PlatformChatMetricsService } from '../../application/platform-chat-metrics.service';
import {
  configuracionPorDefecto,
  SupportSettingsService,
} from '../../application/support-settings.service';
import { Channel, ConversationStatus } from '../../domain/chat.enums';
import { MetricasReadModel } from '../../infrastructure/metricas-read-model';
import {
  CompanyChatMetricsController,
  PlatformChatMetricsController,
} from './chat-metrics.controller';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OTRA = '33333333-3333-4333-8333-333333333333';

/** El `AuthGuard` real reducido a headers: sin token, 401; con token, el rol y la empresa pedidos. */
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
        ? null
        : ((req.headers['x-empresa'] as string | undefined) ?? A);
    return true;
  }
}

/**
 * Una base con datos SÓLO de la empresa A: cada lectura filtra por la empresa
 * que recibe, como el `WHERE distributor_id = $1` de las consultas reales.
 */
function lecturaFalsa() {
  const deA = <T>(id: string | null, v: T, vacio: T): T =>
    id === A ? v : vacio;
  const creada = new Date();
  creada.setUTCHours(creada.getUTCHours() - 2);
  const respondida = new Date(creada.getTime() + 12 * 60_000);
  return {
    conversacionesDelPeriodo: jest.fn((id: string) =>
      Promise.resolve(
        deA(
          id,
          [
            {
              conversationId: 'conv-a',
              channel: Channel.STAFF_CUSTOMER,
              status: ConversationStatus.OPEN,
              createdAt: creada,
              firstIncomingAt: creada,
              firstResponseAt: respondida,
              closedAt: null,
              closedReason: null,
            },
          ],
          [],
        ),
      ),
    ),
    etiquetasDelPeriodo: jest.fn((id: string) =>
      Promise.resolve(
        deA(
          id,
          [
            {
              labelId: 'et-a',
              name: 'Envíos',
              color: 'orange',
              conversationId: 'conv-a',
            },
            {
              labelId: 'et-b',
              name: 'Pagos',
              color: 'blue',
              conversationId: null,
            },
          ],
          [],
        ),
      ),
    ),
    enVivo: jest.fn((id: string) =>
      Promise.resolve(
        deA(
          id,
          [
            {
              channel: Channel.STAFF_CUSTOMER,
              open: 7,
              unassigned: 3,
              unanswered: 2,
              awaitingHuman: 1,
            },
          ],
          [],
        ),
      ),
    ),
    usoDePlantillas: jest.fn((id: string) =>
      Promise.resolve(
        deA(id, [{ kind: 'quick' as const, key: 'saludo', count: 9 }], []),
      ),
    ),
    trazasDelAsistente: jest.fn((_c: string, _r: unknown, id: string | null) =>
      Promise.resolve(
        deA(
          id,
          {
            trazas: [
              {
                distributorId: A,
                outcome: 'answered',
                reason: null,
                count: 6,
                conversations: 4,
              },
              {
                distributorId: A,
                outcome: 'handed_off',
                reason: 'requested',
                count: 2,
                conversations: 2,
              },
            ],
            atendidas: new Map([[A, 5]]),
          },
          { trazas: [], atendidas: new Map<string, number>() },
        ),
      ),
    ),
    resueltasSinPersona: jest.fn(
      (_c: string, _p: string, _r: unknown, id: string | null) =>
        Promise.resolve(
          deA(
            id,
            [
              {
                distributorId: A,
                closedWithAssistant: 4,
                resolvedWithoutHuman: 3,
              },
            ],
            [],
          ),
        ),
    ),
    encuestas: jest.fn((id: string) =>
      Promise.resolve(
        deA(id, [{ served_by: 'team', score: 4, n: '3', vencidas: '0' }], []),
      ),
    ),
    existeLaEmpresa: jest.fn((id: string) => Promise.resolve(id !== OTRA)),
    chatsDeSoporte: jest.fn(() => Promise.resolve([])),
    chatsEsperando: jest.fn(() => Promise.resolve([])),
    ticketsEnVivo: jest.fn(() => Promise.resolve({ open: 1, overdue: 0 })),
    ticketsDelPeriodo: jest.fn(() => Promise.resolve([])),
    usoPorEmpresa: jest.fn(() =>
      Promise.resolve([
        {
          distributorId: A,
          name: 'Gas del Sur',
          conversations: 1,
          messages: 4,
        },
      ]),
    ),
  };
}

/**
 * Matriz HTTP de las métricas (B4): 200, 400 (período inválido, de más de un
 * año, canal o empresa inválidos, parámetro desconocido), 401, 403 (rol,
 * permiso, módulo) y 404, con los guards reales de rol, permiso y módulo, el
 * pipe de validación y el filtro global. Los servicios son los reales sobre
 * una base falsa: así se ve que la empresa B no recibe números de A.
 */
describe('Métricas del chat: matriz HTTP (v2)', () => {
  let app: INestApplication<Server>;
  let permisos: string[];
  let chatHabilitado: boolean;
  let asistenteDisponible: boolean;
  const lectura = lecturaFalsa();

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [
        CompanyChatMetricsController,
        PlatformChatMetricsController,
      ],
      providers: [
        ChatMetricsService,
        PlatformChatMetricsService,
        { provide: MetricasReadModel, useValue: lectura },
        {
          provide: CompanyChatSettingsService,
          useValue: {
            leer: jest.fn((id: string) =>
              Promise.resolve(ajustesDeLaBandejaPorDefecto(id)),
            ),
            asistenteConIaDisponible: jest.fn(() =>
              Promise.resolve(asistenteDisponible),
            ),
          },
        },
        {
          provide: SupportSettingsService,
          useValue: {
            leer: jest.fn(() => Promise.resolve(configuracionPorDefecto())),
          },
        },
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
            habilitado: jest.fn(() => Promise.resolve(chatHabilitado)),
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
    permisos = ['mensajes.supervisar'];
    chatHabilitado = true;
    asistenteDisponible = false;
  });

  const llamar = (ruta: string, rol: RoleType | null, empresa?: string) => {
    const r = request(app.getHttpServer()).get(`/api/v2${ruta}`);
    if (rol) r.set('Authorization', 'Bearer x').set('x-rol', rol);
    if (empresa) r.set('x-empresa', empresa);
    return r;
  };
  const resultado = async (r: request.Test) => {
    const res = await r;
    return [res.status, (res.body as { code?: string }).code ?? null];
  };
  const ADMIN = RoleType.ADMIN;
  const SUPER = RoleType.SUPER_ADMIN;

  describe('GET /v2/chat/metrics (empresa)', () => {
    it('200 con el período por omisión (30 días) y la forma completa', async () => {
      const res = await llamar('/chat/metrics', ADMIN);
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown> & {
        daily: unknown[];
        firstResponse: Record<string, unknown>;
      };
      expect(Object.keys(body).sort()).toEqual(
        [
          'assistant',
          'automaticReplies',
          'byChannel',
          'byLabel',
          'channel',
          'conversations',
          'daily',
          'firstResponse',
          'from',
          'live',
          'quickReplies',
          'resolution',
          'satisfaction',
          'targetMinutes',
          'to',
        ].sort(),
      );
      expect(body.daily).toHaveLength(30);
      expect(body.firstResponse).toEqual(
        expect.objectContaining({ responded: 1, medianMinutes: 12 }),
      );
      expect(body.assistant).toBeNull();
    });

    it('200 con el asistente disponible: el bloque armado, sólo con los datos de la empresa', async () => {
      asistenteDisponible = true;
      const deA = await llamar('/chat/metrics', ADMIN, A);
      expect(deA.status).toBe(200);
      expect((deA.body as { assistant: unknown }).assistant).toEqual({
        enabled: false,
        aiReplies: 6,
        handoffs: 2,
        handoffReasons: [
          {
            reason: 'requested',
            label:
              'El asistente no pudo resolverlo o la persona pidió hablar con alguien',
            count: 2,
          },
        ],
        conversationsAttended: 5,
        closedWithAssistant: 4,
        resolvedWithoutHuman: 3,
        resolvedWithoutHumanRate: 0.75,
      });
      const deB = await llamar('/chat/metrics', ADMIN, B);
      expect((deB.body as { assistant: unknown }).assistant).toEqual(
        expect.objectContaining({
          aiReplies: 0,
          handoffs: 0,
          resolvedWithoutHumanRate: null,
        }),
      );
      // Sólo choferes: sin asistente aunque esté disponible.
      const choferes = await llamar(
        '/chat/metrics?channel=staff_driver',
        ADMIN,
        A,
      );
      expect((choferes.body as { assistant: unknown }).assistant).toBeNull();
    });

    it('200 con período y canal', async () => {
      const res = await llamar(
        '/chat/metrics?from=2026-11-01&to=2026-11-16&channel=staff_driver',
        ADMIN,
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          from: '2026-11-01',
          to: '2026-11-16',
          channel: 'staff_driver',
          satisfaction: null,
        }),
      );
    });

    it('400: período de más de un año, «desde» posterior, fecha inválida, canal o parámetro desconocido', async () => {
      for (const q of [
        'from=2025-01-01&to=2026-11-16',
        'from=2026-11-16&to=2026-11-01',
        'from=2026-02-30',
        'to=16-11-2026',
        'from=2026-11-01T00:00:00Z',
        'channel=platform_chat',
        'distributorId=' + B,
      ]) {
        expect((await resultado(llamar(`/chat/metrics?${q}`, ADMIN)))[0]).toBe(
          400,
        );
      }
      const res = await llamar(
        '/chat/metrics?from=2025-01-01&to=2026-11-16',
        ADMIN,
      );
      expect((res.body as { message: string }).message).toBe(
        'El período puede abarcar hasta 366 días',
      );
    });

    it('401 sin token; 403 por rol, por permiso y con los mensajes apagados', async () => {
      expect(await resultado(llamar('/chat/metrics', null))).toEqual([
        401,
        null,
      ]);
      expect(
        (await resultado(llamar('/chat/metrics', RoleType.CUSTOMER)))[0],
      ).toBe(403);
      expect(
        (await resultado(llamar('/chat/metrics', RoleType.DELIVERY)))[0],
      ).toBe(403);
      permisos = [
        'mensajes.clientes',
        'mensajes.choferes',
        'mensajes.configurar',
      ];
      const sinPermiso = await llamar('/chat/metrics', ADMIN);
      expect([
        sinPermiso.status,
        (sinPermiso.body as { code: string }).code,
        (sinPermiso.body as { message: string }).message,
      ]).toEqual([
        403,
        'PERMISSION_DENIED',
        'No tenés permiso para supervisar los mensajes',
      ]);
      permisos = ['mensajes.supervisar'];
      chatHabilitado = false;
      expect(await resultado(llamar('/chat/metrics', ADMIN))).toEqual([
        403,
        'MODULE_DISABLED',
      ]);
    });

    it('aislamiento: la empresa B no ve los números de A', async () => {
      const deA = (await llamar('/chat/metrics', ADMIN, A)).body as {
        conversations: number;
        live: { open: number };
        quickReplies: { total: number };
        satisfaction: { answered: number };
      };
      const deB = (await llamar('/chat/metrics', ADMIN, B)).body as typeof deA;
      expect([
        deA.conversations,
        deA.live.open,
        deA.quickReplies.total,
        deA.satisfaction.answered,
      ]).toEqual([1, 7, 9, 3]);
      expect([
        deB.conversations,
        deB.live.open,
        deB.quickReplies.total,
        deB.satisfaction.answered,
      ]).toEqual([0, 0, 0, 0]);
      // El corte por etiqueta (7c): A ve las suyas con su TPR; B, ninguna.
      expect(
        (
          deA as unknown as {
            byLabel: Array<{
              label: { name: string };
              conversations: number;
              firstResponse: { medianMinutes: number | null };
            }>;
          }
        ).byLabel.map((e) => [
          e.label.name,
          e.conversations,
          e.firstResponse.medianMinutes,
        ]),
      ).toEqual([
        ['Envíos', 1, 12],
        ['Pagos', 0, null],
      ]);
      expect((deB as unknown as { byLabel: unknown[] }).byLabel).toEqual([]);
      expect(lectura.etiquetasDelPeriodo).toHaveBeenLastCalledWith(
        B,
        expect.anything(),
        expect.anything(),
      );
      expect(lectura.conversacionesDelPeriodo).toHaveBeenLastCalledWith(
        B,
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('GET /v2/platform/chat/metrics (plataforma)', () => {
    it('200 de todas las empresas y de una', async () => {
      const res = await llamar('/platform/chat/metrics', SUPER);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body as object).sort()).toEqual([
        'assistant',
        'chat',
        'companies',
        'distributorId',
        'from',
        'tickets',
        'to',
      ]);
      expect((res.body as { tickets: { open: number } }).tickets.open).toBe(1);
      const una = await llamar(
        `/platform/chat/metrics?distributorId=${A}`,
        SUPER,
      );
      expect(una.status).toBe(200);
      expect((una.body as { distributorId: string }).distributorId).toBe(A);
      expect(lectura.chatsDeSoporte).toHaveBeenLastCalledWith(
        expect.anything(),
        A,
      );
    });

    it('400 período o empresa inválidos; 404 empresa que no existe', async () => {
      for (const q of [
        'from=2024-11-01&to=2026-11-16',
        'from=2026-11-16&to=2026-11-01',
        'distributorId=no-es-uuid',
        'channel=staff_customer',
      ]) {
        expect(
          (await resultado(llamar(`/platform/chat/metrics?${q}`, SUPER)))[0],
        ).toBe(400);
      }
      const res = await llamar(
        `/platform/chat/metrics?distributorId=${OTRA}`,
        SUPER,
      );
      expect([res.status, (res.body as { message: string }).message]).toEqual([
        404,
        'No existe la empresa',
      ]);
    });

    it('401 sin token; 403 para el personal de una empresa y las apps', async () => {
      expect(await resultado(llamar('/platform/chat/metrics', null))).toEqual([
        401,
        null,
      ]);
      for (const rol of [ADMIN, RoleType.CUSTOMER, RoleType.DELIVERY]) {
        expect(
          (await resultado(llamar('/platform/chat/metrics', rol)))[0],
        ).toBe(403);
      }
    });
  });
});
