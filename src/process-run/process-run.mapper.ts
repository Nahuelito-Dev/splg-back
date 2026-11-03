import { CATALOGO } from './domain/process-catalog';
import { ProcessRunResponseDto } from './dto/process-run-response.dto';
import { ProcessRun } from './entities/process-run.entity';

export class ProcessRunMapper {
  /**
   * Una corrida global (`distributorId` nulo) recorre a todas las distribuidoras:
   * sus contadores y su error cuentan lo que pasó en toda la plataforma, así que
   * sólo los ve el administrador general. Al admin de una empresa le queda la
   * salud (estado, horas, duración).
   */
  static toDto(run: ProcessRun, verDetalle: boolean): ProcessRunResponseDto {
    const oculto = run.distributorId === null && !verDetalle;
    const dto = new ProcessRunResponseDto();
    dto.id = run.runId;
    dto.process = run.process;
    dto.title = CATALOGO[run.process].title;
    dto.distributorId = run.distributorId;
    dto.startedAt = run.startedAt;
    dto.finishedAt = run.finishedAt;
    dto.durationMs = run.finishedAt
      ? run.finishedAt.getTime() - run.startedAt.getTime()
      : null;
    dto.status = run.status;
    dto.counters = oculto ? {} : run.counters;
    dto.error = oculto ? null : run.error;
    dto.trigger = run.trigger;
    return dto;
  }
}
