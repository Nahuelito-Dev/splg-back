import { CATALOGO } from './domain/process-catalog';
import { AdminNotification } from '../admin-notifications/entities/admin-notification.entity';
import {
  ProcessRunDetailResponseDto,
  ProcessRunResponseDto,
} from './dto/process-run-response.dto';
import { ProcessRun } from './entities/process-run.entity';
import { sanitizarError } from './domain/sanitizar-error';

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
    dto.error = oculto || !run.error ? null : sanitizarError(run.error);
    dto.trigger = run.trigger;
    return dto;
  }

  /** El detalle completo: sólo lo ve el administrador general. */
  static toDetailDto(
    run: ProcessRun,
    avisos: AdminNotification[],
  ): ProcessRunDetailResponseDto {
    const dto = Object.assign(
      new ProcessRunDetailResponseDto(),
      ProcessRunMapper.toDto(run, true),
    );
    dto.durationMs = run.durationMs ?? dto.durationMs;
    dto.module = CATALOGO[run.process].module;
    dto.requestedBy = run.requestedBy;
    dto.instance = run.instance;
    dto.companies = run.companies;
    dto.errorFingerprint = run.errorFingerprint;
    dto.traceId = run.traceId;
    dto.notifications = avisos.map((a) => ({
      id: a.notificationId,
      kind: a.kind,
      distributorId: a.distributorId,
      createdAt: a.createdAt,
    }));
    return dto;
  }
}
