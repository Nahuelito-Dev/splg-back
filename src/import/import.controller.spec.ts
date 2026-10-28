import {
  INestApplication,
  ValidationPipe,
  VersioningType,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'http';
import request from 'supertest';
import { RoleType } from '../common/constants/role-type.enum';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { ImportJobStatus, ImportResource } from './domain/import.enums';
import { ImportJob } from './entities/import-job.entity';
import { ImportHandlerRegistry } from './import-handler.registry';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { ImportTemplateService } from './import-template.service';
import { Workbook } from 'exceljs';
import { Readable } from 'stream';

const job = (parcial: Partial<ImportJob> = {}): ImportJob =>
  ({
    importId: '0b0e4c3e-8f0b-4f6e-9a49-3a6a3f5b7a11',
    resource: ImportResource.GARRAFAS,
    status: ImportJobStatus.PENDING,
    total: 25,
    validRows: 25,
    errorCount: 0,
    rows: Array.from({ length: 25 }, (_, i) => ({
      fila: i + 2,
      datos: { type: `T${i}` },
    })),
    errors: [],
    summary: { creadas: 25 },
    expiresAt: new Date('2026-10-28T10:00:00Z'),
    confirmedAt: new Date('2026-10-27T10:00:00Z'),
    updatedAt: new Date('2026-10-27T10:00:00Z'),
    ...parcial,
  }) as ImportJob;

describe('ImportController', () => {
  let app: INestApplication;
  let imports: { preview: jest.Mock; confirm: jest.Mock };

  beforeEach(async () => {
    imports = { preview: jest.fn(), confirm: jest.fn() };
    const modulo = await Test.createTestingModule({
      controllers: [ImportController],
      providers: [
        { provide: ImportService, useValue: imports },
        ImportTemplateService,
        {
          provide: ImportHandlerRegistry,
          useValue: {
            de: () => ({
              columnas: [
                {
                  key: 'type',
                  header: 'Tipo',
                  ejemplo: '10 kg',
                  obligatoria: true,
                },
              ],
            }),
          },
        },
      ],
    }).compile();
    app = modulo.createNestApplication();
    // Lo que deja el AuthGuard global en la petición.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.distributorId = 'd1';
      req.user = {
        user_id: 'u1',
        email: 'a@b.c',
        role: RoleType.ADMIN,
        distributor_id: 'd1',
      };
      next();
    });
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: [VERSION_NEUTRAL, '1'],
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0); // una sola vez: sin esto supertest abre un servidor por pedido y falla al azar con carga
  });

  afterEach(() => app.close());

  const http = () => request(app.getHttpServer() as Server);

  it('es sólo de admin y super admin', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ImportController)).toEqual([
      RoleType.ADMIN,
      RoleType.SUPER_ADMIN,
    ]);
  });

  describe('versionado: sólo existe en la v2', () => {
    it('la plantilla responde en /api/v2 y no en /api/v1 ni sin número', async () => {
      await http().get('/api/v2/imports/garrafas/template').expect(200);
      await http().get('/api/v1/imports/garrafas/template').expect(404);
      await http().get('/api/imports/garrafas/template').expect(404);
    });

    it('la vista previa y la confirmación tampoco existen en la v1', async () => {
      await http().post('/api/v1/imports/garrafas/preview').expect(404);
      await http()
        .post('/api/v1/imports/0b0e4c3e-8f0b-4f6e-9a49-3a6a3f5b7a11/confirm')
        .expect(404);
    });
  });

  describe('GET /api/v2/imports/:recurso/template', () => {
    it('xlsx por defecto, con su nombre de archivo', async () => {
      const res = await http()
        .get('/api/v2/imports/garrafas/template')
        .buffer(true)
        .parse((r, cb) => {
          const partes: Buffer[] = [];
          r.on('data', (c: Buffer) => partes.push(c));
          r.on('end', () => cb(null, Buffer.concat(partes)));
        })
        .expect(200);
      expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="plantilla-garrafas.xlsx"',
      );
      const libro = new Workbook();
      await libro.xlsx.read(Readable.from([res.body as Buffer]));
      expect(libro.worksheets[0].getRow(1).getCell(1).value).toBe('Tipo');
    });

    it('csv con format=csv', async () => {
      const res = await http()
        .get('/api/v2/imports/precios/template?format=csv')
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="plantilla-precios.csv"',
      );
      expect(res.text).toContain('Tipo');
    });

    it('un recurso o formato inválido es 400', async () => {
      await http().get('/api/v2/imports/clientes/template').expect(400);
      await http()
        .get('/api/v2/imports/garrafas/template?format=pdf')
        .expect(400);
    });
  });

  describe('POST /api/v2/imports/:recurso/preview', () => {
    it('recibe el archivo multipart y devuelve la vista previa con 20 filas', async () => {
      imports.preview.mockResolvedValue(job());

      const res = await http()
        .post('/api/v2/imports/garrafas/preview')
        .attach('file', Buffer.from('Tipo\nA\n'), 'carga.csv')
        .expect(201);

      expect(imports.preview).toHaveBeenCalledWith(
        'garrafas',
        expect.objectContaining({ originalname: 'carga.csv' }),
        'd1',
        'u1',
      );
      const cuerpo = res.body as {
        total: number;
        validas: number;
        vistaPrevia: unknown[];
        errores: unknown[];
        estado: string;
      };
      expect(cuerpo).toMatchObject({
        total: 25,
        validas: 25,
        errores: [],
        estado: 'pending',
      });
      expect(cuerpo.vistaPrevia).toHaveLength(20);
    });

    it('un archivo de más de 5 MB es 413', async () => {
      await http()
        .post('/api/v2/imports/garrafas/preview')
        .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1, 'a'), 'grande.csv')
        .expect(413);
      expect(imports.preview).not.toHaveBeenCalled();
    });

    it('un recurso inválido es 400', async () => {
      await http()
        .post('/api/v2/imports/clientes/preview')
        .attach('file', Buffer.from('a'), 'a.csv')
        .expect(400);
    });
  });

  describe('POST /api/v2/imports/:importId/confirm', () => {
    it('devuelve el resumen', async () => {
      imports.confirm.mockResolvedValue({ job: job(), yaConfirmada: false });

      const res = await http()
        .post('/api/v2/imports/0b0e4c3e-8f0b-4f6e-9a49-3a6a3f5b7a11/confirm')
        .expect(201);

      expect(imports.confirm).toHaveBeenCalledWith(
        '0b0e4c3e-8f0b-4f6e-9a49-3a6a3f5b7a11',
        'd1',
        'u1',
      );
      expect(res.body).toMatchObject({
        recurso: 'garrafas',
        resumen: { creadas: 25 },
        yaConfirmada: false,
      });
    });

    it('la repetición se marca como yaConfirmada', async () => {
      imports.confirm.mockResolvedValue({ job: job(), yaConfirmada: true });
      const res = await http()
        .post('/api/v2/imports/0b0e4c3e-8f0b-4f6e-9a49-3a6a3f5b7a11/confirm')
        .expect(201);
      expect((res.body as { yaConfirmada: boolean }).yaConfirmada).toBe(true);
    });

    it('un id que no es UUID es 400', async () => {
      await http().post('/api/v2/imports/xyz/confirm').expect(400);
    });
  });
});
