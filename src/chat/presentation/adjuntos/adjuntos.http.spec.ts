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
import { AlcanceGuard } from '../../../common/guards/alcance.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { crearValidationPipe } from '../../../common/validation/validation-pipe';
import { AccesoDeLaEmpresa } from '../../../platform/access/acceso-de-la-empresa.service';
import { ModuloGuard } from '../../../platform/access/modulo.guard';
import {
  archivoVacio,
  demasiadoGrande,
  faltaElArchivo,
  tipoNoPermitido,
  topeDelDia,
} from '../../application/adjuntos.errors';
import { BandejaAcceso } from '../../application/bandeja-acceso';
import { BandejaAdjuntos } from '../../application/bandeja-adjuntos.service';
import { chatDeClientesApagado } from '../../application/bandeja.errors';
import { SoporteAdjuntos } from '../../application/soporte-adjuntos.service';
import { Party } from '../../domain/chat.enums';
import {
  AdjuntoEnEscaneoError,
  AdjuntoNoEncontradoError,
  AdjuntoSinVerificarError,
  ChatNoEscribibleError,
  ConversacionCerradaError,
  ConversacionNoEncontradaError,
  TicketCerradoError,
  TicketNoEncontradoError,
} from '../../domain/chat.errors';
import { BandejaPresenter } from '../bandeja.presenter';
import { ChatPresenter } from '../chat.presenter';
import { CompanySupportAttachmentsController } from './company-support-attachments.controller';
import { InboxAttachmentsController } from './inbox-attachments.controller';
import { MyAttachmentsController } from './my-attachments.controller';
import { PlatformSupportAttachmentsController } from './platform-support-attachments.controller';

const ID = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';
const MSG = '6b1e2a40-9c3d-4e5f-8a7b-1c2d3e4f5a6b';
const CMID = '0d6f0c34-8b7e-4c1a-9f3b-5a2e7d9c1b20';
const PDF = Buffer.from('%PDF-1.4\n%prueba\n');
const ENLACE = {
  url: 'https://s3/firmada',
  expiresAt: '2026-11-16T12:05:00.000Z',
  requiresAuth: false,
};

/** El cuerpo de una respuesta de error. */
const cuerpo = (r: { body: unknown }) =>
  r.body as { code?: string; message?: unknown };

/** El `AuthGuard` real reducido a headers: sin token, 401; con token, el rol pedido. */
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
 * Matriz HTTP de los adjuntos del chat (CH7): los 12 endpoints con 2xx, 400,
 * 401, 403 (rol, permiso, módulo), 404, 409, 413, 415 y 429, con los guards
 * reales, multer real (con su tope), el pipe de validación y el filtro global
 * (los `code`). Los servicios se simulan: sus reglas tienen sus propios tests.
 */
describe('Adjuntos del chat: matriz HTTP (v2)', () => {
  let app: INestApplication<Server>;
  let permisos: string[];
  let chatHabilitado: boolean;
  const bandeja = { enviar: jest.fn(), enlace: jest.fn() };
  const soporte = {
    alChatComoEmpresa: jest.fn(),
    alChatComoPlataforma: jest.fn(),
    alTicket: jest.fn(),
    enlaceDelChat: jest.fn(),
    enlaceDelTicket: jest.fn(),
  };
  const presentarBandeja = { mensaje: jest.fn() };
  const presentarChat = { mensaje: jest.fn() };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [
        InboxAttachmentsController,
        MyAttachmentsController,
        CompanySupportAttachmentsController,
        PlatformSupportAttachmentsController,
      ],
      providers: [
        BandejaAcceso,
        { provide: getDataSourceToken(), useValue: {} },
        {
          provide: StaffPermissionsService,
          useValue: {
            deUsuario: () =>
              Promise.resolve({ todos: false, rol: null, permisos }),
          },
        },
        {
          provide: AccesoDeLaEmpresa,
          useValue: { habilitado: () => Promise.resolve(chatHabilitado) },
        },
        { provide: BandejaAdjuntos, useValue: bandeja },
        { provide: SoporteAdjuntos, useValue: soporte },
        { provide: BandejaPresenter, useValue: presentarBandeja },
        { provide: ChatPresenter, useValue: presentarChat },
        Reflector,
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

  const escrito = (created: boolean) => ({
    message: { messageId: MSG },
    created,
    attachment: null,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    permisos = [
      'mensajes.clientes',
      'mensajes.choferes',
      'soporte.ver',
      'soporte.gestionar',
    ];
    chatHabilitado = true;
    bandeja.enviar.mockResolvedValue(escrito(true));
    bandeja.enlace.mockResolvedValue(ENLACE);
    soporte.alChatComoEmpresa.mockResolvedValue(escrito(true));
    soporte.alChatComoPlataforma.mockResolvedValue(escrito(true));
    soporte.alTicket.mockResolvedValue({ ...escrito(true), ticket: {} });
    soporte.enlaceDelChat.mockResolvedValue(ENLACE);
    soporte.enlaceDelTicket.mockResolvedValue(ENLACE);
    presentarBandeja.mensaje.mockResolvedValue({ id: MSG, kind: 'attachment' });
    presentarChat.mensaje.mockResolvedValue({ id: MSG, kind: 'attachment' });
  });

  const http = () => request(app.getHttpServer());

  /** Una subida multipart, con token y rol, por defecto un PDF con su `clientMessageId`. */
  const subir = (
    ruta: string,
    rol: RoleType | null,
    campos: Record<string, string> = { clientMessageId: CMID },
    archivo: Buffer | null = PDF,
  ) => {
    let r = http().post(ruta);
    if (rol) r = r.set('Authorization', 'Bearer x').set('x-rol', rol);
    for (const [k, v] of Object.entries(campos)) r = r.field(k, v);
    if (archivo) r = r.attach('file', archivo, 'remito.pdf');
    return r;
  };
  const leer = (ruta: string, rol: RoleType | null) => {
    const r = http().get(ruta);
    return rol ? r.set('Authorization', 'Bearer x').set('x-rol', rol) : r;
  };

  interface Subida {
    nombre: string;
    ruta: (id?: string) => string;
    rol: RoleType;
    rolAjeno: RoleType;
    servicio: jest.Mock;
    /** El 403 por el permiso de personal (los de plataforma lo controla el rol). */
    permiso?: string[];
    /** Atado al módulo `chat`. */
    modulo: boolean;
    /** El 409 propio del endpoint. */
    conflicto: Error;
    noExiste: Error;
  }

  const SUBIDAS: Subida[] = [
    {
      nombre: 'panel, bandeja',
      ruta: (id = ID) => `/api/v2/conversations/${id}/attachments`,
      rol: RoleType.ADMIN,
      rolAjeno: RoleType.CUSTOMER,
      servicio: bandeja.enviar,
      permiso: ['soporte.ver'],
      modulo: true,
      conflicto: new ConversacionCerradaError(),
      noExiste: new ConversacionNoEncontradaError(),
    },
    {
      nombre: 'app, cliente o chofer',
      ruta: (id = ID) => `/api/v2/me/conversations/${id}/attachments`,
      rol: RoleType.CUSTOMER,
      rolAjeno: RoleType.ADMIN,
      servicio: bandeja.enviar,
      modulo: true,
      conflicto: new ChatNoEscribibleError(),
      noExiste: new ConversacionNoEncontradaError(),
    },
    {
      nombre: 'empresa, chat con la plataforma',
      ruta: (id = ID) => `/api/v2/company/platform-chat/${id}/attachments`,
      rol: RoleType.ADMIN,
      rolAjeno: RoleType.DELIVERY,
      servicio: soporte.alChatComoEmpresa,
      permiso: ['soporte.ver'],
      modulo: false,
      conflicto: new ConversacionCerradaError(),
      noExiste: new ConversacionNoEncontradaError(),
    },
    {
      nombre: 'empresa, ticket',
      ruta: (id = ID) => `/api/v2/company/tickets/${id}/attachments`,
      rol: RoleType.ADMIN,
      rolAjeno: RoleType.CUSTOMER,
      servicio: soporte.alTicket,
      permiso: ['soporte.ver'],
      modulo: false,
      conflicto: new TicketCerradoError(),
      noExiste: new TicketNoEncontradoError(),
    },
    {
      nombre: 'plataforma, chat de una empresa',
      ruta: (id = ID) => `/api/v2/platform/chats/${id}/attachments`,
      rol: RoleType.SUPER_ADMIN,
      rolAjeno: RoleType.ADMIN,
      servicio: soporte.alChatComoPlataforma,
      modulo: false,
      conflicto: new ConversacionCerradaError(),
      noExiste: new ConversacionNoEncontradaError(),
    },
    {
      nombre: 'plataforma, ticket',
      ruta: (id = ID) => `/api/v2/platform/tickets/${id}/attachments`,
      rol: RoleType.SUPER_ADMIN,
      rolAjeno: RoleType.ADMIN,
      servicio: soporte.alTicket,
      modulo: false,
      conflicto: new TicketCerradoError(),
      noExiste: new TicketNoEncontradoError(),
    },
  ];

  describe.each(SUBIDAS)('POST subir ($nombre)', (s) => {
    it('201 con el mensaje; el archivo y los campos llegan al servicio', async () => {
      const r = await subir(s.ruta(), s.rol, {
        clientMessageId: CMID,
        caption: '  El remito  ',
      }).expect(201);
      expect(r.body).toEqual({ id: MSG, kind: 'attachment' });
      const args = s.servicio.mock.calls[0] as unknown[];
      const archivo = args.find(
        (a) => typeof a === 'object' && a !== null && 'buffer' in a,
      ) as Express.Multer.File;
      expect(archivo.buffer.equals(PDF)).toBe(true);
      expect(archivo.originalname).toBe('remito.pdf');
      expect(args.at(-1)).toEqual({
        clientMessageId: CMID,
        caption: 'El remito',
      });
    });

    it('200 en el reintento con el mismo clientMessageId', async () => {
      s.servicio.mockResolvedValue({ ...escrito(false), ticket: {} });
      await subir(s.ruta(), s.rol).expect(200);
    });

    it('400 sin clientMessageId, con uno que no es uuid o con un epígrafe de más de 500', async () => {
      const sin = await subir(s.ruta(), s.rol, {}).expect(400);
      expect(JSON.stringify(cuerpo(sin).message)).toContain(
        'Identificador del mensaje',
      );
      await subir(s.ruta(), s.rol, { clientMessageId: 'no' }).expect(400);
      const largo = await subir(s.ruta(), s.rol, {
        clientMessageId: CMID,
        caption: 'x'.repeat(501),
      }).expect(400);
      expect(JSON.stringify(cuerpo(largo).message)).toContain('Epígrafe');
      expect(s.servicio).not.toHaveBeenCalled();
    });

    it('400 con un id que no es uuid', async () => {
      await subir(s.ruta('no-es-uuid'), s.rol).expect(400);
    });

    it('400 sin archivo o vacío (`ATTACHMENT_MISSING`)', async () => {
      s.servicio.mockRejectedValueOnce(faltaElArchivo());
      const r = await subir(s.ruta(), s.rol, undefined, null).expect(400);
      expect(r.body).toMatchObject({
        code: 'ATTACHMENT_MISSING',
        message: 'Falta el archivo',
      });
      s.servicio.mockRejectedValueOnce(archivoVacio());
      await subir(s.ruta(), s.rol).expect(400);
    });

    it('401 sin token', async () => {
      await subir(s.ruta(), null).expect(401);
      expect(s.servicio).not.toHaveBeenCalled();
    });

    it('403 con un rol que no es el del endpoint', async () => {
      await subir(s.ruta(), s.rolAjeno).expect(403);
      expect(s.servicio).not.toHaveBeenCalled();
    });

    if (s.permiso) {
      it('403 sin el permiso del personal', async () => {
        permisos = s.permiso as string[];
        const r = await subir(s.ruta(), s.rol).expect(403);
        expect(cuerpo(r).code).toBe('PERMISSION_DENIED');
        expect(s.servicio).not.toHaveBeenCalled();
      });
    }

    if (s.modulo) {
      it('403 con los mensajes deshabilitados para la empresa', async () => {
        chatHabilitado = false;
        const r = await subir(s.ruta(), s.rol).expect(403);
        expect(cuerpo(r).code).toBe('MODULE_DISABLED');
        expect(cuerpo(r).message).not.toMatch(/m[oó]dulo|plan|habilitad/i);
      });
    } else {
      it('núcleo: anda con los mensajes deshabilitados para la empresa', async () => {
        chatHabilitado = false;
        await subir(s.ruta(), s.rol).expect(201);
      });
    }

    it('404 si no existe o es de otra empresa', async () => {
      s.servicio.mockRejectedValueOnce(s.noExiste);
      await subir(s.ruta(), s.rol).expect(404);
    });

    it('409 cerrado', async () => {
      s.servicio.mockRejectedValueOnce(s.conflicto);
      const r = await subir(s.ruta(), s.rol).expect(409);
      expect(cuerpo(r).code).toMatch(/CLOSED|NOT_WRITABLE/);
    });

    it('413 por el tope del canal y por multer (más de 10 MB, cortado en el stream)', async () => {
      s.servicio.mockRejectedValueOnce(
        demasiadoGrande('photo', 5 * 1024 * 1024),
      );
      const r = await subir(s.ruta(), s.rol).expect(413);
      expect(r.body).toMatchObject({
        code: 'ATTACHMENT_TOO_LARGE',
        message: 'La foto supera el máximo permitido (5 MB)',
      });
      const enorme = await subir(
        s.ruta(),
        s.rol,
        { clientMessageId: CMID },
        Buffer.alloc(10 * 1024 * 1024 + 1),
      ).expect(413);
      expect(cuerpo(enorme).message).toBe(
        'El archivo supera el máximo permitido (10 MB)',
      );
      expect(s.servicio).toHaveBeenCalledTimes(1);
    });

    it('415 con un tipo que el canal no acepta', async () => {
      s.servicio.mockRejectedValueOnce(
        tipoNoPermitido('fotos JPG, PNG o WEBP'),
      );
      const r = await subir(s.ruta(), s.rol).expect(415);
      expect(r.body).toMatchObject({
        code: 'ATTACHMENT_TYPE_NOT_ALLOWED',
        message: 'En este chat se pueden mandar fotos JPG, PNG o WEBP.',
      });
    });

    it('429 con el tope del día', async () => {
      s.servicio.mockRejectedValueOnce(topeDelDia());
      const r = await subir(s.ruta(), s.rol).expect(429);
      expect(cuerpo(r).code).toBe('ATTACHMENT_DAILY_LIMIT');
      expect(cuerpo(r).message).toContain('30 archivos hoy');
    });
  });

  interface Lectura {
    nombre: string;
    ruta: (id?: string, msg?: string) => string;
    rol: RoleType;
    rolAjeno: RoleType;
    servicio: jest.Mock;
    permiso?: string[];
    modulo: boolean;
  }

  const LECTURAS: Lectura[] = [
    {
      nombre: 'panel, bandeja',
      ruta: (id = ID, msg = MSG) =>
        `/api/v2/conversations/${id}/messages/${msg}/attachment`,
      rol: RoleType.ADMIN,
      rolAjeno: RoleType.DELIVERY,
      servicio: bandeja.enlace,
      permiso: ['soporte.ver'],
      modulo: true,
    },
    {
      nombre: 'app',
      ruta: (id = ID, msg = MSG) =>
        `/api/v2/me/conversations/${id}/messages/${msg}/attachment`,
      rol: RoleType.DELIVERY,
      rolAjeno: RoleType.ADMIN,
      servicio: bandeja.enlace,
      modulo: true,
    },
    {
      nombre: 'empresa, chat con la plataforma',
      ruta: (id = ID, msg = MSG) =>
        `/api/v2/company/platform-chat/${id}/messages/${msg}/attachment`,
      rol: RoleType.ADMIN,
      rolAjeno: RoleType.CUSTOMER,
      servicio: soporte.enlaceDelChat,
      permiso: ['mensajes.clientes'],
      modulo: false,
    },
    {
      nombre: 'empresa, ticket',
      ruta: (id = ID, msg = MSG) =>
        `/api/v2/company/tickets/${id}/messages/${msg}/attachment`,
      rol: RoleType.ADMIN,
      rolAjeno: RoleType.CUSTOMER,
      servicio: soporte.enlaceDelTicket,
      permiso: ['mensajes.clientes'],
      modulo: false,
    },
    {
      nombre: 'plataforma, chat',
      ruta: (id = ID, msg = MSG) =>
        `/api/v2/platform/chats/${id}/messages/${msg}/attachment`,
      rol: RoleType.SUPER_ADMIN,
      rolAjeno: RoleType.ADMIN,
      servicio: soporte.enlaceDelChat,
      modulo: false,
    },
    {
      nombre: 'plataforma, ticket',
      ruta: (id = ID, msg = MSG) =>
        `/api/v2/platform/tickets/${id}/messages/${msg}/attachment`,
      rol: RoleType.SUPER_ADMIN,
      rolAjeno: RoleType.ADMIN,
      servicio: soporte.enlaceDelTicket,
      modulo: false,
    },
  ];

  describe.each(LECTURAS)('GET la URL del adjunto ($nombre)', (l) => {
    it('200 con la URL firmada, su vencimiento y requiresAuth', async () => {
      const r = await leer(l.ruta(), l.rol).expect(200);
      expect(r.body).toEqual(ENLACE);
      expect(JSON.stringify(l.servicio.mock.calls[0])).toContain(MSG);
    });

    it('400 con ids que no son uuid', async () => {
      await leer(l.ruta('x'), l.rol).expect(400);
      await leer(l.ruta(ID, 'x'), l.rol).expect(400);
      expect(l.servicio).not.toHaveBeenCalled();
    });

    it('401 sin token', async () => {
      await leer(l.ruta(), null).expect(401);
    });

    it('403 con otro rol', async () => {
      await leer(l.ruta(), l.rolAjeno).expect(403);
      expect(l.servicio).not.toHaveBeenCalled();
    });

    if (l.permiso) {
      it('403 sin el permiso del personal', async () => {
        permisos = l.permiso as string[];
        await leer(l.ruta(), l.rol).expect(403);
      });
    }

    if (l.modulo) {
      it('403 con los mensajes deshabilitados para la empresa', async () => {
        chatHabilitado = false;
        const r = await leer(l.ruta(), l.rol).expect(403);
        expect(cuerpo(r).code).toBe('MODULE_DISABLED');
      });
    }

    it('404: de otra empresa, redactado o bloqueado por virus', async () => {
      l.servicio.mockRejectedValueOnce(new AdjuntoNoEncontradoError());
      const r = await leer(l.ruta(), l.rol).expect(404);
      expect(cuerpo(r).message).toBe('No existe ese archivo');
    });

    it('409 `ATTACHMENT_SCAN_PENDING` mientras el antivirus lo revisa', async () => {
      l.servicio.mockRejectedValueOnce(new AdjuntoEnEscaneoError());
      const r = await leer(l.ruta(), l.rol).expect(409);
      expect(r.body).toMatchObject({
        code: 'ATTACHMENT_SCAN_PENDING',
        message: 'Estamos verificando el archivo.',
      });
    });
  });

  it('app: un archivo sin verificar no se baja (409 `ATTACHMENT_SCAN_FAILED`)', async () => {
    bandeja.enlace.mockRejectedValueOnce(new AdjuntoSinVerificarError());
    const r = await leer(
      `/api/v2/me/conversations/${ID}/messages/${MSG}/attachment`,
      RoleType.CUSTOMER,
    ).expect(409);
    expect(cuerpo(r).code).toBe('ATTACHMENT_SCAN_FAILED');
  });

  it('app: el cliente con el chat apagado no sube (403 `CUSTOMER_CHAT_DISABLED`)', async () => {
    bandeja.enviar.mockRejectedValueOnce(chatDeClientesApagado());
    const r = await subir(
      `/api/v2/me/conversations/${ID}/attachments`,
      RoleType.CUSTOMER,
    ).expect(403);
    expect(cuerpo(r).code).toBe('CUSTOMER_CHAT_DISABLED');
  });

  it('el chofer y el cliente van con su punta; el personal, con la de la empresa', async () => {
    await subir(
      `/api/v2/me/conversations/${ID}/attachments`,
      RoleType.DELIVERY,
    ).expect(201);
    await subir(
      `/api/v2/conversations/${ID}/attachments`,
      RoleType.ADMIN,
    ).expect(201);
    const partes = bandeja.enviar.mock.calls.map(
      ([actor]) => actor as { party: Party; distributorId: string },
    );
    expect(partes.map((a) => a.party)).toEqual([Party.DRIVER, Party.COMPANY]);
    expect(partes.every((a) => a.distributorId === 'dist-a')).toBe(true);
  });

  it('el soporte: la empresa con su empresa; la plataforma, sin empresa', async () => {
    await subir(
      `/api/v2/company/tickets/${ID}/attachments`,
      RoleType.ADMIN,
    ).expect(201);
    await subir(
      `/api/v2/platform/tickets/${ID}/attachments`,
      RoleType.SUPER_ADMIN,
    ).expect(201);
    expect(
      soporte.alTicket.mock.calls.map(([actor]) => actor as object),
    ).toEqual([
      { party: Party.COMPANY, userId: 'u1', distributorId: 'dist-a' },
      { party: Party.PLATFORM, userId: 'u1', distributorId: null },
    ]);
  });
});
