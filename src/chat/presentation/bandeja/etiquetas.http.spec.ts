import {
  CanActivate,
  ExecutionContext,
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
import type { ActorDeLaBandeja } from '../../application/bandeja-acceso';
import { BandejaAcceso } from '../../application/bandeja-acceso';
import { BandejaEncuestaService } from '../../application/bandeja-encuesta.service';
import { BandejaEquipoService } from '../../application/bandeja-equipo.service';
import { BandejaGestionService } from '../../application/bandeja-gestion.service';
import { BandejaNotasService } from '../../application/bandeja-notas.service';
import { BandejaSugerenciasService } from '../../application/bandeja-sugerencias.service';
import { BandejaService } from '../../application/bandeja.service';
import {
  ChatLabelsService,
  etiquetaNoEncontrada,
  nombreDeEtiquetaRepetido,
  topeDeEtiquetas,
} from '../../application/chat-labels.service';
import {
  ajustesDeLaBandejaPorDefecto,
  CompanyChatSettingsService,
  plazosDeInactividad,
} from '../../application/company-chat-settings.service';
import { CompanyTemplatesService } from '../../application/company-templates.service';
import { TiempoEsperadoService } from '../../application/tiempo-esperado.service';
import { Channel } from '../../domain/chat.enums';
import { ConversacionNoEncontradaError } from '../../domain/chat.errors';
import type { UpdateChatSettingsDto } from '../dto/bandeja-input.dto';
import { BandejaPresenter } from '../bandeja.presenter';
import { CompanyChatConfigController } from './company-chat-config.controller';
import { CompanyChatLabelsController } from './company-chat-labels.controller';
import { CompanyInboxController } from './company-inbox.controller';
import { MyConversationsController } from './my-conversations.controller';
import { MyExpectedReplyController } from './my-expected-reply.controller';
import { ChatModule } from '../../chat.module';

const A = 'dist-a';
const B = 'dist-b';
const ET_A = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';
const ET_A2 = '6b1e2a40-9c3d-4e5f-8a7b-1c2d3e4f5a6b';
const ET_B = '0d6f0c34-8b7e-4c1a-9f3b-5a2e7d9c1b20';
const CONV_A = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const NO_EXISTE = '11111111-2222-4333-8444-555555555555';

/** El `AuthGuard` reducido a headers: sin token, 401; la empresa sale de `x-empresa` (o ninguna). */
class AuthDePrueba implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.headers.authorization) {
      throw new UnauthorizedException('Sin token o token inválido');
    }
    const rol = req.headers['x-rol'] as RoleType;
    req.user = { user_id: 'u1', role: rol } as AuthenticatedUser;
    const empresa = req.headers['x-empresa'] as string | undefined;
    req.distributorId = empresa === 'ninguna' ? null : (empresa ?? A);
    return true;
  }
}

const etiqueta = (labelId: string, distributorId: string, name: string) => ({
  labelId,
  distributorId,
  name,
  color: 'orange',
  createdAt: new Date('2026-11-16T12:00:00Z'),
  updatedAt: new Date('2026-11-16T12:00:00Z'),
  deletedAt: null,
});

/**
 * Matriz HTTP de la tanda 7c: el ABM de etiquetas, ponerlas en una
 * conversación, el filtro de la bandeja, el tiempo esperado de las apps y en
 * el detalle, y los plazos de inactividad en los ajustes. Guards reales de
 * rol, permiso y módulo, el pipe de validación y el filtro global. Las
 * etiquetas viven en una base falsa por empresa: B no ve ni usa las de A.
 */
describe('Etiquetas, tiempo esperado e inactividad: matriz HTTP (v2)', () => {
  let app: INestApplication<Server>;
  let permisos: string[];
  let chatHabilitado: boolean;
  const base = new Map<string, ReturnType<typeof etiqueta>[]>();
  const delaEmpresa = (d: string) => base.get(d) ?? [];

  const etiquetas = {
    listar: jest.fn((d: string) => Promise.resolve(delaEmpresa(d))),
    crear: jest.fn((d: string, dto: { name: string; color: string }) => {
      if (delaEmpresa(d).length >= 50) return Promise.reject(topeDeEtiquetas());
      if (delaEmpresa(d).some((l) => l.name === dto.name)) {
        return Promise.reject(nombreDeEtiquetaRepetido());
      }
      return Promise.resolve({ ...etiqueta(ET_A2, d, dto.name), ...dto });
    }),
    actualizar: jest.fn(
      (d: string, id: string, dto: { name?: string; color?: string }) => {
        const l = delaEmpresa(d).find((x) => x.labelId === id);
        return l
          ? Promise.resolve({ ...l, ...dto })
          : Promise.reject(etiquetaNoEncontrada());
      },
    ),
    darDeBaja: jest.fn((d: string, id: string) =>
      delaEmpresa(d).some((x) => x.labelId === id)
        ? Promise.resolve()
        : Promise.reject(etiquetaNoEncontrada()),
    ),
    ponerEnConversacion: jest.fn(
      (actor: ActorDeLaBandeja, id: string, ids: string[]) => {
        if (actor.distributorId !== A || id !== CONV_A) {
          return Promise.reject(new ConversacionNoEncontradaError());
        }
        const propias = new Set(
          delaEmpresa(actor.distributorId).map((l) => l.labelId),
        );
        if (!ids.every((x) => propias.has(x))) {
          return Promise.reject(etiquetaNoEncontrada());
        }
        return Promise.resolve({
          conversationId: id,
          channel: Channel.STAFF_CUSTOMER,
        });
      },
    ),
  };
  const esperado = {
    delCanal: jest.fn((_d: string, canal: Channel) =>
      Promise.resolve({
        enabled: true,
        openNow: true,
        minutes: canal === Channel.STAFF_DRIVER ? 5 : 15,
        basis: 'history',
        nextOpenAt: null,
        text: `Solemos responder en ~${canal === Channel.STAFF_DRIVER ? 5 : 15} min`,
      }),
    ),
  };
  const ajustes = {
    leer: jest.fn((d: string) =>
      Promise.resolve(ajustesDeLaBandejaPorDefecto(d)),
    ),
    actualizar: jest.fn((d: string, _u: string, dto: UpdateChatSettingsDto) =>
      Promise.resolve(
        Object.assign(
          ajustesDeLaBandejaPorDefecto(d),
          plazosDeInactividad(
            ajustesDeLaBandejaPorDefecto(d),
            dto,
            new Date('2026-11-16T12:00:00Z'),
          ),
          dto.expectedReplyEnabled === undefined
            ? {}
            : { expectedReplyEnabled: dto.expectedReplyEnabled },
        ),
      ),
    ),
    nombreDeLaEmpresa: jest.fn(() => Promise.resolve('Gas del Sur')),
    asistenteConIaDisponible: jest.fn(() => Promise.resolve(false)),
  };
  const bandeja = {
    conversacion: jest.fn(() =>
      Promise.resolve({
        conversationId: CONV_A,
        channel: Channel.STAFF_DRIVER,
      }),
    ),
  };
  const gestion = {
    listar: jest.fn(() =>
      Promise.resolve({
        items: [],
        total: 0,
        counts: { unassigned: 0, mine: 0, open: 0 },
      }),
    ),
  };
  const presentar = {
    conversacion: jest.fn(() =>
      Promise.resolve({ id: CONV_A, labels: [{ id: ET_A }] }),
    ),
    conversaciones: jest.fn(() => Promise.resolve([])),
  };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [
        CompanyChatLabelsController,
        CompanyInboxController,
        CompanyChatConfigController,
        // El mismo orden que en `ChatModule`.
        MyExpectedReplyController,
        MyConversationsController,
      ],
      providers: [
        BandejaAcceso,
        { provide: getDataSourceToken(), useValue: {} },
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
        { provide: ChatLabelsService, useValue: etiquetas },
        { provide: TiempoEsperadoService, useValue: esperado },
        { provide: CompanyChatSettingsService, useValue: ajustes },
        { provide: BandejaService, useValue: bandeja },
        { provide: BandejaGestionService, useValue: gestion },
        { provide: BandejaPresenter, useValue: presentar },
        { provide: BandejaSugerenciasService, useValue: {} },
        { provide: BandejaEquipoService, useValue: {} },
        { provide: BandejaNotasService, useValue: {} },
        { provide: BandejaEncuestaService, useValue: {} },
        { provide: CompanyTemplatesService, useValue: {} },
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
    base.clear();
    base.set(A, [etiqueta(ET_A, A, 'Envíos')]);
    base.set(B, [etiqueta(ET_B, B, 'Pagos de B')]);
  });

  const pedir = (
    metodo: 'get' | 'post' | 'patch' | 'put' | 'delete',
    ruta: string,
    opciones: { rol?: RoleType | null; empresa?: string; cuerpo?: object } = {},
  ) => {
    let r = request(app.getHttpServer())[metodo](`/api/v2${ruta}`);
    const rol = opciones.rol === undefined ? RoleType.ADMIN : opciones.rol;
    if (rol) r = r.set('Authorization', 'Bearer x').set('x-rol', rol);
    if (opciones.empresa) r = r.set('x-empresa', opciones.empresa);
    return opciones.cuerpo ? r.send(opciones.cuerpo) : r;
  };
  const estado = async (r: request.Test) => {
    const res = await r;
    return [res.status, (res.body as { code?: string }).code ?? null];
  };

  describe('GET/POST/PATCH/DELETE /v2/chat/labels', () => {
    it('GET: 200 con las de la empresa; B no ve las de A', async () => {
      const deA = await pedir('get', '/chat/labels');
      expect(deA.status).toBe(200);
      expect(deA.body).toEqual({
        items: [
          {
            id: ET_A,
            name: 'Envíos',
            color: 'orange',
            createdAt: '2026-11-16T12:00:00.000Z',
            updatedAt: '2026-11-16T12:00:00.000Z',
          },
        ],
      });
      const deB = await pedir('get', '/chat/labels', { empresa: B });
      expect((deB.body as { items: Array<{ id: string }> }).items).toEqual([
        expect.objectContaining({ id: ET_B }),
      ]);
    });

    it('GET: leer con cualquiera de los permisos de mensajes (también supervisar); 401, 403 rol, sin permisos y módulo', async () => {
      for (const p of [
        ['mensajes.clientes'],
        ['mensajes.choferes'],
        ['mensajes.supervisar'],
        ['mensajes.configurar'],
      ]) {
        permisos = p;
        expect((await pedir('get', '/chat/labels')).status).toBe(200);
      }
      expect(await estado(pedir('get', '/chat/labels', { rol: null }))).toEqual(
        [401, null],
      );
      expect(
        (await pedir('get', '/chat/labels', { rol: RoleType.CUSTOMER })).status,
      ).toBe(403);
      permisos = ['pedidos.ver'];
      expect(await estado(pedir('get', '/chat/labels'))).toEqual([
        403,
        'PERMISSION_DENIED',
      ]);
      permisos = ['mensajes.configurar'];
      chatHabilitado = false;
      expect(await estado(pedir('get', '/chat/labels'))).toEqual([
        403,
        'MODULE_DISABLED',
      ]);
    });

    it('POST: 201; 400 por nombre y color; 403 sin `mensajes.configurar`; 409 nombre y tope', async () => {
      const ok = await pedir('post', '/chat/labels', {
        cuerpo: { name: 'Urgente', color: 'red' },
      });
      expect(ok.status).toBe(201);
      expect(ok.body).toEqual(
        expect.objectContaining({ name: 'Urgente', color: 'red' }),
      );
      expect(etiquetas.crear).toHaveBeenCalledWith(A, {
        name: 'Urgente',
        color: 'red',
      });
      for (const cuerpo of [
        {},
        { name: 'Sin color' },
        { name: 'Hex', color: '#ff0000' },
        { name: '', color: 'red' },
        { name: '   ', color: 'red' },
        { name: 'x'.repeat(31), color: 'red' },
        { name: 'Dos\nlíneas', color: 'red' },
        { name: 12, color: 'red' },
        { name: 'Ok', color: 'red', extra: 1 },
      ]) {
        expect((await pedir('post', '/chat/labels', { cuerpo })).status).toBe(
          400,
        );
      }
      const malo = await pedir('post', '/chat/labels', {
        cuerpo: { name: 'Hex', color: '#ff0000' },
      });
      expect((malo.body as { message: string }).message).toContain(
        'Elegí un color de la lista',
      );
      expect(etiquetas.crear).toHaveBeenCalledTimes(1);

      expect(
        await estado(
          pedir('post', '/chat/labels', {
            cuerpo: { name: 'Envíos', color: 'red' },
          }),
        ),
      ).toEqual([409, 'CHAT_LABEL_NAME_TAKEN']);
      base.set(
        A,
        Array.from({ length: 50 }, (_, i) => etiqueta(`e-${i}`, A, `E${i}`)),
      );
      expect(
        await estado(
          pedir('post', '/chat/labels', {
            cuerpo: { name: 'Otra', color: 'red' },
          }),
        ),
      ).toEqual([409, 'CHAT_LABEL_LIMIT_REACHED']);

      permisos = ['mensajes.clientes', 'mensajes.choferes'];
      expect(
        await estado(
          pedir('post', '/chat/labels', {
            cuerpo: { name: 'X', color: 'red' },
          }),
        ),
      ).toEqual([403, 'PERMISSION_DENIED']);
      expect(
        (
          await pedir('post', '/chat/labels', {
            rol: null,
            cuerpo: { name: 'X', color: 'red' },
          })
        ).status,
      ).toBe(401);
    });

    it('PATCH: 200; 400 id y datos; 403; 404 de otra empresa', async () => {
      const ok = await pedir('patch', `/chat/labels/${ET_A}`, {
        cuerpo: { color: 'green' },
      });
      expect(ok.status).toBe(200);
      expect((ok.body as { color: string }).color).toBe('green');
      // `null` no es «no cambiar»: 400, nunca un 500.
      for (const cuerpo of [
        { name: null },
        { color: null },
        { name: '', color: 'red' },
        { name: 'Dos\nlíneas' },
      ]) {
        expect([
          JSON.stringify(cuerpo),
          (await pedir('patch', `/chat/labels/${ET_A}`, { cuerpo })).status,
        ]).toEqual([JSON.stringify(cuerpo), 400]);
      }
      // Sólo el nombre o sólo el color, sí.
      expect(
        (
          await pedir('patch', `/chat/labels/${ET_A}`, {
            cuerpo: { name: 'Envíos express' },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await pedir('patch', '/chat/labels/no-uuid', {
            cuerpo: { color: 'red' },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await pedir('patch', `/chat/labels/${ET_A}`, {
            cuerpo: { color: 'fucsia' },
          })
        ).status,
      ).toBe(400);
      expect(
        await estado(
          pedir('patch', `/chat/labels/${ET_B}`, { cuerpo: { color: 'red' } }),
        ),
      ).toEqual([404, 'CHAT_LABEL_NOT_FOUND']);
      permisos = ['mensajes.supervisar'];
      expect(
        (
          await pedir('patch', `/chat/labels/${ET_A}`, {
            cuerpo: { color: 'red' },
          })
        ).status,
      ).toBe(403);
    });

    it('DELETE: 204; 400; 403; 404 de otra empresa', async () => {
      expect((await pedir('delete', `/chat/labels/${ET_A}`)).status).toBe(204);
      expect((await pedir('delete', '/chat/labels/x')).status).toBe(400);
      expect(await estado(pedir('delete', `/chat/labels/${ET_B}`))).toEqual([
        404,
        'CHAT_LABEL_NOT_FOUND',
      ]);
      expect(etiquetas.darDeBaja).toHaveBeenLastCalledWith(A, ET_B);
      permisos = ['mensajes.clientes'];
      expect((await pedir('delete', `/chat/labels/${ET_A}`)).status).toBe(403);
    });
  });

  describe('PUT /v2/conversations/:id/labels', () => {
    it('200 con la conversación y sus etiquetas', async () => {
      const r = await pedir('put', `/conversations/${CONV_A}/labels`, {
        cuerpo: { labelIds: [ET_A] },
      });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ id: CONV_A, labels: [{ id: ET_A }] });
      expect(etiquetas.ponerEnConversacion).toHaveBeenCalledWith(
        expect.objectContaining({ distributorId: A }),
        CONV_A,
        [ET_A],
      );
      expect(
        (
          await pedir('put', `/conversations/${CONV_A}/labels`, {
            cuerpo: { labelIds: [] },
          })
        ).status,
      ).toBe(200);
    });

    it('400: id, falta la lista, más de 5, repetidas, no uuid', async () => {
      for (const [ruta, cuerpo] of [
        ['/conversations/x/labels', { labelIds: [] }],
        [`/conversations/${CONV_A}/labels`, {}],
        [`/conversations/${CONV_A}/labels`, { labelIds: ET_A }],
        [
          `/conversations/${CONV_A}/labels`,
          {
            labelIds: [
              ET_A,
              ET_A2,
              ET_B,
              NO_EXISTE,
              CONV_A,
              NO_EXISTE.replace('5555', '6666'),
            ],
          },
        ],
        [`/conversations/${CONV_A}/labels`, { labelIds: [ET_A, ET_A] }],
        [`/conversations/${CONV_A}/labels`, { labelIds: ['envios'] }],
      ] as const) {
        expect([
          JSON.stringify(cuerpo),
          (await pedir('put', ruta, { cuerpo })).status,
        ]).toEqual([JSON.stringify(cuerpo), 400]);
      }
      const seis = await pedir('put', `/conversations/${CONV_A}/labels`, {
        cuerpo: {
          labelIds: Array.from({ length: 6 }, (_, i) => `${i}${ET_A.slice(1)}`),
        },
      });
      expect((seis.body as { message: string }).message).toContain(
        'Una conversación lleva hasta 5 etiquetas',
      );
      expect(etiquetas.ponerEnConversacion).not.toHaveBeenCalled();
    });

    it('401, 403 (rol, sin permisos del canal, módulo)', async () => {
      const cuerpo = { labelIds: [ET_A] };
      const ruta = `/conversations/${CONV_A}/labels`;
      expect((await pedir('put', ruta, { rol: null, cuerpo })).status).toBe(
        401,
      );
      expect(
        (await pedir('put', ruta, { rol: RoleType.CUSTOMER, cuerpo })).status,
      ).toBe(403);
      permisos = ['mensajes.configurar'];
      expect(await estado(pedir('put', ruta, { cuerpo }))).toEqual([
        403,
        'PERMISSION_DENIED',
      ]);
      permisos = ['mensajes.clientes'];
      chatHabilitado = false;
      expect(await estado(pedir('put', ruta, { cuerpo }))).toEqual([
        403,
        'MODULE_DISABLED',
      ]);
    });

    it('404: la conversación de otra empresa; una etiqueta de otra empresa', async () => {
      expect(
        (
          await pedir('put', `/conversations/${CONV_A}/labels`, {
            empresa: B,
            cuerpo: { labelIds: [ET_B] },
          })
        ).status,
      ).toBe(404);
      expect(
        await estado(
          pedir('put', `/conversations/${CONV_A}/labels`, {
            cuerpo: { labelIds: [ET_A, ET_B] },
          }),
        ),
      ).toEqual([404, 'CHAT_LABEL_NOT_FOUND']);
    });
  });

  describe('GET /v2/conversations?labelId y el detalle', () => {
    it('`labelId` llega al servicio; uno que no es uuid → 400', async () => {
      expect(
        (await pedir('get', `/conversations?labelId=${ET_A}`)).status,
      ).toBe(200);
      expect(gestion.listar).toHaveBeenCalledWith(
        expect.objectContaining({ distributorId: A }),
        expect.objectContaining({ labelId: ET_A }),
      );
      expect((await pedir('get', '/conversations?labelId=envios')).status).toBe(
        400,
      );
    });

    it('el detalle trae el tiempo esperado del canal de la conversación', async () => {
      const r = await pedir('get', `/conversations/${CONV_A}`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        id: CONV_A,
        labels: [{ id: ET_A }],
        expectedReply: {
          enabled: true,
          openNow: true,
          minutes: 5,
          basis: 'history',
          nextOpenAt: null,
          text: 'Solemos responder en ~5 min',
        },
      });
      expect(esperado.delCanal).toHaveBeenCalledWith(A, Channel.STAFF_DRIVER);
    });
  });

  describe('GET /v2/me/conversations/expected-reply', () => {
    it('200: el cliente, el de clientes de la empresa del `X-Distributor`; el chofer, el de choferes', async () => {
      const cliente = await pedir('get', '/me/conversations/expected-reply', {
        rol: RoleType.CUSTOMER,
        empresa: B,
      });
      expect(cliente.status).toBe(200);
      expect(cliente.body).toEqual(
        expect.objectContaining({
          minutes: 15,
          text: 'Solemos responder en ~15 min',
        }),
      );
      expect(esperado.delCanal).toHaveBeenLastCalledWith(
        B,
        Channel.STAFF_CUSTOMER,
      );
      const chofer = await pedir('get', '/me/conversations/expected-reply', {
        rol: RoleType.DELIVERY,
      });
      expect((chofer.body as { minutes: number }).minutes).toBe(5);
      expect(esperado.delCanal).toHaveBeenLastCalledWith(
        A,
        Channel.STAFF_DRIVER,
      );
    });

    it('en `ChatModule` se registra antes que `MyConversationsController` (si no, `:id` se la queda)', () => {
      const controladores = Reflect.getMetadata(
        'controllers',
        ChatModule,
      ) as unknown[];
      expect(controladores.indexOf(MyExpectedReplyController)).toBeGreaterThan(
        -1,
      );
      expect(controladores.indexOf(MyExpectedReplyController)).toBeLessThan(
        controladores.indexOf(MyConversationsController),
      );
    });

    it('no la toma `:id` (no es un 400 por uuid)', async () => {
      expect(
        (
          await pedir('get', '/me/conversations/expected-reply', {
            rol: RoleType.CUSTOMER,
          })
        ).status,
      ).toBe(200);
      expect(bandeja.conversacion).not.toHaveBeenCalled();
    });

    it('400 sin `X-Distributor`; 401; 403 (panel, módulo)', async () => {
      expect(
        await estado(
          pedir('get', '/me/conversations/expected-reply', {
            rol: RoleType.CUSTOMER,
            empresa: 'ninguna',
          }),
        ),
      ).toEqual([400, 'MISSING_DISTRIBUTOR']);
      expect(
        (await pedir('get', '/me/conversations/expected-reply', { rol: null }))
          .status,
      ).toBe(401);
      expect(
        (await pedir('get', '/me/conversations/expected-reply')).status,
      ).toBe(403);
      chatHabilitado = false;
      expect(
        await estado(
          pedir('get', '/me/conversations/expected-reply', {
            rol: RoleType.CUSTOMER,
          }),
        ),
      ).toEqual([403, 'MODULE_DISABLED']);
    });
  });

  describe('PUT /v2/chat/settings: inactividad y tiempo esperado', () => {
    it('200 con los campos nuevos en la respuesta', async () => {
      const r = await pedir('put', '/chat/settings', {
        cuerpo: {
          inactivityCloseMinutes: 120,
          inactivityWarningMinutes: 15,
          expectedReplyEnabled: false,
        },
      });
      expect(r.status).toBe(200);
      expect(r.body).toEqual(
        expect.objectContaining({
          inactivityCloseMinutes: 120,
          inactivityWarningMinutes: 15,
          inactivityEnabledAt: '2026-11-16T12:00:00.000Z',
          expectedReplyEnabled: false,
        }),
      );
      const leer = await pedir('get', '/chat/settings');
      expect(leer.body).toEqual(
        expect.objectContaining({
          inactivityCloseMinutes: null,
          inactivityWarningMinutes: null,
          expectedReplyEnabled: true,
        }),
      );
    });

    it('400: fuera de rango, no enteros, aviso sin cierre o no anterior al cierre, `null` en el interruptor', async () => {
      for (const cuerpo of [
        { inactivityCloseMinutes: 29 },
        { inactivityCloseMinutes: 10081 },
        { inactivityCloseMinutes: 45.5 },
        { inactivityCloseMinutes: '60' },
        { inactivityCloseMinutes: 60, inactivityWarningMinutes: 4 },
        { inactivityCloseMinutes: 3000, inactivityWarningMinutes: 1441 },
        { inactivityCloseMinutes: 60, inactivityWarningMinutes: 60 },
        { inactivityWarningMinutes: 10 },
        { expectedReplyEnabled: null },
        { expectedReplyEnabled: 'si' },
      ]) {
        expect([
          JSON.stringify(cuerpo),
          (await pedir('put', '/chat/settings', { cuerpo })).status,
        ]).toEqual([JSON.stringify(cuerpo), 400]);
      }
    });

    it('403 sin `mensajes.configurar`', async () => {
      permisos = ['mensajes.clientes'];
      expect(
        await estado(
          pedir('put', '/chat/settings', {
            cuerpo: { inactivityCloseMinutes: 60 },
          }),
        ),
      ).toEqual([403, 'PERMISSION_DENIED']);
    });
  });
});
