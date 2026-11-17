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
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { Server } from 'http';
import request from 'supertest';
import { plainToInstance } from 'class-transformer';
import { PermissionGuard } from '../admin/guards/permission.guard';
import { StaffPermissionsService } from '../admin/staff-permissions.service';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter';
import { AlcanceGuard } from '../common/guards/alcance.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { crearValidationPipe } from '../common/validation/validation-pipe';
import { AccesoDeLaEmpresa } from '../platform/access/acceso-de-la-empresa.service';
import { ModuloGuard } from '../platform/access/modulo.guard';
import { AssistantFaqTemplateService } from './assistant-faq-template.service';
import { AssistantFaqMapper } from './assistant-faq.mapper';
import { AssistantFaqService } from './assistant-faq.service';
import {
  claveDeEjemploOcupada,
  claveOcupada,
  ejemploInexistente,
  ejemploRepetido,
  preguntaInexistente,
  preguntaRepetida,
  topeAlcanzado,
  topeDelCatalogo,
} from './assistant.errors';
import { CompanyAssistantFaqController } from './company-assistant-faq.controller';
import { CompanyAssistantTemplateController } from './company-assistant-template.controller';
import {
  UpdateAssistantFaqDto,
  UpdatePlatformAssistantFaqDto,
} from './dto/assistant-faq.dto';
import type { AssistantFaqTemplate } from './entities/assistant-faq-template.entity';
import type { AssistantFaq } from './entities/assistant-faq.entity';
import { PlatformAssistantFaqController } from './platform-assistant-faq.controller';
import { PlatformAssistantTemplateController } from './platform-assistant-template.controller';

const EMPRESA_A = '11111111-1111-4111-8111-111111111111';
const SIN_M8 = '33333333-3333-4333-8333-333333333333';
const FAQ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESION = '44444444-4444-4444-8444-444444444444';

/**
 * Lo que hace el `AuthGuard` real, reducido a headers: sin token, 401; con
 * token, el usuario del rol pedido. El admin trae su empresa del perfil
 * (`x-distributor`); el super admin, la de su sesión de soporte
 * (`x-support-session` + `x-distributor`) o ninguna.
 */
class AuthDePrueba implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.headers.authorization) {
      throw new UnauthorizedException('Sin token o token inválido');
    }
    const rol = req.headers['x-rol'] as RoleType;
    req.user = { user_id: 'u1', role: rol } as AuthenticatedUser;
    const tenant = (req.headers['x-distributor'] as string | undefined) ?? null;
    if (rol === RoleType.SUPER_ADMIN) {
      const sesion = req.headers['x-support-session'] as string | undefined;
      req.distributorId = sesion ? tenant : null;
      if (sesion) {
        req.supportSession = {
          id: sesion,
          distributorId: tenant ?? '',
          scope: [],
          expiresAt: new Date('2099-01-01T00:00:00Z'),
        };
      }
    } else {
      req.distributorId = tenant;
    }
    return true;
  }
}

const EJEMPLO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ejemplo = (
  extra: Partial<AssistantFaqTemplate> = {},
): AssistantFaqTemplate =>
  ({
    templateId: EJEMPLO,
    key: 'medios_de_pago',
    question: '¿Qué medios de pago aceptan?',
    answer: 'Los que muestra la app.',
    position: 1,
    updatedBy: 'u1',
    createdAt: new Date('2026-11-15T12:00:00Z'),
    updatedAt: new Date('2026-11-15T12:30:00Z'),
    deletedAt: null,
    ...extra,
  }) as AssistantFaqTemplate;

const fila = (extra: Partial<AssistantFaq> = {}): AssistantFaq =>
  ({
    faqId: FAQ,
    knowledgeBaseId: 'base',
    distributorId: EMPRESA_A,
    key: null,
    question: '¿Hasta qué hora abren?',
    answer: 'Hasta las 20.',
    position: 1,
    createdBy: 'u1',
    updatedBy: 'u1',
    createdAt: new Date('2026-11-15T12:00:00Z'),
    updatedAt: new Date('2026-11-15T12:30:00Z'),
    deletedAt: null,
    ...extra,
  }) as AssistantFaq;

/**
 * Matriz HTTP de la base de conocimiento del asistente (CH-BOT B2) con los
 * guards reales en el orden de la app (roles → permisos → modo soporte →
 * módulo), el `ValidationPipe` y el filtro global (los `code`). El servicio
 * es un doble: el aislamiento por empresa lo prueba su propio spec.
 */
describe('Base de conocimiento del asistente: /v2/company/assistant/faqs y /v2/platform/assistant/faqs', () => {
  let app: INestApplication<Server>;
  const servicio = {
    listar: jest.fn(),
    crear: jest.fn(),
    actualizar: jest.fn(),
    darDeBaja: jest.fn(),
    copiarPlantillas: jest.fn(),
  };
  const catalogo = {
    listar: jest.fn(),
    listarParaEmpresa: jest.fn(),
    crear: jest.fn(),
    actualizar: jest.fn(),
    darDeBaja: jest.fn(),
  };
  /** Permisos del rol de personal del admin de prueba. */
  let permisos: string[];
  const acceso = { habilitado: jest.fn() };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [
        CompanyAssistantFaqController,
        CompanyAssistantTemplateController,
        PlatformAssistantFaqController,
        PlatformAssistantTemplateController,
      ],
      providers: [
        { provide: AssistantFaqService, useValue: servicio },
        { provide: AssistantFaqTemplateService, useValue: catalogo },
        {
          provide: StaffPermissionsService,
          useValue: {
            deUsuario: () =>
              Promise.resolve({ todos: false, rol: null, permisos }),
          },
        },
        { provide: AccesoDeLaEmpresa, useValue: acceso },
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
    acceso.habilitado.mockImplementation((id: string) =>
      Promise.resolve(id !== SIN_M8),
    );
    permisos = ['asistente.ver', 'asistente.gestionar'];
    servicio.listar.mockResolvedValue({ items: [fila()], version: 3 });
    servicio.crear.mockResolvedValue(fila());
    servicio.actualizar.mockResolvedValue(fila({ answer: 'Hasta las 21.' }));
    servicio.darDeBaja.mockResolvedValue(undefined);
    servicio.copiarPlantillas.mockResolvedValue({
      copied: 5,
      skipped: 0,
      version: 4,
    });
    catalogo.listar.mockResolvedValue([ejemplo()]);
    catalogo.listarParaEmpresa.mockResolvedValue([
      { ejemplo: ejemplo(), yaEnLaBase: true },
      {
        ejemplo: ejemplo({ key: 'zonas', question: '¿Llegan?', position: 2 }),
        yaEnLaBase: false,
      },
    ]);
    catalogo.crear.mockResolvedValue(ejemplo());
    catalogo.actualizar.mockResolvedValue(ejemplo({ answer: 'Otra.' }));
    catalogo.darDeBaja.mockResolvedValue(undefined);
  });

  type Verbo = 'get' | 'post' | 'patch' | 'delete';
  interface Quien {
    rol: RoleType | null;
    tenant?: string;
    sesion?: string;
  }
  const ADMIN_A: Quien = { rol: RoleType.ADMIN, tenant: EMPRESA_A };

  const pedir = (
    verbo: Verbo,
    ruta: string,
    quien: Quien = ADMIN_A,
    cuerpo?: object,
  ) => {
    const r = request(app.getHttpServer())[verbo](`/api/v2${ruta}`);
    if (quien.rol) r.set('Authorization', 'Bearer x').set('x-rol', quien.rol);
    if (quien.tenant) r.set('x-distributor', quien.tenant);
    if (quien.sesion) r.set('x-support-session', quien.sesion);
    return cuerpo ? r.send(cuerpo) : r;
  };

  const EMPRESA = '/company/assistant/faqs';
  const PLATAFORMA = '/platform/assistant/faqs';
  const VALIDA = {
    question: '¿Hasta qué hora abren?',
    answer: 'Hasta las 20.',
  };

  /** Las cinco rutas de la empresa, con un cuerpo válido. */
  const RUTAS_DE_EMPRESA: Array<[Verbo, string, object | undefined]> = [
    ['get', EMPRESA, undefined],
    ['post', EMPRESA, VALIDA],
    ['post', `${EMPRESA}/from-templates`, undefined],
    ['patch', `${EMPRESA}/${FAQ}`, { answer: 'x' }],
    ['delete', `${EMPRESA}/${FAQ}`, undefined],
  ];

  describe('empresa · caso feliz', () => {
    it('200 GET: las vigentes de la empresa del contexto, con versión y tope, sin datos internos', async () => {
      const r = await pedir('get', EMPRESA).expect(200);
      expect(r.body).toEqual({
        items: [
          {
            id: FAQ,
            key: null,
            question: '¿Hasta qué hora abren?',
            answer: 'Hasta las 20.',
            isDraft: false,
            position: 1,
            createdAt: '2026-11-15T12:00:00.000Z',
            updatedAt: '2026-11-15T12:30:00.000Z',
          },
        ],
        version: 3,
        limit: 200,
      });
      expect(servicio.listar).toHaveBeenCalledWith(EMPRESA_A);
    });

    it('200 GET: un borrador (sin respuesta) sale marcado, con la respuesta vacía', async () => {
      servicio.listar.mockResolvedValue({
        items: [fila({ answer: '' }), fila({ answer: '   ', position: 2 })],
        version: 4,
      });
      const r = await pedir('get', EMPRESA).expect(200);
      const items = (r.body as { items: Array<Record<string, unknown>> }).items;
      expect(items.map((i) => [i.answer, i.isDraft])).toEqual([
        ['', true],
        ['   ', true],
      ]);
    });

    it('201 POST: crea en la empresa del contexto con el usuario que la carga (texto recortado)', async () => {
      const r = await pedir('post', EMPRESA, ADMIN_A, {
        question: '  ¿Hasta qué hora abren?  ',
        answer: ' Hasta las 20. ',
      }).expect(201);
      expect(r.body).toMatchObject({ id: FAQ, key: null });
      expect(servicio.crear).toHaveBeenCalledWith(
        EMPRESA_A,
        { question: '¿Hasta qué hora abren?', answer: 'Hasta las 20.' },
        'u1',
      );
    });

    it('200 POST from-templates: copia las plantillas a la empresa del contexto', async () => {
      const r = await pedir('post', `${EMPRESA}/from-templates`).expect(200);
      expect(r.body).toEqual({ copied: 5, skipped: 0, version: 4 });
      expect(servicio.copiarPlantillas).toHaveBeenCalledWith(EMPRESA_A, 'u1');
    });

    it('200 PATCH: edita en la empresa del contexto', async () => {
      const r = await pedir('patch', `${EMPRESA}/${FAQ}`, ADMIN_A, {
        answer: 'Hasta las 21.',
      }).expect(200);
      expect(r.body).toMatchObject({ answer: 'Hasta las 21.' });
      expect(servicio.actualizar).toHaveBeenCalledWith(
        EMPRESA_A,
        FAQ,
        { answer: 'Hasta las 21.' },
        'u1',
      );
    });

    it('204 DELETE: baja lógica en la empresa del contexto', async () => {
      await pedir('delete', `${EMPRESA}/${FAQ}`).expect(204);
      expect(servicio.darDeBaja).toHaveBeenCalledWith(EMPRESA_A, FAQ, 'u1');
    });

    it('un admin con sólo asistente.ver lee pero no escribe', async () => {
      permisos = ['asistente.ver'];
      await pedir('get', EMPRESA).expect(200);
      const r = await pedir('post', EMPRESA, ADMIN_A, VALIDA).expect(403);
      expect(r.body).toMatchObject({ code: 'PERMISSION_DENIED' });
    });
  });

  describe('empresa · 400', () => {
    it.each([
      ['sin pregunta', { answer: 'x' }, /^Pregunta:/],
      ['pregunta corta', { question: '¿Ya?', answer: 'x' }, /^Pregunta:/],
      [
        'pregunta larga',
        { question: `¿${'a'.repeat(200)}?`, answer: 'x' },
        /^Pregunta:/,
      ],
      [
        'pregunta que no es texto',
        { question: 12345, answer: 'x' },
        /^Pregunta:/,
      ],
      [
        'pregunta con HTML',
        { question: '¿Abren <b>hoy</b>?', answer: 'x' },
        /^Pregunta: no puede llevar HTML/,
      ],
      ['sin respuesta', { question: '¿Abren hoy?' }, /^Respuesta:/],
      [
        'respuesta vacía (sólo espacios)',
        { question: '¿Abren hoy?', answer: '   ' },
        /^Respuesta:/,
      ],
      [
        'respuesta larga',
        { question: '¿Abren hoy?', answer: 'a'.repeat(1501) },
        /^Respuesta:/,
      ],
      [
        'respuesta con una entidad HTML',
        { question: '¿Abren hoy?', answer: 'Sí &amp; no' },
        /^Respuesta: no puede llevar HTML/,
      ],
      [
        'respuesta con un script',
        { question: '¿Abren hoy?', answer: '<script>alert(1)</script>' },
        /^Respuesta: no puede llevar HTML/,
      ],
      [
        'un campo que no corresponde (la clave la pone la copia de plantillas)',
        { ...VALIDA, key: 'mia' },
        /Clave/,
      ],
      [
        'un campo que no corresponde (plantilla)',
        { ...VALIDA, useAsTemplate: true },
        /plantilla/,
      ],
    ])('POST: %s', async (_caso, cuerpo, mensaje) => {
      const r = await pedir('post', EMPRESA, ADMIN_A, cuerpo).expect(400);
      expect((r.body as { message: string[] }).message).toEqual(
        expect.arrayContaining([expect.stringMatching(mensaje)]),
      );
      expect(servicio.crear).not.toHaveBeenCalled();
    });

    it('un «<» suelto no es HTML: «menos de < 5 kg» pasa', async () => {
      await pedir('post', EMPRESA, ADMIN_A, {
        question: '¿Tienen garrafas de < 5 kg?',
        answer: 'Sí, de 3 kg & de 4 kg.',
      }).expect(201);
    });

    it('PATCH: pregunta con HTML, pregunta corta o un campo que no corresponde', async () => {
      for (const cuerpo of [
        { question: '<p>¿Abren?</p>' },
        { question: '¿Ya?' },
        { key: 'otra' },
      ]) {
        await pedir('patch', `${EMPRESA}/${FAQ}`, ADMIN_A, cuerpo).expect(400);
      }
      expect(servicio.actualizar).not.toHaveBeenCalled();
    });

    it('PATCH y DELETE: el id no es un UUID (INVALID_ID)', async () => {
      for (const verbo of ['patch', 'delete'] as const) {
        const r = await pedir(verbo, `${EMPRESA}/no-es-uuid`, ADMIN_A, {
          answer: 'x',
        }).expect(400);
        expect(r.body).toMatchObject({ code: 'INVALID_ID' });
      }
      expect(servicio.actualizar).not.toHaveBeenCalled();
      expect(servicio.darDeBaja).not.toHaveBeenCalled();
    });

    it('un admin sin distribuidora en el contexto: MISSING_DISTRIBUTOR', async () => {
      const r = await pedir('get', EMPRESA, { rol: RoleType.ADMIN }).expect(
        400,
      );
      expect(r.body).toMatchObject({ code: 'MISSING_DISTRIBUTOR' });
    });
  });

  describe('empresa · 401 y 403', () => {
    it.each(RUTAS_DE_EMPRESA)(
      '401 %s %s sin token',
      async (verbo, ruta, cuerpo) => {
        await pedir(verbo, ruta, { rol: null }, cuerpo).expect(401);
      },
    );

    it.each(RUTAS_DE_EMPRESA)(
      '403 %s %s: chofer y cliente no entran',
      async (verbo, ruta, cuerpo) => {
        for (const rol of [RoleType.DELIVERY, RoleType.CUSTOMER]) {
          await pedir(verbo, ruta, { rol, tenant: EMPRESA_A }, cuerpo).expect(
            403,
          );
        }
      },
    );

    it.each(RUTAS_DE_EMPRESA)(
      '403 %s %s: admin sin el permiso (PERMISSION_DENIED)',
      async (verbo, ruta, cuerpo) => {
        permisos = ['pedidos.ver'];
        const r = await pedir(verbo, ruta, ADMIN_A, cuerpo).expect(403);
        expect(r.body).toMatchObject({ code: 'PERMISSION_DENIED' });
        expect((r.body as { message: string }).message).toMatch(
          /base de conocimiento del asistente/,
        );
      },
    );

    it.each(RUTAS_DE_EMPRESA)(
      '403 %s %s: empresa sin el módulo M8 (MODULE_DISABLED)',
      async (verbo, ruta, cuerpo) => {
        const r = await pedir(
          verbo,
          ruta,
          { rol: RoleType.ADMIN, tenant: SIN_M8 },
          cuerpo,
        ).expect(403);
        expect(r.body).toMatchObject({ code: 'MODULE_DISABLED' });
        expect(acceso.habilitado).toHaveBeenCalledWith(SIN_M8, 'assistant');
      },
    );

    it.each(RUTAS_DE_EMPRESA)(
      '403 %s %s: super admin sin sesión de soporte (SUPPORT_SESSION_REQUIRED)',
      async (verbo, ruta, cuerpo) => {
        const r = await pedir(
          verbo,
          ruta,
          { rol: RoleType.SUPER_ADMIN },
          cuerpo,
        ).expect(403);
        expect(r.body).toMatchObject({ code: 'SUPPORT_SESSION_REQUIRED' });
      },
    );

    it('super admin en modo soporte: lee la base de la empresa de la sesión y no escribe (SUPPORT_READ_ONLY)', async () => {
      const soporte: Quien = {
        rol: RoleType.SUPER_ADMIN,
        tenant: EMPRESA_A,
        sesion: SESION,
      };
      await pedir('get', EMPRESA, soporte).expect(200);
      expect(servicio.listar).toHaveBeenCalledWith(EMPRESA_A);
      for (const [verbo, ruta, cuerpo] of RUTAS_DE_EMPRESA.slice(1)) {
        const r = await pedir(verbo, ruta, soporte, cuerpo).expect(403);
        expect(r.body).toMatchObject({ code: 'SUPPORT_READ_ONLY' });
      }
      expect(servicio.crear).not.toHaveBeenCalled();
      expect(servicio.copiarPlantillas).not.toHaveBeenCalled();
      expect(servicio.actualizar).not.toHaveBeenCalled();
      expect(servicio.darDeBaja).not.toHaveBeenCalled();
    });
  });

  describe('empresa · 404 y 409', () => {
    it('404 PATCH y DELETE: no existe, dada de baja o de otra empresa (ASSISTANT_FAQ_NOT_FOUND)', async () => {
      servicio.actualizar.mockRejectedValue(preguntaInexistente());
      servicio.darDeBaja.mockRejectedValue(preguntaInexistente());
      for (const verbo of ['patch', 'delete'] as const) {
        const r = await pedir(verbo, `${EMPRESA}/${FAQ}`, ADMIN_A, {
          answer: 'x',
        }).expect(404);
        expect(r.body).toMatchObject({
          code: 'ASSISTANT_FAQ_NOT_FOUND',
          message: 'No existe esa pregunta frecuente',
        });
      }
    });

    it('409 POST: pregunta repetida (ASSISTANT_FAQ_DUPLICATE) y tope (ASSISTANT_FAQ_LIMIT_REACHED)', async () => {
      servicio.crear.mockRejectedValueOnce(preguntaRepetida());
      const repetida = await pedir('post', EMPRESA, ADMIN_A, VALIDA).expect(
        409,
      );
      expect(repetida.body).toMatchObject({
        code: 'ASSISTANT_FAQ_DUPLICATE',
        message: 'Ya hay una pregunta frecuente igual en la base',
      });
      servicio.crear.mockRejectedValueOnce(topeAlcanzado());
      const tope = await pedir('post', EMPRESA, ADMIN_A, VALIDA).expect(409);
      expect(tope.body).toMatchObject({ code: 'ASSISTANT_FAQ_LIMIT_REACHED' });
    });

    it('409 PATCH: la lleva a una pregunta que ya existe', async () => {
      servicio.actualizar.mockRejectedValueOnce(preguntaRepetida());
      const r = await pedir('patch', `${EMPRESA}/${FAQ}`, ADMIN_A, {
        question: '¿Otra pregunta?',
      }).expect(409);
      expect(r.body).toMatchObject({ code: 'ASSISTANT_FAQ_DUPLICATE' });
    });

    it('409 from-templates: las plantillas no entran bajo el tope', async () => {
      servicio.copiarPlantillas.mockRejectedValueOnce(topeAlcanzado(3));
      const r = await pedir('post', `${EMPRESA}/from-templates`).expect(409);
      expect(r.body).toMatchObject({ code: 'ASSISTANT_FAQ_LIMIT_REACHED' });
      expect((r.body as { message: string }).message).toMatch(/al menos 3/);
    });
  });

  describe('plataforma', () => {
    const SUPER: Quien = { rol: RoleType.SUPER_ADMIN };
    const PLANTILLA = {
      ...VALIDA,
      key: 'horario',
    };

    beforeEach(() => {
      const dePlataforma = fila({
        distributorId: null,
        key: 'horario',
      });
      servicio.listar.mockResolvedValue({ items: [dePlataforma], version: 1 });
      servicio.crear.mockResolvedValue(dePlataforma);
      servicio.actualizar.mockResolvedValue(dePlataforma);
    });

    it('200 GET: la base de OrixTech, con clave y sin marca de plantilla; no depende de ningún módulo', async () => {
      const r = await pedir('get', PLATAFORMA, SUPER).expect(200);
      expect(r.body).toEqual({
        items: [
          {
            id: FAQ,
            key: 'horario',
            question: '¿Hasta qué hora abren?',
            answer: 'Hasta las 20.',
            isDraft: false,
            position: 1,
            createdAt: '2026-11-15T12:00:00.000Z',
            updatedAt: '2026-11-15T12:30:00.000Z',
          },
        ],
        version: 1,
        limit: 200,
      });
      expect(servicio.listar).toHaveBeenCalledWith(null);
      expect(acceso.habilitado).not.toHaveBeenCalled();
    });

    it('201 POST: crea en la base de la plataforma con su clave (sin marca de plantilla)', async () => {
      const r = await pedir('post', PLATAFORMA, SUPER, PLANTILLA).expect(201);
      expect(servicio.crear).toHaveBeenCalledWith(null, PLANTILLA, 'u1');
      expect(r.body).not.toHaveProperty('useAsTemplate');
    });

    it('200 PATCH y 204 DELETE en la base de la plataforma', async () => {
      await pedir('patch', `${PLATAFORMA}/${FAQ}`, SUPER, {
        answer: 'Hasta las 21.',
      }).expect(200);
      expect(servicio.actualizar).toHaveBeenCalledWith(
        null,
        FAQ,
        { answer: 'Hasta las 21.' },
        'u1',
      );
      await pedir('delete', `${PLATAFORMA}/${FAQ}`, SUPER).expect(204);
      expect(servicio.darDeBaja).toHaveBeenCalledWith(null, FAQ, 'u1');
    });

    it('el header de una empresa no cambia de base: sigue siendo la de la plataforma', async () => {
      await pedir('get', PLATAFORMA, { ...SUPER, tenant: EMPRESA_A }).expect(
        200,
      );
      expect(servicio.listar).toHaveBeenCalledWith(null);
    });

    it.each([
      ['sin clave', VALIDA],
      ['clave con mayúsculas', { ...PLANTILLA, key: 'Horario' }],
      ['clave con espacios internos', { ...PLANTILLA, key: 'mi clave' }],
      ['clave de una letra', { ...PLANTILLA, key: 'h' }],
      [
        'marca de plantilla (ya no existe en la base de OrixTech)',
        { ...PLANTILLA, useAsTemplate: true },
      ],
      ['marca de plantilla en falso', { ...PLANTILLA, useAsTemplate: false }],
      ['pregunta con HTML', { ...PLANTILLA, question: '¿<i>Abren</i>?' }],
      ['respuesta larga', { ...PLANTILLA, answer: 'a'.repeat(1501) }],
    ])('400 POST: %s', async (_caso, cuerpo) => {
      await pedir('post', PLATAFORMA, SUPER, cuerpo).expect(400);
      expect(servicio.crear).not.toHaveBeenCalled();
    });

    it('400 PATCH: la clave no se cambia ni se manda la marca de plantilla; 400 PATCH/DELETE con id que no es UUID', async () => {
      await pedir('patch', `${PLATAFORMA}/${FAQ}`, SUPER, {
        key: 'otra',
      }).expect(400);
      const marca = await pedir('patch', `${PLATAFORMA}/${FAQ}`, SUPER, {
        useAsTemplate: false,
      }).expect(400);
      expect((marca.body as { message: string[] }).message).toEqual([
        expect.stringMatching(/plantilla/),
      ]);
      await pedir('patch', `${PLATAFORMA}/x`, SUPER, { answer: 'x' }).expect(
        400,
      );
      await pedir('delete', `${PLATAFORMA}/x`, SUPER).expect(400);
      expect(servicio.actualizar).not.toHaveBeenCalled();
      expect(servicio.darDeBaja).not.toHaveBeenCalled();
    });

    it('401 sin token', async () => {
      await pedir('get', PLATAFORMA, { rol: null }).expect(401);
      await pedir('post', PLATAFORMA, { rol: null }, PLANTILLA).expect(401);
      await pedir('patch', `${PLATAFORMA}/${FAQ}`, { rol: null }, {}).expect(
        401,
      );
      await pedir('delete', `${PLATAFORMA}/${FAQ}`, { rol: null }).expect(401);
    });

    it('403: un admin de empresa, un chofer o un cliente no entran a la base de la plataforma', async () => {
      for (const rol of [
        RoleType.ADMIN,
        RoleType.DELIVERY,
        RoleType.CUSTOMER,
      ]) {
        const quien = { rol, tenant: EMPRESA_A };
        await pedir('get', PLATAFORMA, quien).expect(403);
        await pedir('post', PLATAFORMA, quien, PLANTILLA).expect(403);
        await pedir('patch', `${PLATAFORMA}/${FAQ}`, quien, {}).expect(403);
        await pedir('delete', `${PLATAFORMA}/${FAQ}`, quien).expect(403);
      }
      expect(servicio.listar).not.toHaveBeenCalled();
    });

    it('404: no existe o no es de la plataforma (ASSISTANT_FAQ_NOT_FOUND)', async () => {
      servicio.actualizar.mockRejectedValueOnce(preguntaInexistente());
      servicio.darDeBaja.mockRejectedValueOnce(preguntaInexistente());
      const r = await pedir('patch', `${PLATAFORMA}/${FAQ}`, SUPER, {
        answer: 'x',
      }).expect(404);
      expect(r.body).toMatchObject({ code: 'ASSISTANT_FAQ_NOT_FOUND' });
      await pedir('delete', `${PLATAFORMA}/${FAQ}`, SUPER).expect(404);
    });

    it('409: clave ocupada, pregunta repetida y tope', async () => {
      servicio.crear
        .mockRejectedValueOnce(claveOcupada())
        .mockRejectedValueOnce(preguntaRepetida())
        .mockRejectedValueOnce(topeAlcanzado());
      for (const code of [
        'ASSISTANT_FAQ_KEY_TAKEN',
        'ASSISTANT_FAQ_DUPLICATE',
        'ASSISTANT_FAQ_LIMIT_REACHED',
      ]) {
        const r = await pedir('post', PLATAFORMA, SUPER, PLANTILLA).expect(409);
        expect(r.body).toMatchObject({ code });
      }
      servicio.actualizar.mockRejectedValueOnce(preguntaRepetida());
      await pedir('patch', `${PLATAFORMA}/${FAQ}`, SUPER, {
        question: '¿Otra pregunta?',
      }).expect(409);
    });
  });

  it('el mapper de la plataforma nunca devuelve una clave nula', () => {
    expect(AssistantFaqMapper.toPlatformDto(fila({ key: null })).key).toBe('');
  });
  describe('corrección 1', () => {
    const SUPER: Quien = { rol: RoleType.SUPER_ADMIN };
    const conEmoji = (largo: number) => `${'a'.repeat(largo - 2)}✔️`;
    /** Los campos con valor que recibió el servicio (los ausentes quedan `undefined`). */
    const camposCon = (m: jest.Mock): string[] =>
      Object.entries(
        (m.mock.calls[0] as unknown[])[2] as Record<string, unknown>,
      )
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k);

    beforeEach(() => {
      servicio.actualizar.mockResolvedValue(
        fila({ distributorId: null, key: 'horario' }),
      );
    });

    it('los DTO de edición no traen valores por omisión', () => {
      expect(
        Object.keys(
          plainToInstance(UpdatePlatformAssistantFaqDto, { answer: 'x' }),
        ),
      ).toEqual(['answer']);
      expect(
        Object.keys(plainToInstance(UpdateAssistantFaqDto, { answer: 'x' })),
      ).toEqual(['answer']);
    });

    it('PATCH de la plataforma con sólo la respuesta: al servicio llega sólo la respuesta', async () => {
      await pedir('patch', `${PLATAFORMA}/${FAQ}`, SUPER, {
        answer: 'Hasta las 21.',
      }).expect(200);
      expect(camposCon(servicio.actualizar)).toEqual(['answer']);
    });

    it('PATCH de la empresa con sólo la pregunta: al servicio llega sólo la pregunta', async () => {
      await pedir('patch', `${EMPRESA}/${FAQ}`, ADMIN_A, {
        question: '¿Abren el domingo?',
      }).expect(200);
      expect(camposCon(servicio.actualizar)).toEqual(['question']);
    });

    it.each([
      [
        'pregunta de 201 caracteres con un emoji',
        { question: conEmoji(201), answer: 'x' },
        /^Pregunta: tiene que tener entre 5 y 200 caracteres$/,
      ],
      [
        'respuesta de 1501 caracteres con un emoji',
        { question: '¿Abren hoy?', answer: conEmoji(1501) },
        /^Respuesta: tiene que tener entre 1 y 1500 caracteres$/,
      ],
    ])(
      '400 POST: %s (la base la rechazaría)',
      async (_caso, cuerpo, mensaje) => {
        const r = await pedir('post', EMPRESA, ADMIN_A, cuerpo).expect(400);
        expect((r.body as { message: string[] }).message).toEqual(
          expect.arrayContaining([expect.stringMatching(mensaje)]),
        );
        expect(servicio.crear).not.toHaveBeenCalled();
      },
    );

    it('201 POST: en el límite exacto contando emojis como la base', async () => {
      await pedir('post', EMPRESA, ADMIN_A, {
        question: conEmoji(200),
        answer: conEmoji(1500),
      }).expect(201);
    });

    it.each(['Sí &amp no', 'Uno &lt dos', 'Signo &#60', 'Copia &copy'])(
      '400 POST: entidad HTML sin punto y coma (%s)',
      async (answer) => {
        const r = await pedir('post', EMPRESA, ADMIN_A, {
          question: '¿Abren hoy?',
          answer,
        }).expect(400);
        expect((r.body as { message: string[] }).message).toEqual([
          expect.stringMatching(/^Respuesta: no puede llevar HTML/),
        ]);
      },
    );

    it('400 PATCH de la plataforma: entidad HTML sin punto y coma', async () => {
      await pedir('patch', `${PLATAFORMA}/${FAQ}`, SUPER, {
        question: '¿Abren &amp cierran?',
      }).expect(400);
      expect(servicio.actualizar).not.toHaveBeenCalled();
    });
  });

  describe('catálogo de preguntas de ejemplo · plataforma (/v2/platform/assistant/templates)', () => {
    const SUPER: Quien = { rol: RoleType.SUPER_ADMIN };
    const CATALOGO = '/platform/assistant/templates';
    const NUEVO = {
      key: 'medios_de_pago',
      question: '¿Qué medios de pago aceptan?',
      answer: 'Los que muestra la app.',
    };
    const RUTAS: Array<[Verbo, string, object | undefined]> = [
      ['get', CATALOGO, undefined],
      ['post', CATALOGO, NUEVO],
      ['patch', `${CATALOGO}/${EJEMPLO}`, { answer: 'Otra.' }],
      ['delete', `${CATALOGO}/${EJEMPLO}`, undefined],
    ];

    it('200 GET: el catálogo en su orden, con el tope; no depende de ningún módulo', async () => {
      const r = await pedir('get', CATALOGO, SUPER).expect(200);
      expect(r.body).toEqual({
        items: [
          {
            id: EJEMPLO,
            key: 'medios_de_pago',
            question: '¿Qué medios de pago aceptan?',
            answer: 'Los que muestra la app.',
            position: 1,
            createdAt: '2026-11-15T12:00:00.000Z',
            updatedAt: '2026-11-15T12:30:00.000Z',
          },
        ],
        limit: 200,
      });
      expect(catalogo.listar).toHaveBeenCalledWith();
      expect(servicio.listar).not.toHaveBeenCalled();
      expect(acceso.habilitado).not.toHaveBeenCalled();
    });

    it('201 POST: crea con el texto recortado y el usuario que la carga', async () => {
      const r = await pedir('post', CATALOGO, SUPER, {
        key: ' medios_de_pago ',
        question: '  ¿Qué medios de pago aceptan?  ',
        answer: ' Los que muestra la app. ',
      }).expect(201);
      expect(r.body).toMatchObject({ id: EJEMPLO, key: 'medios_de_pago' });
      expect(catalogo.crear).toHaveBeenCalledWith(NUEVO, 'u1');
      expect(servicio.crear).not.toHaveBeenCalled();
    });

    it('200 PATCH: al servicio llega sólo lo que vino', async () => {
      const r = await pedir('patch', `${CATALOGO}/${EJEMPLO}`, SUPER, {
        answer: 'Otra.',
      }).expect(200);
      expect(r.body).toMatchObject({ answer: 'Otra.' });
      expect(catalogo.actualizar).toHaveBeenCalledWith(
        EJEMPLO,
        { answer: 'Otra.' },
        'u1',
      );
      expect(
        Object.keys(
          (catalogo.actualizar.mock.calls[0] as unknown[])[1] as object,
        ),
      ).toEqual(['answer']);
    });

    it('204 DELETE: baja lógica', async () => {
      await pedir('delete', `${CATALOGO}/${EJEMPLO}`, SUPER).expect(204);
      expect(catalogo.darDeBaja).toHaveBeenCalledWith(EJEMPLO, 'u1');
    });

    it('el header de una empresa no cambia nada: el catálogo es uno solo', async () => {
      await pedir('get', CATALOGO, { ...SUPER, tenant: EMPRESA_A }).expect(200);
      expect(catalogo.listar).toHaveBeenCalledWith();
    });

    it.each([
      [
        'sin clave',
        { question: NUEVO.question, answer: NUEVO.answer },
        /^Clave:/,
      ],
      ['clave con mayúsculas', { ...NUEVO, key: 'Medios' }, /^Clave:/],
      ['clave de una letra', { ...NUEVO, key: 'm' }, /^Clave:/],
      ['clave larga', { ...NUEVO, key: 'a'.repeat(61) }, /^Clave:/],
      ['sin pregunta', { key: 'k_1', answer: 'x' }, /^Pregunta:/],
      ['pregunta corta', { ...NUEVO, question: '¿Ya?' }, /^Pregunta:/],
      [
        'pregunta con HTML',
        { ...NUEVO, question: '¿<i>Pagan</i>?' },
        /^Pregunta: no puede llevar HTML/,
      ],
      [
        'respuesta larga',
        { ...NUEVO, answer: 'a'.repeat(1501) },
        /^Respuesta:/,
      ],
      [
        'respuesta con entidad HTML',
        { ...NUEVO, answer: 'Sí &amp no' },
        /^Respuesta: no puede llevar HTML/,
      ],
      ['un campo que no corresponde', { ...NUEVO, position: 3 }, /Posición/],
    ])('400 POST: %s', async (_caso, cuerpo, mensaje) => {
      const r = await pedir('post', CATALOGO, SUPER, cuerpo).expect(400);
      expect((r.body as { message: string[] }).message).toEqual(
        expect.arrayContaining([expect.stringMatching(mensaje)]),
      );
      expect(catalogo.crear).not.toHaveBeenCalled();
    });

    it('400 PATCH: la clave no cambia, texto inválido; PATCH/DELETE con id que no es UUID (INVALID_ID)', async () => {
      for (const cuerpo of [
        { key: 'otra' },
        { question: '<p>¿Pagan?</p>' },
        { answer: '' },
      ]) {
        await pedir('patch', `${CATALOGO}/${EJEMPLO}`, SUPER, cuerpo).expect(
          400,
        );
      }
      for (const verbo of ['patch', 'delete'] as const) {
        const r = await pedir(verbo, `${CATALOGO}/x`, SUPER, {
          answer: 'x',
        }).expect(400);
        expect(r.body).toMatchObject({ code: 'INVALID_ID' });
      }
      expect(catalogo.actualizar).not.toHaveBeenCalled();
      expect(catalogo.darDeBaja).not.toHaveBeenCalled();
    });

    it.each(RUTAS)('401 %s %s sin token', async (verbo, ruta, cuerpo) => {
      await pedir(verbo, ruta, { rol: null }, cuerpo).expect(401);
    });

    it.each(RUTAS)(
      '403 %s %s: un admin de empresa, un chofer o un cliente no entran',
      async (verbo, ruta, cuerpo) => {
        for (const rol of [
          RoleType.ADMIN,
          RoleType.DELIVERY,
          RoleType.CUSTOMER,
        ]) {
          await pedir(verbo, ruta, { rol, tenant: EMPRESA_A }, cuerpo).expect(
            403,
          );
        }
        expect(catalogo.listar).not.toHaveBeenCalled();
        expect(catalogo.crear).not.toHaveBeenCalled();
      },
    );

    it('404 PATCH y DELETE: no existe o está dada de baja (ASSISTANT_TEMPLATE_NOT_FOUND)', async () => {
      catalogo.actualizar.mockRejectedValueOnce(ejemploInexistente());
      catalogo.darDeBaja.mockRejectedValueOnce(ejemploInexistente());
      for (const verbo of ['patch', 'delete'] as const) {
        const r = await pedir(verbo, `${CATALOGO}/${EJEMPLO}`, SUPER, {
          answer: 'x',
        }).expect(404);
        expect(r.body).toMatchObject({
          code: 'ASSISTANT_TEMPLATE_NOT_FOUND',
          message: 'No existe esa pregunta de ejemplo',
        });
      }
    });

    it('409 POST: clave ocupada, pregunta repetida y tope; 409 PATCH: pregunta repetida', async () => {
      catalogo.crear
        .mockRejectedValueOnce(claveDeEjemploOcupada())
        .mockRejectedValueOnce(ejemploRepetido())
        .mockRejectedValueOnce(topeDelCatalogo());
      for (const [code, mensaje] of [
        ['ASSISTANT_TEMPLATE_KEY_TAKEN', /con esa clave/],
        ['ASSISTANT_TEMPLATE_DUPLICATE', /igual en el catálogo/],
        ['ASSISTANT_TEMPLATE_LIMIT_REACHED', /200 preguntas de ejemplo/],
      ] as const) {
        const r = await pedir('post', CATALOGO, SUPER, NUEVO).expect(409);
        expect(r.body).toMatchObject({ code });
        expect((r.body as { message: string }).message).toMatch(mensaje);
      }
      catalogo.actualizar.mockRejectedValueOnce(ejemploRepetido());
      const r = await pedir('patch', `${CATALOGO}/${EJEMPLO}`, SUPER, {
        question: '¿Otra pregunta?',
      }).expect(409);
      expect(r.body).toMatchObject({ code: 'ASSISTANT_TEMPLATE_DUPLICATE' });
    });
  });

  describe('catálogo de preguntas de ejemplo · empresa (GET /v2/company/assistant/templates)', () => {
    const EJEMPLOS = '/company/assistant/templates';

    it('200: el catálogo con si la base de la empresa del contexto ya las tiene, sin ids ni fechas', async () => {
      const r = await pedir('get', EJEMPLOS).expect(200);
      expect(r.body).toEqual({
        items: [
          {
            key: 'medios_de_pago',
            question: '¿Qué medios de pago aceptan?',
            answer: 'Los que muestra la app.',
            position: 1,
            alreadyInBase: true,
          },
          {
            key: 'zonas',
            question: '¿Llegan?',
            answer: 'Los que muestra la app.',
            position: 2,
            alreadyInBase: false,
          },
        ],
      });
      expect(catalogo.listarParaEmpresa).toHaveBeenCalledWith(EMPRESA_A);
      expect(servicio.listar).not.toHaveBeenCalled();
    });

    it('200 con sólo asistente.ver, y en modo soporte (es lectura)', async () => {
      permisos = ['asistente.ver'];
      await pedir('get', EJEMPLOS).expect(200);
      await pedir('get', EJEMPLOS, {
        rol: RoleType.SUPER_ADMIN,
        tenant: EMPRESA_A,
        sesion: SESION,
      }).expect(200);
      expect(catalogo.listarParaEmpresa).toHaveBeenLastCalledWith(EMPRESA_A);
    });

    it('400: admin sin distribuidora en el contexto (MISSING_DISTRIBUTOR)', async () => {
      const r = await pedir('get', EJEMPLOS, { rol: RoleType.ADMIN }).expect(
        400,
      );
      expect(r.body).toMatchObject({ code: 'MISSING_DISTRIBUTOR' });
    });

    it('401 sin token', async () => {
      await pedir('get', EJEMPLOS, { rol: null }).expect(401);
    });

    it('403: chofer, cliente, admin sin permiso, empresa sin M8 y super admin sin sesión', async () => {
      for (const rol of [RoleType.DELIVERY, RoleType.CUSTOMER]) {
        await pedir('get', EJEMPLOS, { rol, tenant: EMPRESA_A }).expect(403);
      }
      permisos = ['pedidos.ver'];
      const sinPermiso = await pedir('get', EJEMPLOS).expect(403);
      expect(sinPermiso.body).toMatchObject({ code: 'PERMISSION_DENIED' });
      permisos = ['asistente.ver'];
      const sinModulo = await pedir('get', EJEMPLOS, {
        rol: RoleType.ADMIN,
        tenant: SIN_M8,
      }).expect(403);
      expect(sinModulo.body).toMatchObject({ code: 'MODULE_DISABLED' });
      expect((sinModulo.body as { message: string }).message).not.toMatch(
        /módulo|plan/i,
      );
      const sinSesion = await pedir('get', EJEMPLOS, {
        rol: RoleType.SUPER_ADMIN,
      }).expect(403);
      expect(sinSesion.body).toMatchObject({
        code: 'SUPPORT_SESSION_REQUIRED',
      });
      expect(catalogo.listarParaEmpresa).not.toHaveBeenCalled();
    });
  });
});
