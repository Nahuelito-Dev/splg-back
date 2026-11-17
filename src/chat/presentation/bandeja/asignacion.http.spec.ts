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
import { BandejaAcceso } from '../../application/bandeja-acceso';
import type { ActorDeLaBandeja } from '../../application/bandeja-acceso';
import {
  noExisteLaPersonaDelPersonal,
  sinPermiso,
} from '../../application/bandeja.errors';
import {
  ajustesDeLaBandejaPorDefecto,
  CompanyChatSettingsService,
} from '../../application/company-chat-settings.service';
import { CompanyTemplatesService } from '../../application/company-templates.service';
import type { AgenteDeLaBandeja } from '../../application/equipo-de-la-bandeja.service';
import { EstadoDelEquipoService } from '../../application/estado-del-equipo.service';
import type { EstadoDelAgente } from '../../domain/asignacion-automatica';
import { Channel } from '../../domain/chat.enums';
import type { UpdateChatSettingsDto } from '../dto/bandeja-input.dto';
import { CompanyChatAgentsController } from './company-chat-agents.controller';
import { CompanyChatConfigController } from './company-chat-config.controller';
import { MyChatStatusController } from './my-chat-status.controller';

const A = 'dist-a';
const B = 'dist-b';
const YO = '0b4c3a2e-1d7a-4b77-9d55-2a6f9e1c0b11';
const BETO = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';
const DE_B = '6b1e2a40-9c3d-4e5f-8a7b-1c2d3e4f5a6b';

/** El `AuthGuard` reducido a headers: sin token, 401; la empresa sale de `x-empresa`. */
class AuthDePrueba implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.headers.authorization) {
      throw new UnauthorizedException('Sin token o token inválido');
    }
    req.user = {
      user_id: YO,
      role: req.headers['x-rol'] as RoleType,
    } as AuthenticatedUser;
    req.distributorId = (req.headers['x-empresa'] as string | undefined) ?? A;
    return true;
  }
}

const agente = (
  userId: string,
  cambios: Partial<AgenteDeLaBandeja> = {},
): AgenteDeLaBandeja => ({
  userId,
  name: userId === YO ? 'Ana Pérez' : 'Beto Gómez',
  status: 'away',
  connected: false,
  available: false,
  maxOpen: 5,
  maxOpenOverride: null,
  openAssigned: 0,
  channels: [Channel.STAFF_CUSTOMER],
  lastAssignedAt: null,
  ...cambios,
});

/**
 * Matriz HTTP de la asignación automática (8b): el estado propio, el equipo
 * y el tope de cada persona, y los ajustes de la empresa. Guards reales de
 * rol, permiso y módulo, el pipe de validación y el filtro global. El equipo
 * vive en una base falsa por empresa: A no ve ni toca a la gente de B.
 */
describe('Asignación automática: matriz HTTP (v2)', () => {
  let app: INestApplication<Server>;
  let permisos: string[];
  let chatHabilitado: boolean;
  const equipos = new Map<string, Map<string, AgenteDeLaBandeja>>();
  const delaEmpresa = (d: string) =>
    equipos.get(d) ?? new Map<string, AgenteDeLaBandeja>();

  const estado = {
    mio: jest.fn((actor: ActorDeLaBandeja) => {
      const yo = delaEmpresa(actor.distributorId).get(actor.userId);
      return yo
        ? Promise.resolve(yo)
        : Promise.reject(sinPermiso('mensajes.clientes', 'mensajes.choferes'));
    }),
    cambiarElMio: jest.fn((actor: ActorDeLaBandeja, s: EstadoDelAgente) => {
      const yo = delaEmpresa(actor.distributorId).get(actor.userId);
      if (!yo) {
        return Promise.reject(
          sinPermiso('mensajes.clientes', 'mensajes.choferes'),
        );
      }
      yo.status = s;
      yo.available = s === 'online' && yo.connected;
      return Promise.resolve(yo);
    }),
    listar: jest.fn((d: string) =>
      Promise.resolve([...delaEmpresa(d).values()]),
    ),
    cambiarTope: jest.fn((d: string, u: string, tope: number | null) => {
      const a = delaEmpresa(d).get(u);
      if (!a) return Promise.reject(noExisteLaPersonaDelPersonal());
      a.maxOpenOverride = tope;
      a.maxOpen = tope ?? 5;
      return Promise.resolve(a);
    }),
  };
  const ajustes = {
    leer: jest.fn((d: string) =>
      Promise.resolve(ajustesDeLaBandejaPorDefecto(d)),
    ),
    actualizar: jest.fn((d: string, _u: string, dto: UpdateChatSettingsDto) =>
      Promise.resolve(
        Object.assign(
          ajustesDeLaBandejaPorDefecto(d),
          dto.autoAssignEnabled === undefined
            ? {}
            : { autoAssignEnabled: dto.autoAssignEnabled },
          dto.autoAssignMaxOpen === undefined
            ? {}
            : { autoAssignMaxOpen: dto.autoAssignMaxOpen },
        ),
      ),
    ),
    nombreDeLaEmpresa: jest.fn(() => Promise.resolve('Gas del Sur')),
    asistenteConIaDisponible: jest.fn(() => Promise.resolve(false)),
  };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [
        MyChatStatusController,
        CompanyChatAgentsController,
        CompanyChatConfigController,
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
        { provide: EstadoDelEquipoService, useValue: estado },
        { provide: CompanyChatSettingsService, useValue: ajustes },
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
    permisos = ['mensajes.clientes', 'mensajes.configurar'];
    chatHabilitado = true;
    equipos.clear();
    equipos.set(
      A,
      new Map([
        [YO, agente(YO, { connected: true })],
        [BETO, agente(BETO, { channels: [Channel.STAFF_DRIVER] })],
      ]),
    );
    equipos.set(B, new Map([[DE_B, agente(DE_B)]]));
  });

  const pedir = (
    metodo: 'get' | 'put',
    ruta: string,
    opciones: { rol?: RoleType | null; empresa?: string; cuerpo?: object } = {},
  ) => {
    let r = request(app.getHttpServer())[metodo](`/api/v2${ruta}`);
    const rol = opciones.rol === undefined ? RoleType.ADMIN : opciones.rol;
    if (rol) r = r.set('Authorization', 'Bearer x').set('x-rol', rol);
    if (opciones.empresa) r = r.set('x-empresa', opciones.empresa);
    return opciones.cuerpo ? r.send(opciones.cuerpo) : r;
  };
  const codigo = async (r: request.Test) => {
    const res = await r;
    return [res.status, (res.body as { code?: string }).code ?? null];
  };

  describe('GET/PUT /v2/me/chat-status', () => {
    it('GET: 200 con el estado propio (sin nombre ni datos de contacto)', async () => {
      const res = await pedir('get', '/me/chat-status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: 'away',
        connected: true,
        available: false,
        maxOpen: 5,
        maxOpenOverride: null,
        openAssigned: 0,
        channels: ['staff_customer'],
      });
    });

    it('PUT: 200 en línea / ausente; lo que devuelve es lo nuevo', async () => {
      const online = await pedir('put', '/me/chat-status', {
        cuerpo: { status: 'online' },
      });
      expect(online.status).toBe(200);
      expect(online.body).toMatchObject({ status: 'online', available: true });
      expect(estado.cambiarElMio).toHaveBeenCalledWith(
        expect.objectContaining({ userId: YO, distributorId: A }),
        'online',
      );
      const away = await pedir('put', '/me/chat-status', {
        cuerpo: { status: 'away' },
      });
      expect(away.body).toMatchObject({ status: 'away', available: false });
    });

    it('PUT: 400 si falta `status` o no es online/away', async () => {
      for (const cuerpo of [
        {},
        { status: 'busy' },
        { status: null },
        { status: 1 },
      ]) {
        expect((await pedir('put', '/me/chat-status', { cuerpo })).status).toBe(
          400,
        );
      }
      expect(estado.cambiarElMio).not.toHaveBeenCalled();
    });

    it('cualquiera de los dos canales alcanza; 401 sin token; 403 rol, sin canal y módulo', async () => {
      for (const p of [['mensajes.clientes'], ['mensajes.choferes']]) {
        permisos = p;
        expect((await pedir('get', '/me/chat-status')).status).toBe(200);
      }
      expect(
        await codigo(pedir('get', '/me/chat-status', { rol: null })),
      ).toEqual([401, null]);
      expect(
        (await pedir('get', '/me/chat-status', { rol: RoleType.CUSTOMER }))
          .status,
      ).toBe(403);
      permisos = ['mensajes.supervisar', 'mensajes.configurar'];
      expect(await codigo(pedir('get', '/me/chat-status'))).toEqual([
        403,
        'PERMISSION_DENIED',
      ]);
      expect(
        await codigo(
          pedir('put', '/me/chat-status', { cuerpo: { status: 'online' } }),
        ),
      ).toEqual([403, 'PERMISSION_DENIED']);
      permisos = ['mensajes.clientes'];
      chatHabilitado = false;
      expect(await codigo(pedir('get', '/me/chat-status'))).toEqual([
        403,
        'MODULE_DISABLED',
      ]);
    });

    it('con permiso de canal pero fuera del equipo (dado de baja, bloqueado): 403 PERMISSION_DENIED', async () => {
      delaEmpresa(A).delete(YO);
      expect(await codigo(pedir('get', '/me/chat-status'))).toEqual([
        403,
        'PERMISSION_DENIED',
      ]);
    });
  });

  describe('GET /v2/chat/agents', () => {
    it('200: el equipo de la empresa, sin email ni teléfono; B no ve a A', async () => {
      const res = await pedir('get', '/chat/agents');
      expect(res.status).toBe(200);
      const items = (res.body as { items: Array<Record<string, unknown>> })
        .items;
      expect(items.map((a) => a.userId)).toEqual([YO, BETO]);
      expect(Object.keys(items[0]).sort()).toEqual(
        [
          'userId',
          'name',
          'status',
          'connected',
          'available',
          'maxOpen',
          'maxOpenOverride',
          'openAssigned',
          'channels',
          'lastAssignedAt',
        ].sort(),
      );
      const deB = await pedir('get', '/chat/agents', { empresa: B });
      expect(
        (deB.body as { items: Array<{ userId: string }> }).items.map(
          (a) => a.userId,
        ),
      ).toEqual([DE_B]);
    });

    it('supervisar o configurar; 401; 403 rol, sólo de canal y módulo', async () => {
      for (const p of [['mensajes.supervisar'], ['mensajes.configurar']]) {
        permisos = p;
        expect((await pedir('get', '/chat/agents')).status).toBe(200);
      }
      expect(await codigo(pedir('get', '/chat/agents', { rol: null }))).toEqual(
        [401, null],
      );
      expect(
        (await pedir('get', '/chat/agents', { rol: RoleType.DELIVERY })).status,
      ).toBe(403);
      permisos = ['mensajes.clientes', 'mensajes.choferes'];
      expect(await codigo(pedir('get', '/chat/agents'))).toEqual([
        403,
        'PERMISSION_DENIED',
      ]);
      permisos = ['mensajes.supervisar'];
      chatHabilitado = false;
      expect(await codigo(pedir('get', '/chat/agents'))).toEqual([
        403,
        'MODULE_DISABLED',
      ]);
    });
  });

  describe('PUT /v2/chat/agents/:userId', () => {
    it('200: tope propio y `null` vuelve al de la empresa', async () => {
      const res = await pedir('put', `/chat/agents/${BETO}`, {
        cuerpo: { maxOpenOverride: 8 },
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        userId: BETO,
        maxOpen: 8,
        maxOpenOverride: 8,
      });
      const vuelta = await pedir('put', `/chat/agents/${BETO}`, {
        cuerpo: { maxOpenOverride: null },
      });
      expect(vuelta.body).toMatchObject({ maxOpen: 5, maxOpenOverride: null });
      expect(estado.cambiarTope).toHaveBeenLastCalledWith(A, BETO, null);
    });

    it('400: id que no es uuid, tope que falta, no entero o fuera de 1–50', async () => {
      expect(
        await codigo(
          pedir('put', '/chat/agents/no-es-uuid', {
            cuerpo: { maxOpenOverride: 3 },
          }),
        ),
      ).toEqual([400, 'INVALID_ID']);
      for (const cuerpo of [
        {},
        { maxOpenOverride: 0 },
        { maxOpenOverride: 51 },
        { maxOpenOverride: 2.5 },
        { maxOpenOverride: '5' },
      ]) {
        expect(
          (await pedir('put', `/chat/agents/${BETO}`, { cuerpo })).status,
        ).toBe(400);
      }
      for (const tope of [1, 50]) {
        expect(
          (
            await pedir('put', `/chat/agents/${BETO}`, {
              cuerpo: { maxOpenOverride: tope },
            })
          ).status,
        ).toBe(200);
      }
    });

    it('404: alguien de otra empresa o que no es del equipo; B no toca a la gente de A', async () => {
      expect(
        await codigo(
          pedir('put', `/chat/agents/${DE_B}`, {
            cuerpo: { maxOpenOverride: 3 },
          }),
        ),
      ).toEqual([404, null]);
      expect(
        (
          await pedir('put', `/chat/agents/${BETO}`, {
            empresa: B,
            cuerpo: { maxOpenOverride: 3 },
          })
        ).status,
      ).toBe(404);
      expect(delaEmpresa(A).get(BETO)?.maxOpenOverride).toBeNull();
    });

    it('sólo configurar: supervisar no alcanza (403); 401; módulo', async () => {
      permisos = ['mensajes.supervisar'];
      expect(
        await codigo(
          pedir('put', `/chat/agents/${BETO}`, {
            cuerpo: { maxOpenOverride: 3 },
          }),
        ),
      ).toEqual([403, 'PERMISSION_DENIED']);
      expect(
        await codigo(
          pedir('put', `/chat/agents/${BETO}`, {
            rol: null,
            cuerpo: { maxOpenOverride: 3 },
          }),
        ),
      ).toEqual([401, null]);
      permisos = ['mensajes.configurar'];
      chatHabilitado = false;
      expect(
        await codigo(
          pedir('put', `/chat/agents/${BETO}`, {
            cuerpo: { maxOpenOverride: 3 },
          }),
        ),
      ).toEqual([403, 'MODULE_DISABLED']);
      expect(estado.cambiarTope).not.toHaveBeenCalled();
    });
  });

  describe('GET/PUT /v2/chat/settings: la asignación automática', () => {
    it('GET: con la función apagada y el tope de 5 por omisión', async () => {
      const res = await pedir('get', '/chat/settings');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        autoAssignEnabled: false,
        autoAssignMaxOpen: 5,
      });
    });

    it('PUT: 200 al prenderla y fijar el tope', async () => {
      const res = await pedir('put', '/chat/settings', {
        cuerpo: { autoAssignEnabled: true, autoAssignMaxOpen: 12 },
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        autoAssignEnabled: true,
        autoAssignMaxOpen: 12,
      });
    });

    it('PUT: 400 con nulo, no booleano, no entero o fuera de 1–50', async () => {
      for (const cuerpo of [
        { autoAssignEnabled: null },
        { autoAssignEnabled: 'si' },
        { autoAssignMaxOpen: null },
        { autoAssignMaxOpen: 0 },
        { autoAssignMaxOpen: 51 },
        { autoAssignMaxOpen: 3.5 },
        { autoAssignMaxOpen: '5' },
      ]) {
        expect((await pedir('put', '/chat/settings', { cuerpo })).status).toBe(
          400,
        );
      }
      expect(ajustes.actualizar).not.toHaveBeenCalled();
    });

    it('PUT: sólo configurar (403 con un canal)', async () => {
      permisos = ['mensajes.clientes'];
      expect(
        await codigo(
          pedir('put', '/chat/settings', {
            cuerpo: { autoAssignEnabled: true },
          }),
        ),
      ).toEqual([403, 'PERMISSION_DENIED']);
    });
  });
});
