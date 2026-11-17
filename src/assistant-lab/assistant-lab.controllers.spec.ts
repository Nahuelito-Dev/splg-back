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
import { ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import type { Server } from 'http';
import request from 'supertest';
import { PermissionGuard } from '../admin/guards/permission.guard';
import { StaffPermissionsService } from '../admin/staff-permissions.service';
import { preguntaRepetida, topeAlcanzado } from '../assistant/assistant.errors';
import type { AssistantFaq } from '../assistant/entities/assistant-faq.entity';
import { MotivoDeDerivacion } from '../assistant-ai/asistente-ia.dominio';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter';
import { AlcanceGuard } from '../common/guards/alcance.guard';
import { AppThrottlerGuard } from '../common/guards/app-throttler.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { crearValidationPipe } from '../common/validation/validation-pipe';
import { AccesoDeLaEmpresa } from '../platform/access/acceso-de-la-empresa.service';
import { ModuloGuard } from '../platform/access/modulo.guard';
import type { VistaPrevia } from './assistant-lab.dominio';
import {
  casoInexistente,
  casoRepetido,
  clienteInexistente,
  corridaEnCurso,
  corridaReciente,
  grupoInexistente,
  idDeGrupoInvalido,
  sinCasos,
  sinCorridas,
  topeDeCasos,
  topeDePruebas,
} from './assistant-lab.errors';
import { CompanyAssistantLabController } from './company-assistant-lab.controller';
import type { AssistantRegressionCase } from './entities/assistant-regression-case.entity';
import type { AssistantRegressionRun } from './entities/assistant-regression-run.entity';
import { PlatformAssistantLabController } from './platform-assistant-lab.controller';
import { PreguntasSinRespuestaService } from './preguntas-sin-respuesta.service';
import { ProbadorService } from './probador.service';
import { RegresionService } from './regresion.service';

const EMPRESA_A = '11111111-1111-4111-8111-111111111111';
const SIN_M8 = '33333333-3333-4333-8333-333333333333';
const SESION = '44444444-4444-4444-8444-444444444444';
const CLIENTE = '55555555-5555-4555-8555-555555555555';
const CASO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GRUPO = '3f2a9c0d1b7e4a5f8c6d2e1f0a9b8c7d';

/** Lo que hace el `AuthGuard` real, reducido a headers (como en la base de conocimiento). */
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

const VISTA: VistaPrevia = {
  answer: 'Abrimos de 8 a 20.',
  wouldHandOff: false,
  handOffReason: null,
  handOffReasonLabel: null,
  handOffCause: null,
  handOffCauseLabel: null,
  sources: [{ type: 'faq', id: 'faq-1', title: '¿Horario?' }],
  layer: 'ai',
  assistantEnabled: true,
};

const borrador = (extra: Partial<AssistantFaq> = {}): AssistantFaq =>
  ({
    faqId: 'faq-nueva',
    knowledgeBaseId: 'base',
    distributorId: EMPRESA_A,
    key: null,
    question: '¿Hacen envíos a Garupá?',
    answer: '',
    position: 7,
    createdAt: new Date('2026-11-16T12:00:00Z'),
    updatedAt: new Date('2026-11-16T12:00:00Z'),
    deletedAt: null,
    ...extra,
  }) as AssistantFaq;

const caso = (
  extra: Partial<AssistantRegressionCase> = {},
): AssistantRegressionCase =>
  ({
    caseId: CASO,
    distributorId: EMPRESA_A,
    question: '¿Hasta qué hora abren?',
    expected: 'answer',
    mustMention: ['20'],
    createdBy: 'u1',
    updatedBy: 'u1',
    createdAt: new Date('2026-11-16T12:00:00Z'),
    updatedAt: new Date('2026-11-16T12:30:00Z'),
    deletedAt: null,
    ...extra,
  }) as AssistantRegressionCase;

const corrida = (
  extra: Partial<AssistantRegressionRun> = {},
): AssistantRegressionRun =>
  ({
    runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    distributorId: EMPRESA_A,
    status: 'running',
    total: 2,
    passed: 0,
    failed: 0,
    errored: 0,
    results: [],
    startedBy: 'u1',
    startedAt: new Date('2026-11-16T13:00:00Z'),
    finishedAt: null,
    ...extra,
  }) as AssistantRegressionRun;

/**
 * Matriz HTTP del probador, las preguntas sin respuesta y el lote de
 * regresión (7b), con los guards reales en el orden de la app (throttler →
 * roles → permisos → modo soporte → módulo), el `ValidationPipe` y el filtro
 * global. Los servicios son dobles: el aislamiento y las reglas los prueban
 * sus propios specs.
 */
describe('Probador, preguntas sin respuesta y lote de regresión: /v2/company/assistant/* y /v2/platform/assistant/*', () => {
  let app: INestApplication<Server>;
  const probador = {
    deLaEmpresa: jest.fn(),
    deLaPlataforma: jest.fn(),
  };
  const sinRespuesta = {
    listar: jest.fn(),
    crearPregunta: jest.fn(),
    descartar: jest.fn(),
  };
  const regresion = {
    listar: jest.fn(),
    crear: jest.fn(),
    actualizar: jest.fn(),
    darDeBaja: jest.fn(),
    iniciar: jest.fn(),
    ultima: jest.fn(),
  };
  let permisos: string[];
  const acceso = { habilitado: jest.fn() };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [
        CompanyAssistantLabController,
        PlatformAssistantLabController,
      ],
      providers: [
        { provide: ProbadorService, useValue: probador },
        { provide: PreguntasSinRespuestaService, useValue: sinRespuesta },
        { provide: RegresionService, useValue: regresion },
        {
          provide: StaffPermissionsService,
          useValue: {
            deUsuario: () =>
              Promise.resolve({ todos: false, rol: null, permisos }),
          },
        },
        { provide: AccesoDeLaEmpresa, useValue: acceso },
        { provide: APP_GUARD, useClass: AppThrottlerGuard },
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

  /** Cada test, desde otra IP: el cupo de 20 pruebas por minuto no se arrastra. */
  let ip = 0;
  beforeEach(() => {
    ip += 1;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    acceso.habilitado.mockImplementation((id: string) =>
      Promise.resolve(id !== SIN_M8),
    );
    permisos = ['asistente.ver', 'asistente.gestionar'];
    probador.deLaEmpresa.mockResolvedValue(VISTA);
    probador.deLaPlataforma.mockResolvedValue(VISTA);
    sinRespuesta.listar.mockResolvedValue({
      from: '2026-10-18',
      to: '2026-11-16',
      items: [
        {
          id: GRUPO,
          question: '¿Hacen envíos a Garupá?',
          count: 3,
          firstSeenAt: new Date('2026-11-10T12:00:00Z'),
          lastSeenAt: new Date('2026-11-15T12:00:00Z'),
        },
      ],
      truncated: false,
    });
    sinRespuesta.crearPregunta.mockResolvedValue({
      faq: borrador(),
      creada: true,
    });
    sinRespuesta.descartar.mockResolvedValue(undefined);
    regresion.listar.mockResolvedValue([caso()]);
    regresion.crear.mockResolvedValue(caso());
    regresion.actualizar.mockResolvedValue(caso({ mustMention: ['20', 'hs'] }));
    regresion.darDeBaja.mockResolvedValue(undefined);
    regresion.iniciar.mockResolvedValue(corrida());
    regresion.ultima.mockResolvedValue(
      corrida({
        status: 'finished',
        passed: 1,
        failed: 1,
        finishedAt: new Date('2026-11-16T13:01:00Z'),
      }),
    );
  });

  type Verbo = 'get' | 'post' | 'patch' | 'delete';
  interface Quien {
    rol: RoleType | null;
    tenant?: string;
    sesion?: string;
  }
  const ADMIN_A: Quien = { rol: RoleType.ADMIN, tenant: EMPRESA_A };
  const SUPER: Quien = { rol: RoleType.SUPER_ADMIN };

  const pedir = (
    verbo: Verbo,
    ruta: string,
    quien: Quien = ADMIN_A,
    cuerpo?: object,
    query?: Record<string, string>,
  ) => {
    const r = request(app.getHttpServer())[verbo](`/api/v2${ruta}`);
    // El cupo cuenta por sesión (el hash del token): cada test, la suya.
    if (quien.rol) {
      r.set('Authorization', `Bearer sesion-${ip}`).set('x-rol', quien.rol);
    }
    if (quien.tenant) r.set('x-distributor', quien.tenant);
    if (quien.sesion) r.set('x-support-session', quien.sesion);
    if (query) r.query(query);
    return cuerpo ? r.send(cuerpo) : r;
  };

  const PREGUNTA = { question: '¿Llegan a Garupá?' };
  const CASO_VALIDO = {
    question: '¿Hasta qué hora abren?',
    expected: 'answer',
    mustMention: ['20'],
  };

  /** Las rutas de la empresa, con un cuerpo válido y el permiso que piden. */
  const RUTAS: Array<[Verbo, string, object | undefined, string]> = [
    [
      'post',
      '/company/assistant/preview',
      { question: '¿Abren?' },
      'gestionar',
    ],
    ['get', '/company/assistant/unanswered', undefined, 'gestionar'],
    [
      'post',
      `/company/assistant/unanswered/${GRUPO}/faq`,
      PREGUNTA,
      'gestionar',
    ],
    [
      'post',
      `/company/assistant/unanswered/${GRUPO}/dismiss`,
      undefined,
      'gestionar',
    ],
    ['get', '/company/assistant/regression/cases', undefined, 'ver'],
    ['post', '/company/assistant/regression/cases', CASO_VALIDO, 'gestionar'],
    [
      'patch',
      `/company/assistant/regression/cases/${CASO}`,
      { expected: 'handoff' },
      'gestionar',
    ],
    [
      'delete',
      `/company/assistant/regression/cases/${CASO}`,
      undefined,
      'gestionar',
    ],
    ['post', '/company/assistant/regression/run', undefined, 'gestionar'],
    ['get', '/company/assistant/regression/runs/last', undefined, 'ver'],
  ];

  describe('empresa · probador', () => {
    it('200: lo que contestaría, de la empresa del contexto y con quién prueba', async () => {
      const r = await pedir('post', '/company/assistant/preview', ADMIN_A, {
        question: '  ¿Hasta qué hora abren?  ',
      }).expect(200);
      expect(r.body).toEqual({
        answer: 'Abrimos de 8 a 20.',
        wouldHandOff: false,
        handOffReason: null,
        handOffReasonLabel: null,
        handOffCause: null,
        handOffCauseLabel: null,
        sources: [{ type: 'faq', id: 'faq-1', title: '¿Horario?' }],
        layer: 'ai',
        assistantEnabled: true,
      });
      expect(probador.deLaEmpresa).toHaveBeenCalledWith({
        distributorId: EMPRESA_A,
        question: '¿Hasta qué hora abren?',
        customerId: undefined,
        actorUserId: 'u1',
      });
    });

    it('200: con un cliente, se lo pasa; derivación con su motivo', async () => {
      probador.deLaEmpresa.mockResolvedValueOnce({
        ...VISTA,
        answer: null,
        wouldHandOff: true,
        handOffReason: MotivoDeDerivacion.REQUESTED,
        handOffReasonLabel: 'El asistente no pudo resolverlo',
        sources: [],
      });
      const r = await pedir('post', '/company/assistant/preview', ADMIN_A, {
        question: '¿Y mi pedido?',
        customerId: CLIENTE,
      }).expect(200);
      expect(r.body).toMatchObject({
        answer: null,
        wouldHandOff: true,
        handOffReason: 'requested',
      });
      expect(probador.deLaEmpresa).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: CLIENTE }),
      );
    });

    it.each([
      ['sin pregunta', {}],
      ['pregunta vacía', { question: '   ' }],
      ['pregunta de más de 2000', { question: 'a'.repeat(2001) }],
      ['pregunta que no es texto', { question: 5 }],
      ['customerId que no es uuid', { question: '¿Y?', customerId: 'x' }],
      ['campo de más', { question: '¿Y?', distributorId: EMPRESA_A }],
    ])('400: %s', async (_caso, cuerpo) => {
      await pedir('post', '/company/assistant/preview', ADMIN_A, cuerpo).expect(
        400,
      );
      expect(probador.deLaEmpresa).not.toHaveBeenCalled();
    });

    it('404: el cliente no es de la empresa', async () => {
      probador.deLaEmpresa.mockRejectedValueOnce(clienteInexistente());
      const r = await pedir('post', '/company/assistant/preview', ADMIN_A, {
        question: '¿Y mi pedido?',
        customerId: CLIENTE,
      }).expect(404);
      expect(r.body).toMatchObject({
        code: 'ASSISTANT_PREVIEW_CUSTOMER_NOT_FOUND',
      });
    });

    it('429: se terminó el cupo de pruebas del mes (ASSISTANT_TEST_QUOTA_REACHED)', async () => {
      probador.deLaEmpresa.mockRejectedValueOnce(topeDePruebas());
      const r = await pedir('post', '/company/assistant/preview', ADMIN_A, {
        question: '¿Abren?',
      }).expect(429);
      expect(r.body).toMatchObject({ code: 'ASSISTANT_TEST_QUOTA_REACHED' });
    });

    it('429: más de 20 pruebas por minuto (por sesión: otra sesión sigue)', async () => {
      for (let i = 0; i < 20; i += 1) {
        await pedir('post', '/company/assistant/preview', ADMIN_A, {
          question: '¿Abren?',
        }).expect(200);
      }
      await pedir('post', '/company/assistant/preview', ADMIN_A, {
        question: '¿Abren?',
      }).expect(429);
      expect(probador.deLaEmpresa).toHaveBeenCalledTimes(20);
      ip += 1000;
      await pedir('post', '/company/assistant/preview', ADMIN_A, {
        question: '¿Abren?',
      }).expect(200);
    });
  });

  describe('empresa · preguntas sin respuesta', () => {
    it('200 GET: los grupos de la empresa del contexto, con el período', async () => {
      const r = await pedir(
        'get',
        '/company/assistant/unanswered',
        ADMIN_A,
        undefined,
        { from: '2026-10-18', to: '2026-11-16' },
      ).expect(200);
      expect(r.body).toEqual({
        from: '2026-10-18',
        to: '2026-11-16',
        items: [
          {
            id: GRUPO,
            question: '¿Hacen envíos a Garupá?',
            count: 3,
            firstSeenAt: '2026-11-10T12:00:00.000Z',
            lastSeenAt: '2026-11-15T12:00:00.000Z',
          },
        ],
        truncated: false,
      });
      expect(sinRespuesta.listar).toHaveBeenCalledWith(
        EMPRESA_A,
        '2026-10-18',
        '2026-11-16',
      );
    });

    it.each([
      ['fecha que no es AAAA-MM-DD', { from: '18/10/2026' }],
      ['fecha que no existe', { to: '2026-02-30' }],
      ['parámetro desconocido', { channel: 'staff_customer' }],
    ])('400 GET: %s', async (_caso, query) => {
      await pedir(
        'get',
        '/company/assistant/unanswered',
        ADMIN_A,
        undefined,
        query,
      ).expect(400);
      expect(sinRespuesta.listar).not.toHaveBeenCalled();
    });

    it('201 POST faq: borrador (isDraft) en la base de la empresa, con la pregunta que confirmó la persona', async () => {
      const r = await pedir(
        'post',
        `/company/assistant/unanswered/${GRUPO}/faq`,
        ADMIN_A,
        { question: ' ¿Llegan a Garupá? ' },
      ).expect(201);
      expect(r.body).toEqual({
        id: 'faq-nueva',
        key: null,
        question: '¿Hacen envíos a Garupá?',
        answer: '',
        isDraft: true,
        position: 7,
        createdAt: '2026-11-16T12:00:00.000Z',
        updatedAt: '2026-11-16T12:00:00.000Z',
      });
      expect(sinRespuesta.crearPregunta).toHaveBeenCalledWith(
        EMPRESA_A,
        GRUPO,
        '¿Llegan a Garupá?',
        'u1',
      );
    });

    it('200 POST faq: el grupo ya tenía su pregunta vigente, devuelve esa', async () => {
      sinRespuesta.crearPregunta.mockResolvedValueOnce({
        faq: borrador({ answer: 'Sí, los martes.' }),
        creada: false,
      });
      const r = await pedir(
        'post',
        `/company/assistant/unanswered/${GRUPO}/faq`,
        ADMIN_A,
        PREGUNTA,
      ).expect(200);
      expect(r.body).toMatchObject({ id: 'faq-nueva', isDraft: false });
    });

    it('400 POST faq: sin pregunta (es obligatoria: la confirma la persona), corta, con HTML o un campo de más', async () => {
      for (const cuerpo of [
        undefined,
        {},
        { question: '¿Y?' },
        { question: '<b>¿Llegan?</b>' },
        { ...PREGUNTA, answer: 'Sí' },
      ]) {
        await pedir(
          'post',
          `/company/assistant/unanswered/${GRUPO}/faq`,
          ADMIN_A,
          cuerpo,
        ).expect(400);
      }
      expect(sinRespuesta.crearPregunta).not.toHaveBeenCalled();
    });

    it('400 POST faq y dismiss: el id no es de un grupo (INVALID_ID)', async () => {
      sinRespuesta.crearPregunta.mockRejectedValueOnce(idDeGrupoInvalido());
      sinRespuesta.descartar.mockRejectedValueOnce(idDeGrupoInvalido());
      for (const accion of ['faq', 'dismiss']) {
        const r = await pedir(
          'post',
          `/company/assistant/unanswered/nada/${accion}`,
          ADMIN_A,
          PREGUNTA,
        ).expect(400);
        expect(r.body).toMatchObject({ code: 'INVALID_ID' });
      }
    });

    it('404 POST faq y dismiss: no hay nada pendiente con ese id (o es de otra empresa)', async () => {
      sinRespuesta.crearPregunta.mockRejectedValueOnce(grupoInexistente());
      sinRespuesta.descartar.mockRejectedValueOnce(grupoInexistente());
      for (const accion of ['faq', 'dismiss']) {
        const r = await pedir(
          'post',
          `/company/assistant/unanswered/${GRUPO}/${accion}`,
          ADMIN_A,
          PREGUNTA,
        ).expect(404);
        expect(r.body).toMatchObject({
          code: 'ASSISTANT_UNANSWERED_NOT_FOUND',
        });
      }
    });

    it('409 POST faq: pregunta repetida o base llena', async () => {
      sinRespuesta.crearPregunta.mockRejectedValueOnce(preguntaRepetida());
      const repetida = await pedir(
        'post',
        `/company/assistant/unanswered/${GRUPO}/faq`,
        ADMIN_A,
        PREGUNTA,
      ).expect(409);
      expect(repetida.body).toMatchObject({ code: 'ASSISTANT_FAQ_DUPLICATE' });
      sinRespuesta.crearPregunta.mockRejectedValueOnce(topeAlcanzado());
      const llena = await pedir(
        'post',
        `/company/assistant/unanswered/${GRUPO}/faq`,
        ADMIN_A,
        PREGUNTA,
      ).expect(409);
      expect(llena.body).toMatchObject({
        code: 'ASSISTANT_FAQ_LIMIT_REACHED',
      });
    });

    it('204 POST dismiss: descarta el grupo de la empresa del contexto', async () => {
      await pedir(
        'post',
        `/company/assistant/unanswered/${GRUPO}/dismiss`,
      ).expect(204);
      expect(sinRespuesta.descartar).toHaveBeenCalledWith(
        EMPRESA_A,
        GRUPO,
        'u1',
      );
    });
  });

  describe('empresa · lote de regresión', () => {
    it('200 GET casos: los de la empresa del contexto, con el tope', async () => {
      const r = await pedir(
        'get',
        '/company/assistant/regression/cases',
      ).expect(200);
      expect(r.body).toEqual({
        items: [
          {
            id: CASO,
            question: '¿Hasta qué hora abren?',
            expected: 'answer',
            mustMention: ['20'],
            createdAt: '2026-11-16T12:00:00.000Z',
            updatedAt: '2026-11-16T12:30:00.000Z',
          },
        ],
        limit: 100,
      });
      expect(regresion.listar).toHaveBeenCalledWith(EMPRESA_A);
    });

    it('201 POST caso: en la empresa del contexto, con quién lo carga', async () => {
      await pedir('post', '/company/assistant/regression/cases', ADMIN_A, {
        ...CASO_VALIDO,
        question: '  ¿Hasta qué hora abren?  ',
      }).expect(201);
      expect(regresion.crear).toHaveBeenCalledWith(
        EMPRESA_A,
        CASO_VALIDO,
        'u1',
      );
    });

    it.each([
      ['sin pregunta', { expected: 'answer' }],
      ['pregunta de 1 letra', { question: 'x', expected: 'answer' }],
      [
        'pregunta de más de 500',
        { question: 'x'.repeat(501), expected: 'answer' },
      ],
      ['esperado inválido', { question: '¿Abren?', expected: 'maybe' }],
      ['sin esperado', { question: '¿Abren?' }],
      [
        'menciones que no son lista',
        { question: '¿Abren?', expected: 'answer', mustMention: '20' },
      ],
      [
        'más de 10 menciones',
        {
          question: '¿Abren?',
          expected: 'answer',
          mustMention: Array.from({ length: 11 }, (_, i) => `m${i}`),
        },
      ],
      [
        'mención vacía',
        { question: '¿Abren?', expected: 'answer', mustMention: [''] },
      ],
      [
        'mención de más de 100',
        {
          question: '¿Abren?',
          expected: 'answer',
          mustMention: ['x'.repeat(101)],
        },
      ],
      [
        'campo de más',
        { question: '¿Abren?', expected: 'answer', distributorId: EMPRESA_A },
      ],
    ])('400 POST caso: %s', async (_caso, cuerpo) => {
      await pedir(
        'post',
        '/company/assistant/regression/cases',
        ADMIN_A,
        cuerpo,
      ).expect(400);
      expect(regresion.crear).not.toHaveBeenCalled();
    });

    it('409 POST caso: repetido o tope', async () => {
      regresion.crear.mockRejectedValueOnce(casoRepetido());
      const repetido = await pedir(
        'post',
        '/company/assistant/regression/cases',
        ADMIN_A,
        CASO_VALIDO,
      ).expect(409);
      expect(repetido.body).toMatchObject({
        code: 'ASSISTANT_REGRESSION_CASE_DUPLICATE',
      });
      regresion.crear.mockRejectedValueOnce(topeDeCasos());
      const tope = await pedir(
        'post',
        '/company/assistant/regression/cases',
        ADMIN_A,
        CASO_VALIDO,
      ).expect(409);
      expect(tope.body).toMatchObject({
        code: 'ASSISTANT_REGRESSION_CASE_LIMIT_REACHED',
      });
    });

    it('200 PATCH y 204 DELETE: en la empresa del contexto', async () => {
      const r = await pedir(
        'patch',
        `/company/assistant/regression/cases/${CASO}`,
        ADMIN_A,
        { mustMention: ['20', 'hs'] },
      ).expect(200);
      expect(r.body).toMatchObject({ mustMention: ['20', 'hs'] });
      expect(regresion.actualizar).toHaveBeenCalledWith(
        EMPRESA_A,
        CASO,
        { mustMention: ['20', 'hs'] },
        'u1',
      );
      await pedir(
        'delete',
        `/company/assistant/regression/cases/${CASO}`,
      ).expect(204);
      expect(regresion.darDeBaja).toHaveBeenCalledWith(EMPRESA_A, CASO, 'u1');
    });

    it('400 PATCH y DELETE: el id no es un UUID (INVALID_ID)', async () => {
      for (const verbo of ['patch', 'delete'] as const) {
        const r = await pedir(
          verbo,
          '/company/assistant/regression/cases/no-es-uuid',
          ADMIN_A,
          { expected: 'answer' },
        ).expect(400);
        expect(r.body).toMatchObject({ code: 'INVALID_ID' });
      }
      expect(regresion.actualizar).not.toHaveBeenCalled();
    });

    it('404 PATCH y DELETE: no existe o es de otra empresa; 409 PATCH a una pregunta repetida', async () => {
      regresion.actualizar.mockRejectedValueOnce(casoInexistente());
      regresion.darDeBaja.mockRejectedValueOnce(casoInexistente());
      for (const verbo of ['patch', 'delete'] as const) {
        const r = await pedir(
          verbo,
          `/company/assistant/regression/cases/${CASO}`,
          ADMIN_A,
          { expected: 'answer' },
        ).expect(404);
        expect(r.body).toMatchObject({
          code: 'ASSISTANT_REGRESSION_CASE_NOT_FOUND',
        });
      }
      regresion.actualizar.mockRejectedValueOnce(casoRepetido());
      await pedir(
        'patch',
        `/company/assistant/regression/cases/${CASO}`,
        ADMIN_A,
        {
          question: '¿Otra?',
        },
      ).expect(409);
    });

    it('202 POST run: la corrida en curso, sin esperarla', async () => {
      const r = await pedir('post', '/company/assistant/regression/run').expect(
        202,
      );
      expect(r.body).toEqual({
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        status: 'running',
        total: 2,
        passed: 0,
        failed: 0,
        errored: 0,
        results: [],
        startedAt: '2026-11-16T13:00:00.000Z',
        finishedAt: null,
      });
      expect(regresion.iniciar).toHaveBeenCalledWith(EMPRESA_A, 'u1');
    });

    it('429 POST run: se corrió hace menos de 10 minutos (ASSISTANT_REGRESSION_RUN_COOLDOWN)', async () => {
      regresion.iniciar.mockRejectedValueOnce(corridaReciente(4));
      const r = await pedir('post', '/company/assistant/regression/run').expect(
        429,
      );
      expect(r.body).toMatchObject({
        code: 'ASSISTANT_REGRESSION_RUN_COOLDOWN',
        message:
          'Los casos se probaron hace menos de 10 minutos: probá de nuevo en 4 minutos',
      });
    });

    it('409 POST run: en curso o sin casos', async () => {
      regresion.iniciar.mockRejectedValueOnce(corridaEnCurso());
      const enCurso = await pedir(
        'post',
        '/company/assistant/regression/run',
      ).expect(409);
      expect(enCurso.body).toMatchObject({
        code: 'ASSISTANT_REGRESSION_RUN_IN_PROGRESS',
      });
      regresion.iniciar.mockRejectedValueOnce(sinCasos());
      const vacio = await pedir(
        'post',
        '/company/assistant/regression/run',
      ).expect(409);
      expect(vacio.body).toMatchObject({
        code: 'ASSISTANT_REGRESSION_NO_CASES',
      });
    });

    it('200 GET última corrida; 404 si nunca corrió', async () => {
      const r = await pedir(
        'get',
        '/company/assistant/regression/runs/last',
      ).expect(200);
      expect(r.body).toMatchObject({
        status: 'finished',
        passed: 1,
        failed: 1,
        finishedAt: '2026-11-16T13:01:00.000Z',
      });
      expect(regresion.ultima).toHaveBeenCalledWith(EMPRESA_A);
      regresion.ultima.mockRejectedValueOnce(sinCorridas());
      const nunca = await pedir(
        'get',
        '/company/assistant/regression/runs/last',
      ).expect(404);
      expect(nunca.body).toMatchObject({
        code: 'ASSISTANT_REGRESSION_RUN_NOT_FOUND',
      });
    });
  });

  describe('empresa · 400 sin distribuidora, 401 y 403', () => {
    it.each(RUTAS)(
      '400 %s %s: admin sin distribuidora (MISSING_DISTRIBUTOR)',
      async (verbo, ruta, cuerpo) => {
        const r = await pedir(
          verbo,
          ruta,
          { rol: RoleType.ADMIN },
          cuerpo,
        ).expect(400);
        expect(r.body).toMatchObject({ code: 'MISSING_DISTRIBUTOR' });
      },
    );

    it.each(RUTAS)('401 %s %s sin token', async (verbo, ruta, cuerpo) => {
      await pedir(verbo, ruta, { rol: null }, cuerpo).expect(401);
    });

    it.each(RUTAS)(
      '403 %s %s: chofer y cliente no entran',
      async (verbo, ruta, cuerpo) => {
        for (const rol of [RoleType.DELIVERY, RoleType.CUSTOMER]) {
          await pedir(verbo, ruta, { rol, tenant: EMPRESA_A }, cuerpo).expect(
            403,
          );
        }
      },
    );

    it.each(RUTAS)(
      '403 %s %s: admin sin el permiso que pide (PERMISSION_DENIED)',
      async (verbo, ruta, cuerpo, pide) => {
        // Con el otro permiso del asistente, pero no con el que pide la ruta.
        permisos = pide === 'ver' ? ['pedidos.ver'] : ['asistente.ver'];
        const r = await pedir(verbo, ruta, ADMIN_A, cuerpo).expect(403);
        expect(r.body).toMatchObject({ code: 'PERMISSION_DENIED' });
      },
    );

    it.each(RUTAS)(
      '403 %s %s: empresa sin el asistente (MODULE_DISABLED)',
      async (verbo, ruta, cuerpo) => {
        const r = await pedir(
          verbo,
          ruta,
          { rol: RoleType.ADMIN, tenant: SIN_M8 },
          cuerpo,
        ).expect(403);
        expect(r.body).toMatchObject({ code: 'MODULE_DISABLED' });
      },
    );

    it.each(RUTAS)(
      '403 %s %s: super admin sin sesión de soporte (SUPPORT_SESSION_REQUIRED)',
      async (verbo, ruta, cuerpo) => {
        const r = await pedir(verbo, ruta, SUPER, cuerpo).expect(403);
        // Las preguntas sin respuesta llevan texto de clientes: las corta el rol.
        expect(
          (r.body as { code?: unknown }).code === 'SUPPORT_SESSION_REQUIRED',
        ).toBe(ruta !== '/company/assistant/unanswered');
      },
    );

    it('super admin en modo soporte: lee lo de la empresa de la sesión, pero no prueba ni escribe (SUPPORT_READ_ONLY)', async () => {
      const soporte: Quien = {
        rol: RoleType.SUPER_ADMIN,
        tenant: EMPRESA_A,
        sesion: SESION,
      };
      for (const [verbo, ruta, cuerpo] of RUTAS) {
        if (ruta === '/company/assistant/unanswered') {
          // Lleva texto de los clientes: el administrador general no lo ve.
          await pedir(verbo, ruta, soporte, cuerpo).expect(403);
          continue;
        }
        if (verbo === 'get') {
          await pedir(verbo, ruta, soporte, cuerpo).expect(200);
          continue;
        }
        const r = await pedir(verbo, ruta, soporte, cuerpo).expect(403);
        expect(r.body).toMatchObject({ code: 'SUPPORT_READ_ONLY' });
      }
      expect(sinRespuesta.listar).not.toHaveBeenCalled();
      expect(regresion.listar).toHaveBeenCalledWith(EMPRESA_A);
      expect(probador.deLaEmpresa).not.toHaveBeenCalled();
      expect(regresion.iniciar).not.toHaveBeenCalled();
    });
  });

  describe('plataforma', () => {
    const RUTAS_DE_PLATAFORMA: Array<[Verbo, string, object | undefined]> = [
      ['post', '/platform/assistant/preview', { question: '¿Cómo exporto?' }],
      ['get', '/platform/assistant/unanswered', undefined],
      ['post', `/platform/assistant/unanswered/${GRUPO}/faq`, undefined],
      ['post', `/platform/assistant/unanswered/${GRUPO}/dismiss`, undefined],
    ];

    it('200 preview: el asistente del soporte, sin empresa', async () => {
      const r = await pedir('post', '/platform/assistant/preview', SUPER, {
        question: '¿Cómo exporto las ventas?',
      }).expect(200);
      expect(r.body).toMatchObject({ answer: 'Abrimos de 8 a 20.' });
      expect(probador.deLaPlataforma).toHaveBeenCalledWith(
        '¿Cómo exporto las ventas?',
        'u1',
      );
      expect(acceso.habilitado).not.toHaveBeenCalled();
    });

    it('400 preview: sin pregunta o con un cliente (en el soporte no hay)', async () => {
      for (const cuerpo of [{}, { question: '¿Y?', customerId: CLIENTE }]) {
        await pedir(
          'post',
          '/platform/assistant/preview',
          SUPER,
          cuerpo,
        ).expect(400);
      }
      expect(probador.deLaPlataforma).not.toHaveBeenCalled();
    });

    it('429 preview: más de 20 por minuto', async () => {
      for (let i = 0; i < 20; i += 1) {
        await pedir('post', '/platform/assistant/preview', SUPER, {
          question: '¿Y?',
        }).expect(200);
      }
      await pedir('post', '/platform/assistant/preview', SUPER, {
        question: '¿Y?',
      }).expect(429);
    });

    it('200 GET unanswered: las del soporte (dueño nulo); 400 con fechas inválidas', async () => {
      await pedir('get', '/platform/assistant/unanswered', SUPER).expect(200);
      expect(sinRespuesta.listar).toHaveBeenCalledWith(
        null,
        undefined,
        undefined,
      );
      await pedir('get', '/platform/assistant/unanswered', SUPER, undefined, {
        from: 'ayer',
      }).expect(400);
    });

    it('201 faq: borrador de la base de la plataforma con su clave; 204 dismiss', async () => {
      sinRespuesta.crearPregunta.mockResolvedValueOnce({
        faq: borrador({
          distributorId: null,
          key: 'sin_respuesta_3f2a9c0d1b7e',
        }),
        creada: true,
      });
      const r = await pedir(
        'post',
        `/platform/assistant/unanswered/${GRUPO}/faq`,
        SUPER,
        PREGUNTA,
      ).expect(201);
      expect(r.body).toMatchObject({
        key: 'sin_respuesta_3f2a9c0d1b7e',
        isDraft: true,
      });
      expect(sinRespuesta.crearPregunta).toHaveBeenCalledWith(
        null,
        GRUPO,
        '¿Llegan a Garupá?',
        'u1',
      );
      await pedir(
        'post',
        `/platform/assistant/unanswered/${GRUPO}/dismiss`,
        SUPER,
      ).expect(204);
      expect(sinRespuesta.descartar).toHaveBeenCalledWith(null, GRUPO, 'u1');
    });

    it('404 y 409: grupo inexistente o pregunta repetida', async () => {
      sinRespuesta.crearPregunta.mockRejectedValueOnce(grupoInexistente());
      await pedir(
        'post',
        `/platform/assistant/unanswered/${GRUPO}/faq`,
        SUPER,
        PREGUNTA,
      ).expect(404);
      sinRespuesta.descartar.mockRejectedValueOnce(grupoInexistente());
      await pedir(
        'post',
        `/platform/assistant/unanswered/${GRUPO}/dismiss`,
        SUPER,
      ).expect(404);
      sinRespuesta.crearPregunta.mockRejectedValueOnce(preguntaRepetida());
      await pedir(
        'post',
        `/platform/assistant/unanswered/${GRUPO}/faq`,
        SUPER,
        PREGUNTA,
      ).expect(409);
    });

    it.each(RUTAS_DE_PLATAFORMA)(
      '401 %s %s sin token; 403 para el admin de una empresa',
      async (verbo, ruta, cuerpo) => {
        await pedir(verbo, ruta, { rol: null }, cuerpo).expect(401);
        await pedir(verbo, ruta, ADMIN_A, cuerpo).expect(403);
      },
    );
  });
});
