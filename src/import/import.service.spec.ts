import {
  BadRequestException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ImportJobStatus, ImportResource } from './domain/import.enums';
import { FilaNormalizada, ImportHandler } from './domain/import.types';
import { ImportJob } from './entities/import-job.entity';
import { ImportHandlerRegistry } from './import-handler.registry';
import { ImportService } from './import.service';

const csv = (texto: string) => ({
  originalname: 'carga.csv',
  buffer: Buffer.from(texto, 'utf-8'),
});

const job = (parcial: Partial<ImportJob> = {}): ImportJob =>
  ({
    importId: 'i1',
    distributorId: 'd1',
    resource: ImportResource.GARRAFAS,
    status: ImportJobStatus.PENDING,
    fileName: 'carga.csv',
    total: 2,
    validRows: 2,
    errorCount: 0,
    rows: [
      { fila: 2, datos: { type: 'A' } },
      { fila: 3, datos: { type: 'B' } },
    ],
    errors: [],
    summary: null,
    expiresAt: new Date(Date.now() + 60_000),
    confirmedAt: null,
    ...parcial,
  }) as ImportJob;

describe('ImportService', () => {
  let handler: {
    recurso: string;
    columnas: ImportHandler['columnas'];
    validar: jest.Mock;
    aplicar: jest.Mock;
  };
  let repoDelJob: { save: jest.Mock; create: jest.Mock };
  let bloqueo: {
    getOne: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    setLock: jest.Mock;
  };
  let repoEnTransaccion: { save: jest.Mock; createQueryBuilder: jest.Mock };
  let manager: EntityManager;
  let dataSource: { transaction: jest.Mock };
  let service: ImportService;

  beforeEach(() => {
    handler = {
      recurso: 'garrafas',
      columnas: [
        { key: 'type', header: 'Tipo', ejemplo: '10 kg', obligatoria: true },
      ],
      validar: jest.fn(),
      aplicar: jest.fn().mockResolvedValue({ creadas: 2 }),
    };
    repoDelJob = {
      create: jest.fn((j: Partial<ImportJob>) => j),
      save: jest.fn((j: Partial<ImportJob>) =>
        Promise.resolve({ importId: 'nuevo', ...j }),
      ),
    };
    bloqueo = {
      getOne: jest.fn(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
    };
    repoEnTransaccion = {
      save: jest.fn((j: ImportJob) => Promise.resolve(j)),
      createQueryBuilder: jest.fn(() => bloqueo),
    };
    manager = {
      getRepository: jest.fn(() => repoEnTransaccion),
    } as unknown as EntityManager;
    dataSource = {
      transaction: jest.fn((fn: (m: EntityManager) => unknown) => fn(manager)),
    };
    service = new ImportService(
      repoDelJob as unknown as Repository<ImportJob>,
      dataSource as unknown as DataSource,
      { de: () => handler } as unknown as ImportHandlerRegistry,
    );
  });

  describe('preview', () => {
    it('sin archivo o con archivo vacío es 400', async () => {
      await expect(
        service.preview(ImportResource.GARRAFAS, undefined, 'd1', 'u1'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.preview(ImportResource.GARRAFAS, csv(''), 'd1', 'u1'),
      ).rejects.toThrow('Falta el archivo');
    });

    it('guarda la vista previa sin aplicar nada del negocio', async () => {
      const filas: FilaNormalizada[] = [{ fila: 2, datos: { type: 'A' } }];
      handler.validar.mockResolvedValue({ errores: [], filas });
      const antes = Date.now();

      const r = await service.preview(
        ImportResource.GARRAFAS,
        csv('Tipo\nA\n'),
        'd1',
        'u1',
      );

      expect(handler.validar).toHaveBeenCalledWith(
        [{ fila: 2, celdas: { type: 'A' } }],
        'd1',
      );
      expect(handler.aplicar).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(repoDelJob.save).toHaveBeenCalledTimes(1);
      expect(r).toMatchObject({
        distributorId: 'd1',
        createdByUserId: 'u1',
        resource: 'garrafas',
        status: ImportJobStatus.PENDING,
        fileName: 'carga.csv',
        total: 1,
        validRows: 1,
        errorCount: 0,
        rows: filas,
      });
      const horas = (r.expiresAt.getTime() - antes) / 3_600_000;
      expect(horas).toBeGreaterThan(23.99);
      expect(horas).toBeLessThan(24.01);
    });

    it('con errores queda en with_errors, ordenados por fila', async () => {
      handler.validar.mockResolvedValue({
        errores: [
          { fila: 4, columna: 'Tipo', mensaje: 'b' },
          { fila: 2, columna: 'Tipo', mensaje: 'a' },
        ],
        filas: [{ fila: 3, datos: {} }],
      });
      const r = await service.preview(
        ImportResource.GARRAFAS,
        csv('Tipo\nA\nB\nC\n'),
        'd1',
        'u1',
      );
      expect(r.status).toBe(ImportJobStatus.WITH_ERRORS);
      expect(r.errorCount).toBe(2);
      expect(r.validRows).toBe(1);
      expect(r.total).toBe(3);
      expect(r.errors.map((e) => e.fila)).toEqual([2, 4]);
    });

    it('un encabezado que no coincide es 400 y no guarda nada', async () => {
      await expect(
        service.preview(
          ImportResource.GARRAFAS,
          csv('Color\nrojo\n'),
          'd1',
          'u1',
        ),
      ).rejects.toThrow('Columnas que no existen en la plantilla: Color');
      expect(repoDelJob.save).not.toHaveBeenCalled();
    });
  });

  describe('confirm', () => {
    it('aplica las filas guardadas en la transacción y marca la importación como confirmada', async () => {
      const pendiente = job();
      bloqueo.getOne.mockResolvedValue(pendiente);

      const r = await service.confirm('i1', 'd1', 'u1');

      expect(bloqueo.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(handler.aplicar).toHaveBeenCalledWith(manager, pendiente.rows, {
        distributorId: 'd1',
        actorUserId: 'u1',
        importId: 'i1',
        fileName: 'carga.csv',
      });
      expect(r.yaConfirmada).toBe(false);
      expect(r.job.status).toBe(ImportJobStatus.CONFIRMED);
      expect(r.job.summary).toEqual({ creadas: 2 });
      expect(r.job.confirmedAt).toBeInstanceOf(Date);
    });

    it('todo o nada: si una fila falla, el error sale, la transacción se revierte y no se marca confirmada', async () => {
      const pendiente = job();
      bloqueo.getOne.mockResolvedValue(pendiente);
      handler.aplicar.mockRejectedValue(
        new BadRequestException('Fila 3: tipo repetido'),
      );

      await expect(service.confirm('i1', 'd1', 'u1')).rejects.toThrow(
        'Fila 3: tipo repetido',
      );
      expect(repoEnTransaccion.save).not.toHaveBeenCalled();
      expect(pendiente.status).toBe(ImportJobStatus.PENDING);
      expect(pendiente.confirmedAt).toBeNull();
    });

    it('idempotente: una importación ya confirmada devuelve su resumen sin aplicar de nuevo', async () => {
      const hecha = job({
        status: ImportJobStatus.CONFIRMED,
        summary: { creadas: 2 },
        confirmedAt: new Date(),
      });
      bloqueo.getOne.mockResolvedValue(hecha);

      const r = await service.confirm('i1', 'd1', 'u1');

      expect(r).toEqual({ job: hecha, yaConfirmada: true });
      expect(handler.aplicar).not.toHaveBeenCalled();
      expect(repoEnTransaccion.save).not.toHaveBeenCalled();
    });

    it('una ya confirmada se devuelve aunque la vista previa haya vencido', async () => {
      bloqueo.getOne.mockResolvedValue(
        job({
          status: ImportJobStatus.CONFIRMED,
          expiresAt: new Date(Date.now() - 1000),
          confirmedAt: new Date(),
        }),
      );
      const r = await service.confirm('i1', 'd1', 'u1');
      expect(r.yaConfirmada).toBe(true);
    });

    it('aislamiento: se busca por distribuidora y lo de otra es 404', async () => {
      bloqueo.getOne.mockResolvedValue(null);

      await expect(service.confirm('i1', 'd-otra', 'u1')).rejects.toThrow(
        NotFoundException,
      );
      expect(bloqueo.andWhere).toHaveBeenCalledWith(
        'j.distributorId = :distributorId',
        { distributorId: 'd-otra' },
      );
      expect(handler.aplicar).not.toHaveBeenCalled();
    });

    it('con errores en la vista previa no se confirma (400)', async () => {
      bloqueo.getOne.mockResolvedValue(
        job({ status: ImportJobStatus.WITH_ERRORS, errorCount: 3 }),
      );
      await expect(service.confirm('i1', 'd1', 'u1')).rejects.toThrow(
        'La vista previa tiene 3 error(es)',
      );
      expect(handler.aplicar).not.toHaveBeenCalled();
    });

    it('vencida a las 24 h: 410 y no aplica nada', async () => {
      bloqueo.getOne.mockResolvedValue(
        job({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(service.confirm('i1', 'd1', 'u1')).rejects.toThrow(
        GoneException,
      );
      expect(handler.aplicar).not.toHaveBeenCalled();
    });
  });
});
