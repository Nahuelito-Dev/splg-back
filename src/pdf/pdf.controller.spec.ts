import {
  ExecutionContext,
  ForbiddenException,
  INestApplication,
  ValidationPipe,
  VERSION_NEUTRAL,
  VersioningType,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'http';
import request from 'supertest';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { DownloadDisposition } from '../s3/dto/download-link.dto';
import { PdfQueryDto, ReporteDeVentasPdfQueryDto } from './dto/pdf-query.dto';
import { PdfController } from './pdf.controller';
import { PdfDocumentsService } from './pdf-documents.service';

const ID = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';
const PDF = Buffer.from('%PDF-1.3 prueba');
const DOCUMENTO = { contenido: PDF, nombre: 'doc-ñandú.pdf' };

type Metodo = keyof PdfController;

function usuario(role: RoleType): AuthenticatedUser {
  return { user_id: 'u1', role } as AuthenticatedUser;
}

/**
 * Las rutas, los encabezados y la validación se prueban por HTTP; las reglas de
 * quién pide qué, directo contra el controlador y el `RolesGuard` real. Son
 * pocas llamadas HTTP a propósito: cada una abre un puerto efímero y, con
 * cientos, los servidores de otros specs que corren en paralelo se pisan.
 */
describe('PdfController (API v2)', () => {
  describe('por HTTP', () => {
    let app: INestApplication<Server>;
    let documentos: Record<string, jest.Mock>;
    let distributorId: string | null;
    let rol: RoleType;

    beforeAll(async () => {
      distributorId = 'd1';
      rol = RoleType.ADMIN;
      documentos = {
        remito: jest.fn(),
        recibo: jest.fn(),
        rendicion: jest.fn(),
        liquidacion: jest.fn(),
        cierreDeCaja: jest.fn(),
        reporteDeVentas: jest.fn(),
      };
      const modulo = await Test.createTestingModule({
        controllers: [PdfController],
        providers: [{ provide: PdfDocumentsService, useValue: documentos }],
      }).compile();
      app = modulo.createNestApplication<INestApplication<Server>>();
      // Igual que main.ts: prefijo `api` y versionado por URI.
      app.setGlobalPrefix('api');
      app.enableVersioning({
        type: VersioningType.URI,
        defaultVersion: [VERSION_NEUTRAL, '1'],
      });
      app.use((req: Request, _res: Response, next: NextFunction) => {
        req.distributorId = distributorId;
        req.user = usuario(rol) as Request['user'];
        next();
      });
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      await app.init();
    });

    beforeEach(() => {
      distributorId = 'd1';
      rol = RoleType.ADMIN;
      for (const d of Object.values(documentos)) {
        d.mockResolvedValue(DOCUMENTO);
      }
    });

    afterAll(async () => {
      await app.close();
    });

    const get = (ruta: string) => request(app.getHttpServer()).get(ruta);

    const rutas: Array<[string, string, string]> = [
      ['remito', 'remito', `/api/v2/orders/${ID}/remito.pdf`],
      ['recibo', 'recibo', `/api/v2/orders/${ID}/recibo.pdf`],
      ['rendición', 'rendicion', `/api/v2/driver-settlements/${ID}/pdf`],
      ['liquidación', 'liquidacion', `/api/v2/driver-liquidations/${ID}/pdf`],
      ['cierre de caja', 'cierreDeCaja', `/api/v2/cash-sessions/${ID}/pdf`],
      ['reporte de ventas', 'reporteDeVentas', '/api/v2/reports/sales.pdf'],
    ];

    it.each(rutas)(
      '%s: application/pdf con los bytes del documento y descarga por defecto con el nombre en UTF-8',
      async (_nombre, metodo, ruta) => {
        const res = await get(ruta).buffer(true);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('application/pdf');
        expect(res.headers['content-length']).toBe(String(PDF.length));
        expect(res.headers['content-disposition']).toBe(
          `attachment; filename="doc-_and_.pdf"; filename*=UTF-8''doc-%C3%B1and%C3%BA.pdf`,
        );
        expect((res.body as Buffer).toString()).toBe(PDF.toString());
        expect(documentos[metodo]).toHaveBeenCalledTimes(1);
      },
    );

    it('?disposicion=inline lo muestra en el navegador', async () => {
      const res = await get(`${rutas[0][2]}?disposicion=inline`);
      expect(res.headers['content-disposition']).toMatch(/^inline; /);
    });

    it('una disposición desconocida y un id que no es UUID son 400, sin generar nada', async () => {
      const a = await get(`${rutas[0][2]}?disposicion=otra`);
      const b = await get(rutas[0][2].replace(ID, 'no-es-uuid'));
      expect(a.status).toBe(400);
      expect(b.status).toBe(400);
      expect(documentos.remito).not.toHaveBeenCalled();
    });

    it('sólo existe en /api/v2: ni /api/v1 ni /api sin versión', async () => {
      const v1 = await get(rutas[0][2].replace('/v2/', '/v1/'));
      const neutra = await get(rutas[0][2].replace('/v2/', '/'));
      expect(v1.status).toBe(404);
      expect(neutra.status).toBe(404);
    });

    it('el cliente pide sin distribuidora en contexto; un super admin sin ella recibe 400', async () => {
      rol = RoleType.CUSTOMER;
      distributorId = null;
      const cliente = await get(rutas[0][2]);
      rol = RoleType.SUPER_ADMIN;
      const superAdmin = await get(rutas[0][2]);

      expect(cliente.status).toBe(200);
      expect(superAdmin.status).toBe(400);
      expect(documentos.remito).toHaveBeenCalledTimes(1);
    });

    it('el reporte pasa desde y hasta al servicio', async () => {
      await get('/api/v2/reports/sales.pdf?desde=2026-10-01&hasta=2026-10-31');
      expect(documentos.reporteDeVentas).toHaveBeenCalledWith(
        'd1',
        '2026-10-01',
        '2026-10-31',
      );
    });
  });

  describe('quién pide', () => {
    let documentos: Record<string, jest.Mock>;
    let controlador: PdfController;

    beforeEach(() => {
      documentos = {
        remito: jest.fn().mockResolvedValue(DOCUMENTO),
        recibo: jest.fn().mockResolvedValue(DOCUMENTO),
        rendicion: jest.fn().mockResolvedValue(DOCUMENTO),
        liquidacion: jest.fn().mockResolvedValue(DOCUMENTO),
        cierreDeCaja: jest.fn().mockResolvedValue(DOCUMENTO),
        reporteDeVentas: jest.fn().mockResolvedValue(DOCUMENTO),
      };
      controlador = new PdfController(documentos as never);
    });

    it('remito y recibo: el cliente se acota por su usuario; el personal, por la distribuidora', async () => {
      await controlador.remito(ID, {}, usuario(RoleType.CUSTOMER), null);
      await controlador.recibo(ID, {}, usuario(RoleType.ADMIN), 'd1');

      expect(documentos.remito).toHaveBeenCalledWith(ID, {
        distributorId: null,
        customerUserId: 'u1',
      });
      expect(documentos.recibo).toHaveBeenCalledWith(ID, {
        distributorId: 'd1',
        customerUserId: undefined,
      });
    });

    it('rendición: sólo se acota por el usuario cuando pide un chofer', async () => {
      await controlador.rendicion(ID, {}, usuario(RoleType.DELIVERY), 'd1');
      await controlador.rendicion(ID, {}, usuario(RoleType.ADMIN), 'd1');

      expect(documentos.rendicion).toHaveBeenNthCalledWith(1, ID, 'd1', 'u1');
      expect(documentos.rendicion).toHaveBeenNthCalledWith(
        2,
        ID,
        'd1',
        undefined,
      );
    });

    it('liquidación y cierre de caja se piden con la distribuidora en contexto', async () => {
      await controlador.liquidacion(ID, {}, 'd1');
      await controlador.cierreDeCaja(ID, {}, 'd1');

      expect(documentos.liquidacion).toHaveBeenCalledWith(ID, 'd1');
      expect(documentos.cierreDeCaja).toHaveBeenCalledWith(ID, 'd1');
    });

    it('la disposición pedida llega al encabezado', async () => {
      const inline = await controlador.liquidacion(
        ID,
        { disposicion: DownloadDisposition.INLINE },
        'd1',
      );
      expect(inline.getHeaders().disposition).toMatch(/^inline; /);
    });
  });

  describe('roles (RolesGuard real)', () => {
    const guard = new RolesGuard(new Reflector());
    const puede = (metodo: Metodo, role: RoleType): boolean => {
      const handler = Object.getOwnPropertyDescriptor(
        PdfController.prototype,
        metodo,
      )?.value as () => void;
      const contexto = {
        getHandler: () => handler,
        getClass: () => PdfController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      } as unknown as ExecutionContext;
      try {
        return guard.canActivate(contexto);
      } catch (e) {
        if (e instanceof ForbiddenException) return false;
        throw e;
      }
    };

    const permitidos: Array<[Metodo, RoleType[]]> = [
      ['remito', [RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN]],
      ['recibo', [RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN]],
      ['rendicion', [RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN]],
      ['liquidacion', [RoleType.ADMIN, RoleType.SUPER_ADMIN]],
      ['cierreDeCaja', [RoleType.ADMIN, RoleType.SUPER_ADMIN]],
      ['ventas', [RoleType.ADMIN, RoleType.SUPER_ADMIN]],
    ];

    it.each(permitidos)('%s: sólo %j', (metodo, roles) => {
      for (const role of Object.values(RoleType)) {
        expect([role, puede(metodo, role)]).toEqual([
          role,
          roles.includes(role),
        ]);
      }
    });
  });

  describe('consulta', () => {
    const errores = async (
      Clase: new () => object,
      plano: Record<string, unknown>,
    ) => (await validate(plainToInstance(Clase, plano))).map((e) => e.property);

    it('desde y hasta aceptan días reales; el resto es error', async () => {
      expect(
        await errores(ReporteDeVentasPdfQueryDto, {
          desde: '2026-10-01',
          hasta: '2026-10-31',
          disposicion: 'inline',
        }),
      ).toEqual([]);
      expect(await errores(ReporteDeVentasPdfQueryDto, {})).toEqual([]);
      for (const plano of [
        { desde: '01/10/2026' },
        { hasta: '2026-02-30' },
        { desde: 'hoy' },
      ]) {
        expect(await errores(ReporteDeVentasPdfQueryDto, plano)).toHaveLength(
          1,
        );
      }
    });

    it('la disposición sólo puede ser inline o attachment', async () => {
      expect(await errores(PdfQueryDto, { disposicion: 'attachment' })).toEqual(
        [],
      );
      expect(await errores(PdfQueryDto, { disposicion: 'otra' })).toEqual([
        'disposicion',
      ]);
    });
  });
});
