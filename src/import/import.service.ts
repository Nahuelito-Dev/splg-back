import {
  BadRequestException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { withTransactionRetry } from '../common/utils/with-transaction-retry';
import { ImportJobStatus, ImportResource } from './domain/import.enums';
import { VIGENCIA_HORAS } from './domain/import.types';
import { ImportJob } from './entities/import-job.entity';
import { ImportHandlerRegistry } from './import-handler.registry';
import { leerArchivo } from './parsing/lector-de-tabla';
import { armarFilas } from './parsing/tabla-importada';

export interface ArchivoSubido {
  originalname: string;
  buffer: Buffer;
}

export interface ConfirmacionDeImportacion {
  job: ImportJob;
  yaConfirmada: boolean;
}

/**
 * Importación masiva en dos pasos. La vista previa valida TODAS las filas con las
 * reglas del alta unitaria y guarda el resultado sin tocar el negocio; la
 * confirmación lo aplica en UNA transacción con los servicios de cada recurso.
 */
@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    @InjectRepository(ImportJob) private readonly jobs: Repository<ImportJob>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly handlers: ImportHandlerRegistry,
  ) {}

  async preview(
    recurso: ImportResource,
    archivo: ArchivoSubido | undefined,
    distributorId: string,
    actorUserId: string,
  ): Promise<ImportJob> {
    if (!archivo || archivo.buffer.length === 0) {
      throw new BadRequestException(
        'Falta el archivo: enviá el campo multipart `file` con un .xlsx o .csv',
      );
    }
    const handler = this.handlers.de(recurso);
    const crudas = armarFilas(
      await leerArchivo(archivo.originalname, archivo.buffer),
      handler.columnas,
    );
    const { errores, filas } = await handler.validar(crudas, distributorId);
    const vence = new Date(Date.now() + VIGENCIA_HORAS * 60 * 60 * 1000);
    return this.jobs.save(
      this.jobs.create({
        distributorId,
        createdByUserId: actorUserId,
        resource: recurso,
        status:
          errores.length > 0
            ? ImportJobStatus.WITH_ERRORS
            : ImportJobStatus.PENDING,
        fileName: archivo.originalname.slice(0, 255),
        total: crudas.length,
        validRows: filas.length,
        errorCount: errores.length,
        rows: filas,
        errors: errores.sort((a, b) => a.fila - b.fila),
        summary: null,
        expiresAt: vence,
        confirmedAt: null,
      }),
    );
  }

  /**
   * Aplica la vista previa. Todo o nada: cualquier error revierte la transacción
   * entera y la importación queda sin confirmar. Idempotente: el job se toma con
   * lock, y si ya estaba confirmada devuelve el mismo resumen sin aplicar de nuevo.
   */
  async confirm(
    importId: string,
    distributorId: string,
    actorUserId: string,
  ): Promise<ConfirmacionDeImportacion> {
    try {
      return await withTransactionRetry(
        () =>
          this.dataSource.transaction(async (manager) => {
            const repo = manager.getRepository(ImportJob);
            const job = await repo
              .createQueryBuilder('j')
              .setLock('pessimistic_write')
              .where('j.importId = :importId', { importId })
              .andWhere('j.distributorId = :distributorId', { distributorId })
              .getOne();
            if (!job) {
              throw new NotFoundException('Importación no encontrada');
            }
            if (job.status === ImportJobStatus.CONFIRMED) {
              return { job, yaConfirmada: true };
            }
            if (job.status === ImportJobStatus.WITH_ERRORS) {
              throw new BadRequestException(
                `La vista previa tiene ${job.errorCount} error(es): corregí el archivo y volvé a subirlo`,
              );
            }
            if (job.expiresAt.getTime() < Date.now()) {
              throw new GoneException(
                'La vista previa venció (dura 24 h): volvé a subir el archivo',
              );
            }
            job.summary = await this.handlers
              .de(job.resource)
              .aplicar(manager, job.rows, {
                distributorId,
                actorUserId,
                importId,
                fileName: job.fileName,
              });
            job.status = ImportJobStatus.CONFIRMED;
            job.confirmedAt = new Date();
            return { job: await repo.save(job), yaConfirmada: false };
          }),
        { context: 'confirmación de importación' },
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'importación');
    }
  }
}
