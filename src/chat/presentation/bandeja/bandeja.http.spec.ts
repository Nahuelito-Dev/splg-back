import {
  CanActivate,
  ExecutionContext,
  HttpException,
  INestApplication,
  UnauthorizedException,
  VERSION_NEUTRAL,
  VersioningType,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
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
import { BandejaAcceso } from '../../application/bandeja-acceso';
import { BandejaGestionService } from '../../application/bandeja-gestion.service';
import { BandejaSugerenciasService } from '../../application/bandeja-sugerencias.service';
import { BandejaService } from '../../application/bandeja.service';
import {
  chatDeClientesApagado,
  mensajeAjeno,
  borradoNoPermitido,
} from '../../application/bandeja.errors';
import { ChatRateLimit } from '../../application/chat-rate-limit';
import {
  ajustesDeLaBandejaPorDefecto,
  CompanyChatSettingsService,
} from '../../application/company-chat-settings.service';
import { CompanyTemplatesService } from '../../application/company-templates.service';
import { Channel, Party } from '../../domain/chat.enums';
import {
  AsignadoSinPermisoError,
  ChatNoEscribibleError,
  ConversacionCerradaError,
  ConversacionConReclamoError,
  ConversacionNoEncontradaError,
  ConversacionNoReabribleError,
  MensajeDeUnPedidoError,
  MensajeYaCitadoError,
  PedidoSinChoferError,
  PlazoDelPedidoVencidoError,
  RespuestaInvalidaError,
  NombreDelAsistenteInvalidoError,
  VariableDelNombreDelAsistenteError,
  VariableDePlantillaDesconocidaError,
  VentanaDeBorradoVencidaError,
  VentanaDeEdicionVencidaError,
} from '../../domain/chat.errors';
import { BandejaPresenter } from '../bandeja.presenter';
import { CompanyChatConfigController } from './company-chat-config.controller';
import { CompanyInboxController } from './company-inbox.controller';
import { MyConversationsController } from './my-conversations.controller';

const ID = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';
const MSG = '6b1e2a40-9c3d-4e5f-8a7b-1c2d3e4f5a6b';
const UUID = '0d6f0c34-8b7e-4c1a-9f3b-5a2e7d9c1b20';
const cuerpo = { clientMessageId: UUID, body: 'Hola' };

/** Lo que hace el `AuthGuard` real: sin token, 401; con token, el usuario del rol pedido. */
class AuthDePrueba implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.headers.authorization) {
      throw new UnauthorizedException('Sin token o token inválido');
    }
    const rol = req.headers['x-rol'] as RoleType;
    req.user = { user_id: 'u1', role: rol } as AuthenticatedUser;
    req.distributorId = rol === RoleType.SUPER_ADMIN ? null : 'dist-a';
    return true;
  }
}

/**
 * Matriz HTTP de la bandeja (CH3): cada endpoint con 2xx, 400 por validación,
 * 401, 403 (rol, permiso del canal, módulo `chat` apagado), 404, 409 y 429, con
 * los guards reales de rol, permiso y módulo, el pipe de validación y el filtro
 * global (los `code`). Los servicios se simulan: sus reglas se prueban en sus
 * propios tests; acá, que cada error llegue con su código HTTP y su `code`.
 */
describe('Bandeja de la empresa: matriz HTTP (v2)', () => {
  let app: INestApplication<Server>;
  let permisos: string[];
  let chatHabilitado: boolean;
  const bandeja = {
    abrirDeLaPersona: jest.fn(),
    abrirDelPersonal: jest.fn(),
    enviar: jest.fn(),
    editar: jest.fn(),
    borrar: jest.fn(),
    conversacion: jest.fn(),
    mensajes: jest.fn(),
    leer: jest.fn(),
  };
  const gestion = {
    listar: jest.fn(),
    misConversaciones: jest.fn(),
    asignar: jest.fn(),
    cerrar: jest.fn(),
    reabrir: jest.fn(),
    crearReclamo: jest.fn(),
    difundir: jest.fn(),
  };
  const presentar = {
    conversacion: jest.fn().mockResolvedValue({ id: ID }),
    conversaciones: jest.fn().mockResolvedValue([]),
    mensaje: jest.fn().mockResolvedValue({ id: MSG }),
    mensajes: jest.fn().mockResolvedValue([]),
  };
  const ajustes = {
    leer: jest.fn().mockResolvedValue(ajustesDeLaBandejaPorDefecto('dist-a')),
    actualizar: jest
      .fn()
      .mockResolvedValue(ajustesDeLaBandejaPorDefecto('dist-a')),
    actualizarHorario: jest
      .fn()
      .mockResolvedValue(ajustesDeLaBandejaPorDefecto('dist-a')),
    nombreDeLaEmpresa: jest.fn().mockResolvedValue('Gas del Sur'),
    asistenteConIaDisponible: jest.fn().mockResolvedValue(false),
  };
  const sugerencias = { sugerir: jest.fn() };
  const plantilla = {
    templateId: ID,
    channel: null,
    key: 'saludo',
    title: 'Saludo',
    body: 'Hola',
    active: true,
    updatedAt: new Date(),
  };
  const plantillas = {
    listar: jest.fn().mockResolvedValue([plantilla]),
    crear: jest.fn().mockResolvedValue(plantilla),
    actualizar: jest.fn().mockResolvedValue(plantilla),
    darDeBaja: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    const staff = {
      deUsuario: jest.fn(() =>
        Promise.resolve({ todos: false, rol: null, permisos }),
      ),
    };
    const modulo = await Test.createTestingModule({
      controllers: [
        CompanyInboxController,
        CompanyChatConfigController,
        MyConversationsController,
      ],
      providers: [
        BandejaAcceso,
        { provide: getDataSourceToken(), useValue: {} },
        { provide: StaffPermissionsService, useValue: staff },
        {
          provide: AccesoDeLaEmpresa,
          useValue: {
            habilitado: jest.fn(() => Promise.resolve(chatHabilitado)),
          },
        },
        { provide: BandejaService, useValue: bandeja },
        { provide: BandejaGestionService, useValue: gestion },
        { provide: BandejaPresenter, useValue: presentar },
        { provide: BandejaSugerenciasService, useValue: sugerencias },
        { provide: CompanyChatSettingsService, useValue: ajustes },
        { provide: CompanyTemplatesService, useValue: plantillas },
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
    permisos = [
      'mensajes.clientes',
      'mensajes.choferes',
      'mensajes.configurar',
    ];
    chatHabilitado = true;
    bandeja.abrirDeLaPersona.mockResolvedValue({
      conversation: {},
      message: {},
      created: true,
      conversationCreated: true,
    });
    bandeja.abrirDelPersonal.mockResolvedValue({
      conversation: {},
      message: {},
      created: true,
      conversationCreated: false,
    });
    bandeja.enviar.mockResolvedValue({ message: {}, created: true });
    bandeja.editar.mockResolvedValue({});
    bandeja.borrar.mockResolvedValue({});
    bandeja.conversacion.mockResolvedValue({});
    bandeja.mensajes.mockResolvedValue({ items: [], hasMore: false });
    bandeja.leer.mockResolvedValue(undefined);
    gestion.listar.mockResolvedValue({
      items: [],
      total: 0,
      counts: { unassigned: 0, mine: 0, open: 0 },
    });
    gestion.misConversaciones.mockResolvedValue({ items: [], total: 0 });
    for (const f of ['asignar', 'cerrar', 'reabrir'] as const) {
      gestion[f].mockResolvedValue({});
    }
    gestion.crearReclamo.mockResolvedValue({
      claimId: ID,
      conversation: {},
      created: true,
    });
    gestion.difundir.mockResolvedValue({ sent: 1, conversationIds: [ID] });
    sugerencias.sugerir.mockResolvedValue({
      basadoEnSeq: 4,
      items: [
        { templateId: ID, key: 'pagos', title: 'Pagos', body: 'Hola Ana' },
      ],
    });
    ajustes.nombreDeLaEmpresa.mockResolvedValue('Gas del Sur');
    ajustes.asistenteConIaDisponible.mockResolvedValue(false);
  });

  type Metodo = 'get' | 'post' | 'patch' | 'put' | 'delete';
  const llamar = (
    metodo: Metodo,
    ruta: string,
    rol: RoleType | null,
    body?: object,
  ) => {
    const r = request(app.getHttpServer())[metodo](`/api/v2${ruta}`);
    if (rol) r.set('Authorization', 'Bearer x').set('x-rol', rol);
    return body ? r.send(body) : r;
  };
  const ADMIN = RoleType.ADMIN;
  const CLIENTE = RoleType.CUSTOMER;
  const CHOFER = RoleType.DELIVERY;
  const SUPER = RoleType.SUPER_ADMIN;

  /** Status y `code` de la respuesta. */
  const resultado = async (r: request.Test) => {
    const res = await r;
    return [res.status, (res.body as { code?: string }).code ?? null];
  };

  describe('panel: /v2/conversations', () => {
    it('GET /conversations: 200, 400, 401, 403 (rol, sin permisos de mensajes, módulo apagado)', async () => {
      expect(await resultado(llamar('get', '/conversations', ADMIN))).toEqual([
        200,
        null,
      ]);
      expect(gestion.listar).toHaveBeenCalledWith(
        expect.objectContaining({
          party: Party.COMPANY,
          canales: [Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER],
        }),
        expect.objectContaining({ limit: 20, offset: 0 }),
      );
      expect(
        await resultado(llamar('get', '/conversations?channel=x', ADMIN)),
      ).toEqual([400, null]);
      expect(
        await resultado(llamar('get', '/conversations?q=ab', ADMIN)),
      ).toEqual([400, null]);
      expect(
        await resultado(llamar('get', '/conversations?assigned=yo', ADMIN)),
      ).toEqual([400, null]);
      // `awaiting` (B3): booleano; con «sin asignar», primero las que esperan (lo ordena el servicio).
      expect(
        await resultado(
          llamar('get', '/conversations?awaiting=true&assigned=none', ADMIN),
        ),
      ).toEqual([200, null]);
      expect(gestion.listar).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ awaiting: true, assigned: 'none' }),
      );
      expect(
        await resultado(llamar('get', '/conversations?awaiting=false', ADMIN)),
      ).toEqual([200, null]);
      expect(gestion.listar).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ awaiting: false }),
      );
      for (const v of ['sí', '1', '']) {
        expect(
          (
            await resultado(
              llamar('get', `/conversations?awaiting=${v}`, ADMIN),
            )
          )[0],
        ).toBe(400);
      }
      expect(await resultado(llamar('get', '/conversations', null))).toEqual([
        401,
        null,
      ]);
      expect(await resultado(llamar('get', '/conversations', CLIENTE))).toEqual(
        [403, null],
      );
      expect(await resultado(llamar('get', '/conversations', SUPER))).toEqual([
        403,
        null,
      ]);
      permisos = ['pedidos.ver'];
      expect(await resultado(llamar('get', '/conversations', ADMIN))).toEqual([
        403,
        'PERMISSION_DENIED',
      ]);
      permisos = ['mensajes.clientes'];
      chatHabilitado = false;
      expect(await resultado(llamar('get', '/conversations', ADMIN))).toEqual([
        403,
        'MODULE_DISABLED',
      ]);
    });

    it('POST /conversations: 201 nueva, 200 existente, 400, 403, 404, 409, 429', async () => {
      const abrir = {
        channel: 'staff_customer',
        subjectType: 'general',
        customerId: ID,
        firstMessage: cuerpo,
      };
      bandeja.abrirDelPersonal.mockResolvedValueOnce({
        conversation: {},
        message: {},
        conversationCreated: true,
      });
      expect(
        await resultado(llamar('post', '/conversations', ADMIN, abrir)),
      ).toEqual([201, null]);
      expect(
        await resultado(llamar('post', '/conversations', ADMIN, abrir)),
      ).toEqual([200, null]);
      for (const malo of [
        { ...abrir, channel: 'platform_chat' },
        { ...abrir, subjectType: 'ticket' },
        { ...abrir, firstMessage: undefined },
        { ...abrir, firstMessage: { clientMessageId: 'x', body: 'Hola' } },
        { ...abrir, firstMessage: { clientMessageId: UUID, body: '' } },
        {
          ...abrir,
          firstMessage: { clientMessageId: UUID, body: 'x'.repeat(2001) },
        },
        { ...abrir, subjectType: 'order' },
      ]) {
        expect(
          (await resultado(llamar('post', '/conversations', ADMIN, malo)))[0],
        ).toBe(400);
      }
      const errores: Array<[unknown, number, string | null]> = [
        [chatDeClientesApagado(), 403, 'CUSTOMER_CHAT_DISABLED'],
        [new ConversacionNoEncontradaError(), 404, null],
        [new PlazoDelPedidoVencidoError(), 409, 'ORDER_CHAT_WINDOW_CLOSED'],
        [new PedidoSinChoferError(), 409, 'ORDER_WITHOUT_DRIVER'],
        [new RespuestaInvalidaError(), 400, 'REPLY_TO_INVALID'],
        [
          new HttpException(
            { statusCode: 429, message: 'rápido', code: 'CHAT_RATE_LIMITED' },
            429,
          ),
          429,
          'CHAT_RATE_LIMITED',
        ],
      ];
      for (const [error, status, code] of errores) {
        bandeja.abrirDelPersonal.mockRejectedValueOnce(error);
        expect(
          await resultado(llamar('post', '/conversations', ADMIN, abrir)),
        ).toEqual([status, code]);
      }
      expect(
        await resultado(llamar('post', '/conversations', null, abrir)),
      ).toEqual([401, null]);
    });

    it('POST /conversations/broadcast-drivers: 202, 400, 403 sin `mensajes.choferes`, 404', async () => {
      const lote = {
        driverIds: [ID],
        body: 'Hoy cerramos',
        clientBatchId: UUID,
      };
      expect(
        await resultado(
          llamar('post', '/conversations/broadcast-drivers', ADMIN, lote),
        ),
      ).toEqual([202, null]);
      for (const malo of [
        { ...lote, driverIds: [] },
        { ...lote, driverIds: [ID, ID] },
        { ...lote, driverIds: Array(51).fill(ID) },
        { ...lote, clientBatchId: 'x' },
        { ...lote, body: '' },
      ]) {
        expect(
          (
            await resultado(
              llamar('post', '/conversations/broadcast-drivers', ADMIN, malo),
            )
          )[0],
        ).toBe(400);
      }
      gestion.difundir.mockRejectedValueOnce(
        new (class extends HttpException {
          constructor() {
            super('ajeno', 404);
          }
        })(),
      );
      expect(
        (
          await resultado(
            llamar('post', '/conversations/broadcast-drivers', ADMIN, lote),
          )
        )[0],
      ).toBe(404);
      permisos = ['mensajes.clientes'];
      expect(
        await resultado(
          llamar('post', '/conversations/broadcast-drivers', ADMIN, lote),
        ),
      ).toEqual([403, 'PERMISSION_DENIED']);
      expect(
        await resultado(
          llamar('post', '/conversations/broadcast-drivers', null, lote),
        ),
      ).toEqual([401, null]);
    });

    it('GET /conversations/:id y /messages: 200, 400, 404', async () => {
      expect(
        await resultado(llamar('get', `/conversations/${ID}`, ADMIN)),
      ).toEqual([200, null]);
      expect(
        await resultado(llamar('get', '/conversations/abc', ADMIN)),
      ).toEqual([400, 'INVALID_ID']);
      bandeja.conversacion.mockRejectedValueOnce(
        new ConversacionNoEncontradaError(),
      );
      expect(
        await resultado(llamar('get', `/conversations/${ID}`, ADMIN)),
      ).toEqual([404, null]);
      expect(
        await resultado(
          llamar('get', `/conversations/${ID}/messages?afterSeq=0`, ADMIN),
        ),
      ).toEqual([200, null]);
      expect(
        (
          await resultado(
            llamar('get', `/conversations/${ID}/messages?limit=101`, ADMIN),
          )
        )[0],
      ).toBe(400);
      bandeja.mensajes.mockRejectedValueOnce(
        new ConversacionNoEncontradaError(),
      );
      expect(
        (
          await resultado(llamar('get', `/conversations/${ID}/messages`, ADMIN))
        )[0],
      ).toBe(404);
    });

    it('GET /conversations/:id/suggestions: 200 (con y sin sugerencias), 400, 401, 403 (rol, permiso, módulo), 404', async () => {
      const ruta = `/conversations/${ID}/suggestions`;
      const ok = await llamar('get', ruta, ADMIN);
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({
        basedOnSeq: 4,
        items: [
          { templateId: ID, key: 'pagos', title: 'Pagos', body: 'Hola Ana' },
        ],
      });
      expect(sugerencias.sugerir).toHaveBeenCalledWith(
        expect.objectContaining({
          party: Party.COMPANY,
          distributorId: 'dist-a',
        }),
        ID,
      );
      sugerencias.sugerir.mockResolvedValueOnce({
        basadoEnSeq: null,
        items: [],
      });
      const vacia = await llamar('get', ruta, ADMIN);
      expect([vacia.status, vacia.body]).toEqual([
        200,
        { basedOnSeq: null, items: [] },
      ]);
      expect(
        await resultado(llamar('get', '/conversations/abc/suggestions', ADMIN)),
      ).toEqual([400, 'INVALID_ID']);
      sugerencias.sugerir.mockRejectedValueOnce(
        new ConversacionNoEncontradaError(),
      );
      expect(await resultado(llamar('get', ruta, ADMIN))).toEqual([404, null]);
      expect(await resultado(llamar('get', ruta, null))).toEqual([401, null]);
      expect(await resultado(llamar('get', ruta, CLIENTE))).toEqual([
        403,
        null,
      ]);
      expect(await resultado(llamar('get', ruta, SUPER))).toEqual([403, null]);
      permisos = ['mensajes.configurar'];
      expect(await resultado(llamar('get', ruta, ADMIN))).toEqual([
        403,
        'PERMISSION_DENIED',
      ]);
      permisos = ['mensajes.clientes'];
      chatHabilitado = false;
      expect(await resultado(llamar('get', ruta, ADMIN))).toEqual([
        403,
        'MODULE_DISABLED',
      ]);
    });

    it('POST /conversations/:id/messages: 201, 200 reintento, 400, 404, 409, 429', async () => {
      const ruta = `/conversations/${ID}/messages`;
      expect(await resultado(llamar('post', ruta, ADMIN, cuerpo))).toEqual([
        201,
        null,
      ]);
      bandeja.enviar.mockResolvedValueOnce({ message: {}, created: false });
      expect(await resultado(llamar('post', ruta, ADMIN, cuerpo))).toEqual([
        200,
        null,
      ]);
      for (const malo of [
        { clientMessageId: UUID },
        { clientMessageId: UUID, body: 'x', templateId: 'no' },
        { clientMessageId: UUID, body: 'x', replyToSeq: 0 },
        { body: 'x' },
      ]) {
        expect((await resultado(llamar('post', ruta, ADMIN, malo)))[0]).toBe(
          400,
        );
      }
      for (const [error, status, code] of [
        [new ConversacionNoEncontradaError(), 404, null],
        [new ConversacionCerradaError(), 409, 'CONVERSATION_CLOSED'],
        [new ChatNoEscribibleError(), 409, 'CHAT_NOT_WRITABLE'],
        [
          new HttpException(
            { statusCode: 429, message: 'rápido', code: 'CHAT_RATE_LIMITED' },
            429,
          ),
          429,
          'CHAT_RATE_LIMITED',
        ],
      ] as Array<[unknown, number, string | null]>) {
        bandeja.enviar.mockRejectedValueOnce(error);
        expect(await resultado(llamar('post', ruta, ADMIN, cuerpo))).toEqual([
          status,
          code,
        ]);
      }
    });

    it('PATCH /conversations/:id/messages/:messageId: 200, 400, 403, 404, 409', async () => {
      const ruta = `/conversations/${ID}/messages/${MSG}`;
      expect(
        await resultado(llamar('patch', ruta, ADMIN, { body: 'Hola!' })),
      ).toEqual([200, null]);
      expect(
        (await resultado(llamar('patch', ruta, ADMIN, { body: '' })))[0],
      ).toBe(400);
      expect(
        (
          await resultado(
            llamar('patch', `/conversations/${ID}/messages/x`, ADMIN, {
              body: 'a',
            }),
          )
        )[0],
      ).toBe(400);
      for (const [error, status, code] of [
        [mensajeAjeno(), 403, 'MESSAGE_NOT_OWN'],
        [new ConversacionNoEncontradaError(), 404, null],
        [
          new VentanaDeEdicionVencidaError(15),
          409,
          'MESSAGE_EDIT_WINDOW_CLOSED',
        ],
        [new ConversacionCerradaError(), 409, 'CONVERSATION_CLOSED'],
      ] as Array<[unknown, number, string | null]>) {
        bandeja.editar.mockRejectedValueOnce(error);
        expect(
          await resultado(llamar('patch', ruta, ADMIN, { body: 'a' })),
        ).toEqual([status, code]);
      }
    });

    it('assign / close / reopen / read / claim: 200/201/204, 400, 403, 404, 409', async () => {
      const r = (s: string) => `/conversations/${ID}/${s}`;
      expect(
        await resultado(llamar('post', r('assign'), ADMIN, { userId: ID })),
      ).toEqual([200, null]);
      expect(
        await resultado(llamar('post', r('assign'), ADMIN, { userId: null })),
      ).toEqual([200, null]);
      expect(
        (
          await resultado(llamar('post', r('assign'), ADMIN, { userId: 'x' }))
        )[0],
      ).toBe(400);
      gestion.asignar.mockRejectedValueOnce(new AsignadoSinPermisoError());
      expect(
        await resultado(llamar('post', r('assign'), ADMIN, { userId: ID })),
      ).toEqual([400, 'ASSIGNEE_WITHOUT_PERMISSION']);
      gestion.asignar.mockRejectedValueOnce(
        new ConversacionNoEncontradaError(),
      );
      expect(
        (
          await resultado(llamar('post', r('assign'), ADMIN, { userId: ID }))
        )[0],
      ).toBe(404);
      gestion.asignar.mockRejectedValueOnce(new ConversacionCerradaError());
      expect(
        (
          await resultado(llamar('post', r('assign'), ADMIN, { userId: ID }))
        )[0],
      ).toBe(409);

      expect(await resultado(llamar('post', r('close'), ADMIN))).toEqual([
        200,
        null,
      ]);
      gestion.cerrar.mockRejectedValueOnce(new ConversacionCerradaError());
      expect(await resultado(llamar('post', r('close'), ADMIN))).toEqual([
        409,
        'CONVERSATION_CLOSED',
      ]);
      expect(await resultado(llamar('post', r('reopen'), ADMIN))).toEqual([
        200,
        null,
      ]);
      gestion.reabrir.mockRejectedValueOnce(new ConversacionNoReabribleError());
      expect(await resultado(llamar('post', r('reopen'), ADMIN))).toEqual([
        409,
        'CONVERSATION_NOT_REOPENABLE',
      ]);
      gestion.reabrir.mockRejectedValueOnce(
        new ConversacionNoEncontradaError(),
      );
      expect((await resultado(llamar('post', r('reopen'), ADMIN)))[0]).toBe(
        404,
      );

      expect(
        await resultado(llamar('post', r('read'), ADMIN, { seq: 3 })),
      ).toEqual([204, null]);
      expect(
        (await resultado(llamar('post', r('read'), ADMIN, { seq: -1 })))[0],
      ).toBe(400);

      const reclamo = { reason: 'Pérdida', description: 'Pierde gas' };
      expect(
        await resultado(llamar('post', r('claim'), ADMIN, reclamo)),
      ).toEqual([201, null]);
      expect(
        (
          await resultado(llamar('post', r('claim'), ADMIN, { reason: 'x' }))
        )[0],
      ).toBe(400);
      gestion.crearReclamo.mockResolvedValueOnce({
        claimId: ID,
        conversation: {},
        created: false,
      });
      expect(
        await resultado(llamar('post', r('claim'), ADMIN, reclamo)),
      ).toEqual([200, null]);
      gestion.crearReclamo.mockRejectedValueOnce(
        new ConversacionConReclamoError(),
      );
      expect(
        await resultado(llamar('post', r('claim'), ADMIN, reclamo)),
      ).toEqual([409, 'CONVERSATION_ALREADY_HAS_CLAIM']);
      gestion.crearReclamo.mockRejectedValueOnce(
        new ConversacionCerradaError(),
      );
      expect(
        await resultado(llamar('post', r('claim'), ADMIN, reclamo)),
      ).toEqual([409, 'CONVERSATION_CLOSED']);
      permisos = ['mensajes.choferes'];
      expect(
        await resultado(llamar('post', r('claim'), ADMIN, reclamo)),
      ).toEqual([403, 'PERMISSION_DENIED']);
    });
  });

  describe('panel: /v2/chat (configuración)', () => {
    it('settings y business-hours: 200, 400, 403 sin `mensajes.configurar`', async () => {
      expect(await resultado(llamar('get', '/chat/settings', ADMIN))).toEqual([
        200,
        null,
      ]);
      expect(
        await resultado(
          llamar('put', '/chat/settings', ADMIN, { ackEnabled: true }),
        ),
      ).toEqual([200, null]);
      expect(
        (
          await resultado(
            llamar('put', '/chat/settings', ADMIN, {
              firstResponseTargetMinutes: 2,
            }),
          )
        )[0],
      ).toBe(400);
      ajustes.actualizar.mockRejectedValueOnce(
        new VariableDePlantillaDesconocidaError(['x']),
      );
      expect(
        await resultado(
          llamar('put', '/chat/settings', ADMIN, { ackMessage: '{{x}}' }),
        ),
      ).toEqual([400, 'TEMPLATE_VARIABLE_UNKNOWN']);
      expect(
        await resultado(llamar('get', '/chat/business-hours', ADMIN)),
      ).toEqual([200, null]);
      expect(
        (
          await resultado(
            llamar('put', '/chat/business-hours', ADMIN, {
              days: [{ weekday: 9, opensAt: '09:00', closesAt: '10:00' }],
            }),
          )
        )[0],
      ).toBe(400);
      expect(
        (
          await resultado(
            llamar('put', '/chat/business-hours', ADMIN, {
              holidays: [{ date: '25/12', reason: 'Navidad' }],
            }),
          )
        )[0],
      ).toBe(400);
      permisos = ['mensajes.choferes'];
      expect(await resultado(llamar('get', '/chat/settings', ADMIN))).toEqual([
        200,
        null,
      ]);
      expect(
        await resultado(
          llamar('put', '/chat/settings', ADMIN, { ackEnabled: true }),
        ),
      ).toEqual([403, 'PERMISSION_DENIED']);
      expect(
        await resultado(
          llamar('put', '/chat/business-hours', ADMIN, { days: [] }),
        ),
      ).toEqual([403, 'PERMISSION_DENIED']);
      expect(await resultado(llamar('get', '/chat/settings', null))).toEqual([
        401,
        null,
      ]);
      chatHabilitado = false;
      expect(await resultado(llamar('get', '/chat/settings', ADMIN))).toEqual([
        403,
        'MODULE_DISABLED',
      ]);
    });

    it('settings: asistente (nombre y derivación) con los textos efectivos, 400 por cada regla', async () => {
      const leido = await llamar('get', '/chat/settings', ADMIN);
      expect(leido.status).toBe(200);
      expect(leido.body).toEqual(
        expect.objectContaining({
          assistantName: null,
          effectiveAssistantName: 'Asistente de Gas del Sur',
          handoffMessage: null,
          effectiveHandoffMessage:
            'Te paso con alguien del equipo de {{empresa.nombre}}. Te va a responder a la brevedad.',
        }),
      );
      ajustes.actualizar.mockResolvedValueOnce(
        Object.assign(ajustesDeLaBandejaPorDefecto('dist-a'), {
          assistantName: 'Gasito de {{empresa.nombre}}',
          handoffMessage: 'Ya te atiende una persona, {{cliente.nombre}}.',
        }),
      );
      const cambio = {
        assistantName: '  Gasito de {{empresa.nombre}} ',
        handoffMessage: 'Ya te atiende una persona, {{cliente.nombre}}.',
      };
      const guardado = await llamar('put', '/chat/settings', ADMIN, cambio);
      expect(guardado.status).toBe(200);
      expect(guardado.body).toEqual(
        expect.objectContaining({
          assistantName: 'Gasito de {{empresa.nombre}}',
          effectiveAssistantName: 'Gasito de Gas del Sur',
          effectiveHandoffMessage:
            'Ya te atiende una persona, {{cliente.nombre}}.',
        }),
      );
      expect(ajustes.actualizar).toHaveBeenLastCalledWith(
        'dist-a',
        'u1',
        expect.objectContaining({
          assistantName: 'Gasito de {{empresa.nombre}}',
        }),
      );
      expect(
        await resultado(
          llamar('put', '/chat/settings', ADMIN, {
            assistantName: null,
            handoffMessage: null,
          }),
        ),
      ).toEqual([200, null]);
      for (const malo of [
        { assistantName: 'A' },
        { assistantName: '   ' },
        { assistantName: 'x'.repeat(61) },
        { assistantName: 'Línea\nOtra' },
        { assistantName: 'Línea\u2028Otra' },
        { assistantName: 'Línea\u2029Otra' },
        { assistantName: 'Línea\u0085Otra' },
        // 61 caracteres para la base: «❤️» es U+2764 + U+FE0F (`@Length` lo contaría como 60).
        { assistantName: `${'x'.repeat(59)}❤️` },
        { assistantName: 7 },
        { handoffMessage: '' },
        { handoffMessage: '  ' },
        { handoffMessage: 'x'.repeat(501) },
      ]) {
        expect(
          (await resultado(llamar('put', '/chat/settings', ADMIN, malo)))[0],
        ).toBe(400);
      }
      expect(
        await resultado(
          llamar('put', '/chat/settings', ADMIN, {
            assistantName: `${'x'.repeat(58)}❤️`,
          }),
        ),
      ).toEqual([200, null]);
      ajustes.actualizar.mockRejectedValueOnce(
        new NombreDelAsistenteInvalidoError(),
      );
      expect(
        await resultado(
          llamar('put', '/chat/settings', ADMIN, { assistantName: 'Gasito' }),
        ),
      ).toEqual([400, 'ASSISTANT_NAME_INVALID']);
      ajustes.actualizar.mockRejectedValueOnce(
        new VariableDelNombreDelAsistenteError(['cliente.nombre']),
      );
      expect(
        await resultado(
          llamar('put', '/chat/settings', ADMIN, {
            assistantName: 'Hola {{cliente.nombre}}',
          }),
        ),
      ).toEqual([400, 'TEMPLATE_VARIABLE_UNKNOWN']);
      permisos = ['mensajes.clientes'];
      expect(
        await resultado(
          llamar('put', '/chat/settings', ADMIN, { assistantName: 'Gasito' }),
        ),
      ).toEqual([403, 'PERMISSION_DENIED']);
    });

    it('templates: 200, 201, 204, 400, 403, 404, 409', async () => {
      const nueva = {
        key: 'saludo',
        title: 'Saludo',
        body: 'Hola {{cliente.nombre}}',
      };
      expect(await resultado(llamar('get', '/chat/templates', ADMIN))).toEqual([
        200,
        null,
      ]);
      expect(
        (await resultado(llamar('get', '/chat/templates?channel=x', ADMIN)))[0],
      ).toBe(400);
      expect(
        await resultado(llamar('post', '/chat/templates', ADMIN, nueva)),
      ).toEqual([201, null]);
      expect(
        (
          await resultado(
            llamar('post', '/chat/templates', ADMIN, {
              ...nueva,
              key: 'Mala Clave',
            }),
          )
        )[0],
      ).toBe(400);
      plantillas.crear.mockRejectedValueOnce(
        new HttpException(
          {
            statusCode: 409,
            message: 'repetida',
            code: 'MESSAGE_TEMPLATE_KEY_TAKEN',
          },
          409,
        ),
      );
      expect(
        await resultado(llamar('post', '/chat/templates', ADMIN, nueva)),
      ).toEqual([409, 'MESSAGE_TEMPLATE_KEY_TAKEN']);
      expect(
        await resultado(
          llamar('patch', `/chat/templates/${ID}`, ADMIN, { title: 'Otro' }),
        ),
      ).toEqual([200, null]);
      plantillas.actualizar.mockRejectedValueOnce(
        new HttpException('No existe esa respuesta guardada', 404),
      );
      expect(
        (
          await resultado(
            llamar('patch', `/chat/templates/${ID}`, ADMIN, { title: 'Otro' }),
          )
        )[0],
      ).toBe(404);
      expect(
        await resultado(llamar('delete', `/chat/templates/${ID}`, ADMIN)),
      ).toEqual([204, null]);
      expect(
        (await resultado(llamar('delete', '/chat/templates/x', ADMIN)))[0],
      ).toBe(400);
      permisos = ['mensajes.clientes'];
      expect(
        await resultado(llamar('post', '/chat/templates', ADMIN, nueva)),
      ).toEqual([403, 'PERMISSION_DENIED']);
    });
  });

  describe('apps: /v2/me/conversations', () => {
    it('GET y POST: 200/201, 400, 401, 403 (panel y módulo), 404, 409, 429', async () => {
      expect(
        await resultado(llamar('get', '/me/conversations', CLIENTE)),
      ).toEqual([200, null]);
      expect(
        await resultado(llamar('get', '/me/conversations', CHOFER)),
      ).toEqual([200, null]);
      expect(gestion.misConversaciones).toHaveBeenLastCalledWith(
        expect.objectContaining({
          party: Party.DRIVER,
          canales: [Channel.STAFF_DRIVER],
        }),
        expect.anything(),
      );
      expect(
        (
          await resultado(llamar('get', '/me/conversations?status=x', CLIENTE))
        )[0],
      ).toBe(400);
      expect(
        await resultado(llamar('get', '/me/conversations', ADMIN)),
      ).toEqual([403, null]);
      expect(await resultado(llamar('get', '/me/conversations', null))).toEqual(
        [401, null],
      );
      chatHabilitado = false;
      expect(
        await resultado(llamar('get', '/me/conversations', CLIENTE)),
      ).toEqual([403, 'MODULE_DISABLED']);
      chatHabilitado = true;
      const abrir = { subjectType: 'general', firstMessage: cuerpo };
      expect(
        await resultado(llamar('post', '/me/conversations', CLIENTE, abrir)),
      ).toEqual([201, null]);
      expect(
        (
          await resultado(
            llamar('post', '/me/conversations', CLIENTE, {
              subjectType: 'general',
            }),
          )
        )[0],
      ).toBe(400);
      for (const [error, status, code] of [
        [new ConversacionNoEncontradaError(), 404, null],
        [chatDeClientesApagado(), 403, 'CUSTOMER_CHAT_DISABLED'],
        [new PlazoDelPedidoVencidoError(), 409, 'ORDER_CHAT_WINDOW_CLOSED'],
        [
          new HttpException(
            { statusCode: 429, message: 'rápido', code: 'CHAT_RATE_LIMITED' },
            429,
          ),
          429,
          'CHAT_RATE_LIMITED',
        ],
      ] as Array<[unknown, number, string | null]>) {
        bandeja.abrirDeLaPersona.mockRejectedValueOnce(error);
        expect(
          await resultado(llamar('post', '/me/conversations', CLIENTE, abrir)),
        ).toEqual([status, code]);
      }
    });

    it('mensajes, editar y leer: 200/201/204, 400, 404, 409', async () => {
      const r = `/me/conversations/${ID}`;
      expect(await resultado(llamar('get', r, CLIENTE))).toEqual([200, null]);
      expect(await resultado(llamar('get', `${r}/messages`, CLIENTE))).toEqual([
        200,
        null,
      ]);
      expect(
        (
          await resultado(
            llamar('get', `${r}/messages?afterSeq=1&beforeSeq=2`, CLIENTE),
          )
        )[0],
      ).toBe(200);
      expect(
        await resultado(llamar('post', `${r}/messages`, CLIENTE, cuerpo)),
      ).toEqual([201, null]);
      bandeja.enviar.mockRejectedValueOnce(new ConversacionCerradaError());
      expect(
        await resultado(llamar('post', `${r}/messages`, CLIENTE, cuerpo)),
      ).toEqual([409, 'CONVERSATION_CLOSED']);
      expect(
        await resultado(
          llamar('patch', `${r}/messages/${MSG}`, CLIENTE, { body: 'Hola!' }),
        ),
      ).toEqual([200, null]);
      bandeja.editar.mockRejectedValueOnce(mensajeAjeno());
      expect(
        await resultado(
          llamar('patch', `${r}/messages/${MSG}`, CLIENTE, { body: 'x' }),
        ),
      ).toEqual([403, 'MESSAGE_NOT_OWN']);
      expect(
        await resultado(llamar('post', `${r}/read`, CLIENTE, { seq: 2 })),
      ).toEqual([204, null]);
      bandeja.leer.mockRejectedValueOnce(new ConversacionNoEncontradaError());
      expect(
        (await resultado(llamar('post', `${r}/read`, CLIENTE, { seq: 2 })))[0],
      ).toBe(404);
    });

    it('DELETE de un mensaje propio (D-C23): 200 (también repetido), 400, 401, 403, 404, 409 por cada regla', async () => {
      const ruta = `/me/conversations/${ID}/messages/${MSG}`;
      expect(await resultado(llamar('delete', ruta, CLIENTE))).toEqual([
        200,
        null,
      ]);
      expect(bandeja.borrar).toHaveBeenCalledWith(
        expect.objectContaining({ party: Party.CUSTOMER, userId: 'u1' }),
        ID,
        MSG,
      );
      expect(await resultado(llamar('delete', ruta, CLIENTE))).toEqual([
        200,
        null,
      ]);
      expect(
        (
          await resultado(
            llamar('delete', `/me/conversations/${ID}/messages/x`, CLIENTE),
          )
        )[0],
      ).toBe(400);
      expect(await resultado(llamar('delete', ruta, null))).toEqual([
        401,
        null,
      ]);
      expect(await resultado(llamar('delete', ruta, ADMIN))).toEqual([
        403,
        null,
      ]);
      expect(await resultado(llamar('delete', ruta, SUPER))).toEqual([
        403,
        null,
      ]);
      for (const [error, status, code] of [
        [borradoNoPermitido(), 403, 'MESSAGE_DELETE_NOT_ALLOWED'],
        [mensajeAjeno(), 403, 'MESSAGE_NOT_OWN'],
        [new ConversacionNoEncontradaError(), 404, null],
        [
          new VentanaDeBorradoVencidaError(15),
          409,
          'MESSAGE_DELETE_WINDOW_CLOSED',
        ],
        [new MensajeDeUnPedidoError(), 409, 'MESSAGE_IN_ORDER_CONVERSATION'],
        [new MensajeYaCitadoError(), 409, 'MESSAGE_ALREADY_QUOTED'],
        [new ConversacionCerradaError(), 409, 'CONVERSATION_CLOSED'],
      ] as Array<[unknown, number, string | null]>) {
        bandeja.borrar.mockRejectedValueOnce(error);
        expect(await resultado(llamar('delete', ruta, CHOFER))).toEqual([
          status,
          code,
        ]);
      }
      chatHabilitado = false;
      expect(await resultado(llamar('delete', ruta, CLIENTE))).toEqual([
        403,
        'MODULE_DISABLED',
      ]);
    });
  });

  it('la ruta sin versión no existe: el contrato es sólo v2', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/conversations')
      .set('Authorization', 'Bearer x')
      .set('x-rol', ADMIN);
    expect(res.status).toBe(404);
  });

  it('el cupo del chat responde 429 con su código (ChatRateLimit real)', async () => {
    const redis = {
      setIfAbsent: jest.fn().mockResolvedValue(true),
      del: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue(undefined),
      incrWithExpire: jest
        .fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(11),
    };
    const cupos = new ChatRateLimit(redis as never);
    await expect(cupos.mensaje('u1', UUID, 'conv-1')).rejects.toMatchObject({
      status: 429,
    });
    // El id no queda marcado: el reintento vuelve a contar.
    expect(redis.del).toHaveBeenCalledWith(`chat:cupo:cmid:u1:${UUID}`);
  });
});
