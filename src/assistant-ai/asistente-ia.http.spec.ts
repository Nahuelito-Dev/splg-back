import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Logger,
  UnauthorizedException,
  VERSION_NEUTRAL,
  VersioningType,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { Server } from 'http';
import request from 'supertest';
import { PermissionGuard } from '../admin/guards/permission.guard';
import { StaffPermissionsService } from '../admin/staff-permissions.service';
import { BandejaAcceso } from '../chat/application/bandeja-acceso';
import { BandejaGestionService } from '../chat/application/bandeja-gestion.service';
import { BandejaService } from '../chat/application/bandeja.service';
import { ChatEvents, Efectos } from '../chat/application/chat.events';
import {
  ajustesDeLaBandejaPorDefecto,
  CompanyChatSettingsService,
} from '../chat/application/company-chat-settings.service';
import { CompanyTemplatesService } from '../chat/application/company-templates.service';
import { MessageTemplatesService } from '../chat/application/message-templates.service';
import {
  configuracionPorDefecto,
  SupportSettingsService,
} from '../chat/application/support-settings.service';
import {
  Channel,
  MessageKind,
  MessageVisibility,
  Party,
} from '../chat/domain/chat.enums';
import { ChatCompanySettings } from '../chat/entities/chat-company-settings.entity';
import type { Conversation } from '../chat/entities/conversation.entity';
import type { Message } from '../chat/entities/message.entity';
import { PlatformSupportSettings } from '../chat/entities/platform-support-settings.entity';
import { BandejaPresenter } from '../chat/presentation/bandeja.presenter';
import { CompanyChatConfigController } from '../chat/presentation/bandeja/company-chat-config.controller';
import { MyConversationsController } from '../chat/presentation/bandeja/my-conversations.controller';
import { PlatformSupportConfigController } from '../chat/presentation/platform-support-config.controller';
import { PlatformChatsController } from '../chat/presentation/platform-chats.controller';
import { ChatPresenter } from '../chat/presentation/chat.presenter';
import { TicketQueriesService } from '../chat/application/ticket-queries.service';
import { PlatformChatService } from '../chat/application/platform-chat.service';
import { ChatThreadsService } from '../chat/application/chat-threads.service';
import { SupportTicketsService } from '../chat/application/support-tickets.service';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter';
import { AlcanceGuard } from '../common/guards/alcance.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { crearValidationPipe } from '../common/validation/validation-pipe';
import { AccesoDeLaEmpresa } from '../platform/access/acceso-de-la-empresa.service';
import { ModuloGuard } from '../platform/access/modulo.guard';
import type { AssistantFaqService } from '../assistant/assistant-faq.service';
import { AsistenteDelChat } from '../chat/application/asistente-del-chat';
import type { NuevoMensaje } from '../chat/application/mensajes.port';
import type { MessageWriter } from '../chat/application/message-writer';
import { RespuestasFijas } from '../chat/application/respuestas-fijas';
import type { ChatViewsService } from '../chat/application/chat-views.service';
import { ConversationStatus } from '../chat/domain/chat.enums';
import { Conversation as ConversacionEntidad } from '../chat/entities/conversation.entity';
import type { RedisService } from '../redis/redis.service';
import type { DataSource } from 'typeorm';
import { MotivoDeDerivacion } from './asistente-ia.dominio';
import { AsistenteIaListener } from './asistente-ia.listener';
import {
  AsistenteIaService,
  type MensajeEntrante,
  PLANTILLA_DE_DERIVACION,
} from './asistente-ia.service';
import type { ConsultaAlAsistente } from './consulta-al-modelo';
import { AssistantTrace } from './entities/assistant-trace.entity';
import type { HerramientasDelAsistente } from './herramientas';

const EMPRESA = '11111111-1111-4111-8111-111111111111';
const SESION = '44444444-4444-4444-8444-444444444444';
const CONV = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';
const UUID = '0d6f0c34-8b7e-4c1a-9f3b-5a2e7d9c1b20';

/**
 * El `AuthGuard` real reducido a headers: sin token, 401; con token, el rol
 * pedido. El super admin trae la empresa de su sesión de soporte (si la hay).
 */
class AuthDePrueba implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.headers.authorization) {
      throw new UnauthorizedException('Sin token o token inválido');
    }
    const rol = req.headers['x-rol'] as RoleType;
    req.user = { user_id: 'u1', role: rol } as AuthenticatedUser;
    const sesion = req.headers['x-support-session'] as string | undefined;
    if (rol === RoleType.SUPER_ADMIN) {
      req.distributorId = sesion ? EMPRESA : null;
      if (sesion) {
        req.supportSession = {
          id: sesion,
          distributorId: EMPRESA,
          scope: [],
          expiresAt: new Date('2099-01-01T00:00:00Z'),
        };
      }
    } else {
      req.distributorId = EMPRESA;
    }
    return true;
  }
}

/** Una base en memoria con una fila de cada configuración: los servicios son los reales. */
function baseFalsa() {
  const filas = new Map<unknown, object>([
    [ChatCompanySettings, ajustesDeLaBandejaPorDefecto(EMPRESA)],
    [
      PlatformSupportSettings,
      Object.assign(configuracionPorDefecto(), { updatedAt: new Date() }),
    ],
  ]);
  const repo = (entidad: unknown) => ({
    findOne: jest.fn(() => Promise.resolve({ ...filas.get(entidad) })),
    findOneOrFail: jest.fn(() => Promise.resolve({ ...filas.get(entidad) })),
    save: jest.fn((fila: object) => {
      const guardada = Object.assign(
        Object.create(
          Object.getPrototypeOf(filas.get(entidad)) as object,
        ) as object,
        filas.get(entidad),
        fila,
      );
      filas.set(entidad, guardada);
      return Promise.resolve(guardada);
    }),
  });
  const manager = {
    getRepository: jest.fn(repo),
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('"distributor"') ? [{ name: 'Gas del Sur' }] : [],
      ),
    ),
  };
  return {
    filas,
    manager,
    transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) =>
      cb(manager),
    ),
  };
}

describe('Asistente con IA: matriz HTTP (v2)', () => {
  let app: INestApplication<Server>;
  let permisos: string[];
  let modulos: Set<string>;
  let base: ReturnType<typeof baseFalsa>;
  const emisor = new EventEmitter2();
  const eventos = new ChatEvents(emisor);
  const atender = jest.fn<Promise<void>, []>();
  const listener = new AsistenteIaListener({
    atender,
  } as unknown as AsistenteIaService);
  emisor.on(
    'chat.mensaje.creado',
    (e: Parameters<typeof listener.alCrearseUnMensaje>[0]) =>
      listener.alCrearseUnMensaje(e),
  );
  const conversacion = {
    conversationId: CONV,
    distributorId: EMPRESA,
    channel: Channel.STAFF_CUSTOMER,
  } as Conversation;
  const mensaje = {
    messageId: UUID,
    seq: 2,
    senderParty: Party.CUSTOMER,
    kind: MessageKind.TEXT,
    visibility: MessageVisibility.ALL,
    body: '¿A qué hora abren?',
  } as Message;
  const consultas = {
    chats: jest.fn(() =>
      Promise.resolve({ items: [], total: 0, counts: { waiting: 0, mine: 0 } }),
    ),
  };
  /** El envío de siempre: escribe y, después del commit, publica (lo que dispara al asistente). */
  const bandeja = {
    enviar: jest.fn(() => {
      eventos.publicar(new Efectos().mensaje(conversacion, mensaje));
      return Promise.resolve({ message: mensaje, created: true });
    }),
  };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [
        CompanyChatConfigController,
        PlatformSupportConfigController,
        MyConversationsController,
        PlatformChatsController,
      ],
      providers: [
        CompanyChatSettingsService,
        SupportSettingsService,
        BandejaAcceso,
        {
          // La base de cada test (`beforeEach`), detrás de un objeto fijo.
          provide: getDataSourceToken(),
          useValue: {
            get manager() {
              return base.manager;
            },
            transaction: (cb: (m: unknown) => Promise<unknown>) =>
              base.transaction(cb),
          },
        },
        { provide: CompanyTemplatesService, useValue: {} },
        { provide: MessageTemplatesService, useValue: {} },
        { provide: BandejaService, useValue: bandeja },
        { provide: BandejaGestionService, useValue: {} },
        { provide: TicketQueriesService, useValue: consultas },
        { provide: PlatformChatService, useValue: {} },
        { provide: ChatThreadsService, useValue: {} },
        { provide: SupportTicketsService, useValue: {} },
        {
          provide: ChatPresenter,
          useValue: { conversaciones: jest.fn(() => Promise.resolve([])) },
        },
        {
          provide: BandejaPresenter,
          useValue: {
            mensaje: jest.fn(() => Promise.resolve({ id: UUID, seq: 2 })),
          },
        },
        {
          provide: StaffPermissionsService,
          useValue: {
            deUsuario: () =>
              Promise.resolve({ todos: false, rol: null, permisos }),
          },
        },
        {
          provide: AccesoDeLaEmpresa,
          useValue: {
            habilitado: (_id: string, m: string) =>
              Promise.resolve(modulos.has(m)),
          },
        },
        { provide: APP_GUARD, useClass: AuthDePrueba },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: APP_GUARD, useClass: AlcanceGuard },
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
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    base = baseFalsa();
    permisos = ['mensajes.clientes', 'mensajes.configurar'];
    modulos = new Set(['chat', 'assistant']);
    atender.mockResolvedValue(undefined);
  });

  type Verbo = 'get' | 'put' | 'post';
  interface Quien {
    rol: RoleType | null;
    sesion?: string;
  }
  const ADMIN: Quien = { rol: RoleType.ADMIN };
  const SUPER: Quien = { rol: RoleType.SUPER_ADMIN };
  const SOPORTE: Quien = { rol: RoleType.SUPER_ADMIN, sesion: SESION };
  const CLIENTE: Quien = { rol: RoleType.CUSTOMER };
  const CHOFER: Quien = { rol: RoleType.DELIVERY };
  const NADIE: Quien = { rol: null };

  const pedir = (verbo: Verbo, ruta: string, quien: Quien, cuerpo?: object) => {
    const r = request(app.getHttpServer())[verbo](`/api/v2${ruta}`);
    if (quien.rol) r.set('Authorization', 'Bearer x').set('x-rol', quien.rol);
    if (quien.sesion) r.set('x-support-session', quien.sesion);
    return cuerpo ? r.send(cuerpo) : r;
  };
  const resultado = async (r: request.Test) => {
    const res = await r;
    return [res.status, (res.body as { code?: string }).code ?? null];
  };

  describe('GET/PUT /v2/chat/settings: `assistantAiEnabled` de la empresa', () => {
    const RUTA = '/chat/settings';

    it('200 GET: el interruptor (apagado por omisión) y si la función está disponible', async () => {
      const r = await pedir('get', RUTA, ADMIN).expect(200);
      expect(r.body).toMatchObject({
        assistantAiEnabled: false,
        assistantAiAvailable: true,
      });
      modulos.delete('assistant');
      const sin = await pedir('get', RUTA, ADMIN).expect(200);
      expect(sin.body).toMatchObject({ assistantAiAvailable: false });
    });

    it('200 PUT: lo prende y lo apaga; queda guardado', async () => {
      const r = await pedir('put', RUTA, ADMIN, {
        assistantAiEnabled: true,
      }).expect(200);
      expect(r.body).toMatchObject({
        assistantAiEnabled: true,
        assistantAiAvailable: true,
      });
      expect(base.filas.get(ChatCompanySettings)).toMatchObject({
        assistantAiEnabled: true,
        updatedByUserId: 'u1',
      });
      await pedir('put', RUTA, ADMIN, { assistantAiEnabled: false }).expect(
        200,
      );
      expect(base.filas.get(ChatCompanySettings)).toMatchObject({
        assistantAiEnabled: false,
      });
    });

    it('200 PUT parcial: la respuesta trae todos los campos, no sólo el que vino', async () => {
      const r = await pedir('put', RUTA, ADMIN, { ackEnabled: true }).expect(
        200,
      );
      expect(r.body).toEqual(
        expect.objectContaining({
          ackEnabled: true,
          customerChatEnabled: true,
          assistantAiEnabled: false,
          assistantAiAvailable: true,
          outOfHoursEnabled: true,
          firstResponseTargetMinutes: 30,
          effectiveAssistantName: 'Asistente de Gas del Sur',
        }),
      );
    });

    it('200 PUT: si ya estaba prendido y llega `true` sin la función, ignora ese campo y aplica el resto', async () => {
      Object.assign(base.filas.get(ChatCompanySettings) as object, {
        assistantAiEnabled: true,
      });
      modulos.delete('assistant');
      const r = await pedir('put', RUTA, ADMIN, {
        assistantAiEnabled: true,
        ackEnabled: true,
      }).expect(200);
      expect(r.body).toMatchObject({
        ackEnabled: true,
        assistantAiEnabled: true,
        assistantAiAvailable: false,
      });
    });

    it('200 PUT apagarlo aunque la función ya no esté habilitada', async () => {
      modulos.delete('assistant');
      expect(
        await resultado(
          pedir('put', RUTA, ADMIN, { assistantAiEnabled: false }),
        ),
      ).toEqual([200, null]);
    });

    it('400: tipo inválido o campo de más', async () => {
      for (const cuerpo of [
        { assistantAiEnabled: 'sí' },
        { assistantAiEnabled: 1 },
        { assistantAiEnabled: null },
        { assistantAiEnabled: true, assistantAiModel: 'opus' },
      ]) {
        expect((await resultado(pedir('put', RUTA, ADMIN, cuerpo)))[0]).toBe(
          400,
        );
      }
      expect(base.transaction).not.toHaveBeenCalled();
    });

    it('401 sin token', async () => {
      expect(await resultado(pedir('get', RUTA, NADIE))).toEqual([401, null]);
      expect(
        await resultado(
          pedir('put', RUTA, NADIE, { assistantAiEnabled: true }),
        ),
      ).toEqual([401, null]);
    });

    it('403: cliente o chofer, sin `mensajes.configurar`, función apagada, módulo `chat` apagado y modo soporte sólo lectura', async () => {
      const prender = { assistantAiEnabled: true };
      for (const quien of [CLIENTE, CHOFER]) {
        expect((await resultado(pedir('put', RUTA, quien, prender)))[0]).toBe(
          403,
        );
        expect((await resultado(pedir('get', RUTA, quien)))[0]).toBe(403);
      }
      permisos = ['mensajes.clientes'];
      expect(await resultado(pedir('put', RUTA, ADMIN, prender))).toEqual([
        403,
        'PERMISSION_DENIED',
      ]);
      permisos = ['mensajes.clientes', 'mensajes.configurar'];
      modulos.delete('assistant');
      const sinFuncion = await pedir('put', RUTA, ADMIN, prender).expect(403);
      expect(sinFuncion.body).toMatchObject({
        code: 'MODULE_DISABLED',
        message: 'Esta función no está disponible para la distribuidora',
      });
      expect(JSON.stringify(sinFuncion.body)).not.toMatch(/m[oó]dulo|plan/i);
      modulos = new Set(['assistant']);
      expect(await resultado(pedir('get', RUTA, ADMIN))).toEqual([
        403,
        'MODULE_DISABLED',
      ]);
      modulos = new Set(['chat', 'assistant']);
      // El modo soporte no entra a la configuración de la bandeja (es sólo
      // de los admins de la empresa): 403 por rol, ni lee ni escribe.
      expect((await resultado(pedir('get', RUTA, SOPORTE)))[0]).toBe(403);
      expect((await resultado(pedir('put', RUTA, SOPORTE, prender)))[0]).toBe(
        403,
      );
      expect((await resultado(pedir('put', RUTA, SUPER, prender)))[0]).toBe(
        403,
      );
      expect(base.filas.get(ChatCompanySettings)).toMatchObject({
        assistantAiEnabled: false,
      });
    });
  });

  describe('GET/PUT /v2/platform/support-settings: el asistente del soporte y los topes', () => {
    const RUTA = '/platform/support-settings';

    it('200 GET: interruptor apagado, topes por omisión y el costo estimado calculado por el back', async () => {
      const r = await pedir('get', RUTA, SUPER).expect(200);
      expect(r.body).toMatchObject({
        assistantAiEnabled: false,
        assistantRepliesPerConversation: 10,
        assistantMonthlyTokenLimit: 2000000,
        assistantMonthlyCostEstimateUsd: { min: 0.24, max: 1 },
      });
    });

    it('200 PUT: el costo estimado sigue al tope nuevo', async () => {
      const r = await pedir('put', RUTA, SUPER, {
        assistantMonthlyTokenLimit: 10000,
      }).expect(200);
      expect(r.body).toMatchObject({
        assistantMonthlyCostEstimateUsd: { min: 0.0012, max: 0.005 },
      });
    });

    it('200 PUT: prende el asistente y cambia los topes en sus límites', async () => {
      // Un cambio parcial no pisa lo demás (ni los topes ni el horario).
      for (const cuerpo of [
        { chatInactivityHours: 24 },
        {
          assistantAiEnabled: true,
          assistantRepliesPerConversation: 1,
          assistantMonthlyTokenLimit: 10000,
        },
        {
          assistantRepliesPerConversation: 50,
          assistantMonthlyTokenLimit: 1000000000,
        },
      ]) {
        const r = await pedir('put', RUTA, SUPER, cuerpo).expect(200);
        expect(r.body).toMatchObject(cuerpo);
      }
      expect(base.filas.get(PlatformSupportSettings)).toMatchObject({
        assistantAiEnabled: true,
        assistantRepliesPerConversation: 50,
        assistantMonthlyTokenLimit: 1000000000,
      });
    });

    it('400: tipo, fuera de rango, no entero o campo de más', async () => {
      for (const cuerpo of [
        { assistantAiEnabled: 'true' },
        { assistantAiEnabled: null },
        { assistantRepliesPerConversation: null },
        { assistantMonthlyTokenLimit: null },
        { assistantRepliesPerConversation: 0 },
        { assistantRepliesPerConversation: 51 },
        { assistantRepliesPerConversation: 2.5 },
        { assistantMonthlyTokenLimit: 9999 },
        { assistantMonthlyTokenLimit: 1000000001 },
        { assistantMonthlyTokenLimit: 'mucho' },
        { assistantModel: 'claude-opus-5-5' },
      ]) {
        expect((await resultado(pedir('put', RUTA, SUPER, cuerpo)))[0]).toBe(
          400,
        );
      }
      expect(base.transaction).not.toHaveBeenCalled();
    });

    it('401 sin token', async () => {
      expect(await resultado(pedir('get', RUTA, NADIE))).toEqual([401, null]);
      expect(
        await resultado(
          pedir('put', RUTA, NADIE, { assistantAiEnabled: true }),
        ),
      ).toEqual([401, null]);
    });

    it('403: admin de empresa, cliente o chofer', async () => {
      for (const quien of [ADMIN, CLIENTE, CHOFER]) {
        expect(
          (
            await resultado(
              pedir('put', RUTA, quien, { assistantAiEnabled: true }),
            )
          )[0],
        ).toBe(403);
        expect((await resultado(pedir('get', RUTA, quien)))[0]).toBe(403);
      }
      expect(base.transaction).not.toHaveBeenCalled();
    });
  });

  describe('GET /v2/platform/chats: `awaiting`', () => {
    const RUTA = '/platform/chats';

    it('200: `awaiting=true` y `false` llegan como booleano, con `assigned=none`', async () => {
      await pedir('get', `${RUTA}?awaiting=true&assigned=none`, SUPER).expect(
        200,
      );
      expect(consultas.chats).toHaveBeenLastCalledWith(
        'u1',
        expect.objectContaining({ awaiting: true, assigned: 'none' }),
      );
      await pedir('get', `${RUTA}?awaiting=false`, SUPER).expect(200);
      expect(consultas.chats).toHaveBeenLastCalledWith(
        'u1',
        expect.objectContaining({ awaiting: false }),
      );
      await pedir('get', RUTA, SUPER).expect(200);
      expect(consultas.chats).toHaveBeenLastCalledWith(
        'u1',
        expect.not.objectContaining({ awaiting: expect.anything() as unknown }),
      );
    });

    it('400: `awaiting` que no es true/false', async () => {
      for (const v of ['sí', '1', 'TRUE', '']) {
        expect(
          (await resultado(pedir('get', `${RUTA}?awaiting=${v}`, SUPER)))[0],
        ).toBe(400);
      }
    });

    it('401 sin token; 403 admin de empresa, cliente o chofer', async () => {
      expect(await resultado(pedir('get', RUTA, NADIE))).toEqual([401, null]);
      for (const quien of [ADMIN, CLIENTE, CHOFER]) {
        expect((await resultado(pedir('get', RUTA, quien)))[0]).toBe(403);
      }
    });
  });

  describe('POST /v2/me/conversations/:id/messages: el envío del cliente no depende del asistente', () => {
    const enviar = () =>
      pedir('post', `/me/conversations/${CONV}/messages`, CLIENTE, {
        clientMessageId: UUID,
        body: '¿A qué hora abren?',
      });

    it.each([
      ['falla', () => Promise.reject(new Error('API caída'))],
      ['tarda (no termina nunca)', () => new Promise<void>(() => undefined)],
      [
        'tira de forma síncrona',
        () => {
          throw new Error('sin clave');
        },
      ],
    ])('201 aunque el asistente %s', async (_caso, comportamiento) => {
      atender.mockImplementation(comportamiento as () => Promise<void>);
      const r = await enviar().expect(201);
      expect(r.body).toEqual({ id: UUID, seq: 2 });
      // El asistente arranca después de responder.
      await new Promise((ok) => setImmediate(ok));
      await new Promise((ok) => setImmediate(ok));
      expect(atender).toHaveBeenCalledTimes(1);
    });

    it('201 aunque el asistente derive: el asistente real publica la derivación después de responder', async () => {
      const real = asistenteQueDeriva();
      atender.mockImplementation((e?: unknown) =>
        real.servicio.atender(e as MensajeEntrante),
      );
      const r = await enviar().expect(201);
      expect(r.body).toEqual({ id: UUID, seq: 2 });
      // (Que no espera al asistente lo prueba el caso «tarda»: acá, que la derivación sale de verdad.)
      await real.terminado;
      expect(real.consultar).toHaveBeenCalledTimes(1);
      expect(real.escritos).toEqual([
        expect.objectContaining({
          kind: MessageKind.AUTO_REPLY,
          templateKey: PLANTILLA_DE_DERIVACION,
          body: 'Te paso con alguien del equipo de Gas del Sur. Te va a responder a la brevedad.',
          payload: {
            senderLabel: 'Asistente de Gas del Sur',
            ai: { model: 'claude-haiku-5-5', handoff: true },
          },
        }),
      ]);
      expect(real.esperando).toEqual([CONV]);
      expect(real.eventos.publicar).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * Un `AsistenteIaService` REAL (regla del hilo, publicación, traza) sobre una
 * base en memoria, con la consulta al modelo simulada para que derive.
 */
function asistenteQueDeriva() {
  const conversacion = Object.assign(new ConversacionEntidad(), {
    conversationId: CONV,
    distributorId: EMPRESA,
    channel: Channel.STAFF_CUSTOMER,
    status: ConversationStatus.OPEN,
    assignedToUserId: null,
    awaitingHumanSince: null,
    customerUserId: 'u1',
    orderId: null,
  });
  const escritos: NuevoMensaje[] = [];
  const esperando: unknown[] = [];
  let fin: () => void = () => undefined;
  const terminado = new Promise<void>((ok) => {
    fin = ok;
  });
  const manager = {
    getRepository: (e: unknown) =>
      e === AssistantTrace
        ? { insert: () => Promise.resolve({}) }
        : { findOne: () => Promise.resolve(conversacion) },
    query: (sql: string, params: unknown[] = []) => {
      if (sql.includes('"de_la_ia"')) {
        return Promise.resolve([
          {
            seq: 2,
            message_id: UUID,
            sender_party: Party.CUSTOMER,
            kind: MessageKind.TEXT,
            de_la_ia: false,
            created_at: new Date(),
            retirado: false,
          },
        ]);
      }
      if (sql.includes('"full_name"')) {
        return Promise.resolve([{ persona: 'Ana', empresa: 'Gas del Sur' }]);
      }
      if (sql.includes('"awaiting_human_since" = $2'))
        esperando.push(params[0]);
      return Promise.resolve([]);
    },
  };
  const ds = {
    manager,
    getRepository: manager.getRepository,
    query: (sql: string) =>
      Promise.resolve(
        sql.includes('count(*)')
          ? [{ n: 0 }]
          : sql.includes('AS hay')
            ? [{ hay: false }]
            : sql.includes('sum(')
              ? [{ n: '0' }]
              : sql.includes('"body" FROM')
                ? [
                    {
                      sender_party: Party.CUSTOMER,
                      kind: MessageKind.TEXT,
                      body: 'Hola',
                    },
                  ]
                : [],
      ),
    transaction: (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
  };
  const ajustesEmpresa = {
    leer: () =>
      Promise.resolve(
        Object.assign(ajustesDeLaBandejaPorDefecto(EMPRESA), {
          assistantAiEnabled: true,
        }),
      ),
    nombreDeLaEmpresa: () => Promise.resolve('Gas del Sur'),
  } as unknown as CompanyChatSettingsService;
  const soporte = {
    leer: () => Promise.resolve(configuracionPorDefecto()),
  } as unknown as SupportSettingsService;
  const writer = {
    escribir: (_m: unknown, nuevo: NuevoMensaje) => {
      escritos.push(nuevo);
      return Promise.resolve({
        message: { ...nuevo, messageId: 'resp-1', seq: 3 },
        created: true,
        conversation: conversacion,
      });
    },
  } as unknown as MessageWriter;
  const consultar = jest.fn(() =>
    Promise.resolve({
      tipo: 'derivar',
      motivo: MotivoDeDerivacion.REQUESTED,
      modelo: 'claude-haiku-5-5',
      uso: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      herramientas: ['pasar_a_persona'],
    }),
  );
  const eventos = { publicar: jest.fn(() => fin()) };
  const vistas = {
    nombreDeLaPlataforma: () => 'OrixTech',
  } as unknown as ChatViewsService;
  const servicio = new AsistenteIaService(
    ds as unknown as DataSource,
    {
      withLock: async (_k: string, _t: number, fn: () => Promise<unknown>) => ({
        obtenido: true,
        valor: await fn(),
      }),
    } as unknown as RedisService,
    new AsistenteDelChat(
      {
        habilitado: () => Promise.resolve(true),
      } as unknown as AccesoDeLaEmpresa,
      ajustesEmpresa,
      soporte,
    ),
    ajustesEmpresa,
    soporte,
    vistas,
    {
      listar: () => Promise.resolve({ items: [], version: 0 }),
    } as unknown as AssistantFaqService,
    writer,
    new RespuestasFijas(writer, ajustesEmpresa, soporte, vistas),
    eventos as unknown as ChatEvents,
    { consultar } as unknown as ConsultaAlAsistente,
    {} as HerramientasDelAsistente,
  );
  return { servicio, escritos, esperando, consultar, eventos, terminado };
}
