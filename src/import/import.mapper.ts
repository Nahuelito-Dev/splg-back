import { FILAS_DE_VISTA_PREVIA } from './domain/import.types';
import {
  ImportConfirmResponseDto,
  ImportPreviewResponseDto,
} from './dto/import.dto';
import { ImportJob } from './entities/import-job.entity';

export class ImportMapper {
  static toPreviewDto(job: ImportJob): ImportPreviewResponseDto {
    const dto = new ImportPreviewResponseDto();
    dto.importId = job.importId;
    dto.recurso = job.resource;
    dto.estado = job.status;
    dto.total = job.total;
    dto.validas = job.validRows;
    dto.errores = job.errors.map((e) => ({
      fila: e.fila,
      columna: e.columna,
      mensaje: e.mensaje,
    }));
    dto.vistaPrevia = job.rows
      .slice(0, FILAS_DE_VISTA_PREVIA)
      .map((r) => ({ fila: r.fila, datos: r.datos }));
    dto.venceEn = job.expiresAt;
    return dto;
  }

  static toConfirmDto(
    job: ImportJob,
    yaConfirmada: boolean,
  ): ImportConfirmResponseDto {
    const dto = new ImportConfirmResponseDto();
    dto.importId = job.importId;
    dto.recurso = job.resource;
    dto.estado = job.status;
    dto.total = job.total;
    dto.resumen = job.summary ?? {};
    dto.confirmadaEn = job.confirmedAt ?? job.updatedAt;
    dto.yaConfirmada = yaConfirmada;
    return dto;
  }
}
