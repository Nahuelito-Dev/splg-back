import {
  INestApplication,
  VERSION_NEUTRAL,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'http';
import request from 'supertest';
import { RoleType } from '../../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { crearValidationPipe } from '../../common/validation/validation-pipe';
import { soloRutasVersionadas } from '../../common/config/documentacion';
import { ProcessRunController } from '../../process-run/process-run.controller';
import { PlatformActivityService } from '../application/platform-activity.service';
import { PlatformCompaniesService } from '../application/platform-companies.service';
import { PlatformProcessesService } from '../application/platform-processes.service';
import { PlatformScheduleService } from '../application/platform-schedule.service';
import { PlatformUsageService } from '../application/platform-usage.service';
import { PlatformConsoleController } from './platform-console.controller';

const ID = '8c2f5b2e-1d3a-4c5b-9e6f-0a1b2c3d4e5f';

/**
 * Nombres de campo que no pueden salir en ninguna respuesta de plataforma:
 * datos personales de clientes y choferes, datos bancarios y credenciales.
 */
const SENSIBLE =
  /phone|tel[eé]fono|dni|documentnumber|cuil|cbu|alias|bank|token|secret|password|credential|accesskey|firebase|address|street|location|latitude|longitude/i;
/** Los únicos correos permitidos: el de contacto de la empresa y el de cada admin (cuentas del panel). */
const CORREOS_PERMITIDOS = new Set([
  'CompanyProfileDto.contactEmail',
  'CompanyAdminDto.email',
]);

type Esquema = {
  $ref?: string;
  properties?: Record<string, Esquema>;
  items?: Esquema;
  allOf?: Esquema[];
  additionalProperties?: Esquema | boolean;
};

/** Todos los campos `Esquema.campo` alcanzables desde un esquema, recorriendo `$ref`. */
function campos(
  doc: OpenAPIObject,
  esquema: Esquema | undefined,
  dueño: string,
  vistos = new Set<string>(),
): string[] {
  if (!esquema) return [];
  if (esquema.$ref) {
    const nombre = esquema.$ref.split('/').pop() as string;
    if (vistos.has(nombre)) return [];
    vistos.add(nombre);
    return campos(
      doc,
      doc.components?.schemas?.[nombre] as Esquema,
      nombre,
      vistos,
    );
  }
  const salida: string[] = [];
  for (const [k, v] of Object.entries(esquema.properties ?? {})) {
    salida.push(`${dueño}.${k}`, ...campos(doc, v, dueño, vistos));
  }
  for (const s of esquema.allOf ?? []) {
    salida.push(...campos(doc, s, dueño, vistos));
  }
  salida.push(...campos(doc, esquema.items, dueño, vistos));
  if (typeof esquema.additionalProperties === 'object') {
    salida.push(...campos(doc, esquema.additionalProperties, dueño, vistos));
  }
  return salida;
}

describe('PlatformConsoleController (API v2)', () => {
  let app: INestApplication<Server>;
  let documento: OpenAPIObject;
  const companies = {
    tablero: jest.fn().mockResolvedValue({ ok: true }),
    listar: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    ficha: jest.fn().mockResolvedValue({ ok: true }),
  };
  const processes = { resumen: jest.fn().mockResolvedValue({ items: [] }) };
  const usage = { porEmpresa: jest.fn().mockResolvedValue({ items: [] }) };
  const activity = {
    listar: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  };
  const schedule = {
    vigentes: jest.fn().mockResolvedValue({ dispatchRetrySeconds: 15 }),
    guardar: jest.fn().mockResolvedValue({ dispatchRetrySeconds: 30 }),
  };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [PlatformConsoleController, ProcessRunController],
    })
      .useMocker((token) => {
        const mocks = new Map<unknown, unknown>([
          [PlatformCompaniesService, companies],
          [PlatformProcessesService, processes],
          [PlatformUsageService, usage],
          [PlatformActivityService, activity],
          [PlatformScheduleService, schedule],
        ]);
        return mocks.get(token) ?? {};
      })
      .compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: [VERSION_NEUTRAL, '1'],
    });
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = {
        user_id: 'super-1',
        role: RoleType.SUPER_ADMIN,
      } as AuthenticatedUser as Request['user'];
      next();
    });
    app.useGlobalPipes(crearValidationPipe());
    documento = soloRutasVersionadas(
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('t').build(),
      ),
    );
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (ruta: string) =>
    request(app.getHttpServer()).get(`/api/v2/platform${ruta}`);

  it('overview y companies pasan el período; companies, los filtros y la paginación por omisión', async () => {
    await get('/overview?from=2026-11-01&to=2026-11-10').expect(200);
    expect(companies.tablero).toHaveBeenLastCalledWith(
      '2026-11-01',
      '2026-11-10',
    );
    await get('/companies?status=suspended&ownedByPlatform=true').expect(200);
    expect(companies.listar).toHaveBeenLastCalledWith({
      status: 'suspended',
      ownedByPlatform: true,
      limit: 50,
      offset: 0,
    });
  });

  it('la ficha y las tareas programadas reciben el id', async () => {
    await get(`/companies/${ID}?from=2026-11-01`).expect(200);
    expect(companies.ficha).toHaveBeenLastCalledWith(
      ID,
      '2026-11-01',
      undefined,
    );
    await get(`/companies/${ID}/scheduled-tasks`).expect(200);
    expect(schedule.vigentes).toHaveBeenLastCalledWith(ID);
    await request(app.getHttpServer())
      .put(`/api/v2/platform/companies/${ID}/scheduled-tasks`)
      .send({ dispatchRetrySeconds: 30 })
      .expect(200);
    expect(schedule.guardar).toHaveBeenLastCalledWith(
      ID,
      { dispatchRetrySeconds: 30 },
      'super-1',
    );
  });

  it('uso del lector arma el mes; actividad pasa sus filtros', async () => {
    await get('/document-reading-usage?month=2026-10').expect(200);
    expect(usage.porEmpresa).toHaveBeenLastCalledWith(
      expect.objectContaining({ month: '2026-10' }),
    );
    await get(`/activity?distributorId=${ID}&limit=5&offset=5`).expect(200);
    expect(activity.listar).toHaveBeenLastCalledWith({
      distributorId: ID,
      limit: 5,
      offset: 5,
    });
    await get('/processes').expect(200);
    expect(processes.resumen).toHaveBeenCalled();
  });

  it.each([
    '/overview?from=01-11-2026',
    '/overview?to=2026-02-30',
    '/overview?otro=1',
    '/companies?status=inventado',
    '/companies?ownedByPlatform=si',
    '/companies?limit=0',
    '/companies?limit=101',
    '/companies?offset=-1',
    '/companies/no-es-uuid',
    `/companies/${ID}?from=ayer`,
    '/companies/no-es-uuid/scheduled-tasks',
    '/document-reading-usage?month=2026-13',
    '/document-reading-usage?month=2026-1',
    '/activity?from=ayer',
    '/activity?actorUserId=x',
    '/activity?distributorId=x',
    '/activity?limit=500',
  ])('%s es 400', async (ruta) => {
    await get(ruta).expect(400);
  });

  it.each<[object, string]>([
    [{ fleetAlertHour: 9 }, 'la hora del aviso es de la empresa'],
    [{ dispatchRetrySeconds: 20 }, 'no es múltiplo de 15'],
    [{ dispatchRetrySeconds: 600 }, 'el reintento pasa los 5 minutos'],
    [{ unpaidReservationExpirySeconds: 90000 }, 'pasa las 24 horas'],
  ])('PUT scheduled-tasks %j es 400 (%s)', async (cuerpo: object) => {
    schedule.guardar.mockClear();
    await request(app.getHttpServer())
      .put(`/api/v2/platform/companies/${ID}/scheduled-tasks`)
      .send(cuerpo)
      .expect(400);
    expect(schedule.guardar).not.toHaveBeenCalled();
  });

  describe('OpenAPI', () => {
    const rutas = () =>
      Object.entries(documento.paths).filter(
        ([ruta]) =>
          ruta.startsWith('/api/v2/platform/') ||
          ruta.startsWith('/api/v2/process-runs'),
      );

    it('documenta los endpoints de plataforma con 200, 401 y 403', () => {
      const operaciones = rutas().flatMap(([ruta, item]) =>
        Object.entries(item as Record<string, { responses: object }>).map(
          ([metodo, op]) => [`${metodo} ${ruta}`, Object.keys(op.responses)],
        ),
      );
      // 11 con el detalle de una corrida (`GET /v2/process-runs/{runId}`, monitor O1).
      expect(operaciones.length).toBe(11);
      for (const [, codigos] of operaciones) {
        expect(codigos).toEqual(expect.arrayContaining(['200', '401', '403']));
      }
    });

    it('ninguna respuesta de plataforma tiene un campo sensible; los correos son sólo los permitidos', () => {
      const todos = rutas().flatMap(([, item]) =>
        Object.values(
          item as Record<
            string,
            {
              responses: Record<
                string,
                { content?: Record<string, { schema: Esquema }> }
              >;
            }
          >,
        ).flatMap((op) =>
          Object.values(op.responses).flatMap((r) =>
            campos(documento, r.content?.['application/json']?.schema, '?'),
          ),
        ),
      );
      expect(todos.length).toBeGreaterThan(50);
      const sensibles = todos.filter((c) => SENSIBLE.test(c.split('.')[1]));
      const correos = [
        ...new Set(
          todos.filter((c) => /mail/i.test(c) && !CORREOS_PERMITIDOS.has(c)),
        ),
      ];
      expect({ sensibles, correos }).toEqual({ sensibles: [], correos: [] });
    });
  });
});
