import {
  PREFIJO_DEL_CLIENTE,
  TRACE_ID_MAX,
} from '../../common/traza/contexto-de-traza';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminNotification } from '../../admin-notifications/entities/admin-notification.entity';
import { AuditLog } from '../../audit/entities/audit-log.entity';
import { conCodigo } from '../../common/errors/con-codigo';
import { CATALOGO } from '../../process-run/domain/process-catalog';
import { ProcessRun } from '../../process-run/entities/process-run.entity';
import {
  TraceItemDto,
  TraceItemKind,
  TraceResponseDto,
} from './dto/trace-response.dto';

/** Tope de filas por fuente: una traza normal tiene pocas; esto acota una rara. */
export const FILAS_POR_FUENTE = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * La traza unificada (DISENO-OBSERVABILIDAD §7.5): todo lo que quedó con el
 * mismo `traceId` — asientos de `audit_log` (por `request_id`), corridas de
 * procesos y avisos de la bandeja — en una línea de tiempo. Cada fuente se
 * consulta por su columna indexada y nada más: una traza no lista hechos de
 * otra, aunque sean de la misma empresa o del mismo momento.
 *
 * Los resúmenes no llevan datos personales: del asiento, método, ruta patrón,
 * código y rol (nunca `changes`, el actor ni un `resourceId` que no sea un
 * uuid); de la corrida, proceso, estado, disparo y duración; del aviso, su tipo.
 */
@Injectable()
export class TrazasService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly asientos: Repository<AuditLog>,
    @InjectRepository(ProcessRun)
    private readonly corridas: Repository<ProcessRun>,
    @InjectRepository(AdminNotification)
    private readonly avisos: Repository<AdminNotification>,
  ) {}

  /**
   * La traza con ese id; si no hay nada, la del mismo id mandado por quien
   * llamó (`c-<id>`), así se busca con el `X-Request-Id` tal como se envió.
   */
  async traza(traceId: string): Promise<TraceResponseDto> {
    const exacta = await this.items(traceId);
    if (exacta.length > 0) return { traceId, items: exacta };
    const delCliente = `${PREFIJO_DEL_CLIENTE}${traceId}`;
    const items =
      delCliente.length <= TRACE_ID_MAX ? await this.items(delCliente) : [];
    if (items.length === 0) {
      throw conCodigo(
        NotFoundException,
        404,
        'No hay nada registrado con esa traza (o ya se depuró por antigüedad)',
        'TRACE_NOT_FOUND',
      );
    }
    return { traceId: delCliente, items };
  }

  private async items(traceId: string): Promise<TraceItemDto[]> {
    const [asientos, corridas, avisos] = await Promise.all([
      this.asientos.find({
        where: { requestId: traceId },
        order: { createdAt: 'ASC' },
        take: FILAS_POR_FUENTE,
      }),
      this.corridas.find({
        where: { traceId },
        order: { startedAt: 'ASC' },
        take: FILAS_POR_FUENTE,
      }),
      this.avisos.find({
        where: { traceId },
        order: { createdAt: 'ASC' },
        take: FILAS_POR_FUENTE,
      }),
    ]);
    const items: TraceItemDto[] = [
      ...asientos.map(itemDeAsiento),
      ...corridas.map(itemDeCorrida),
      ...avisos.map(itemDeAviso),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
    return items;
  }
}

export function itemDeAsiento(a: AuditLog): TraceItemDto {
  const rol = a.actorRole ? ` (${a.actorRole})` : '';
  return {
    at: a.createdAt,
    kind: TraceItemKind.AUDIT,
    summary: `${a.httpMethod} ${a.path} → ${a.statusCode}${rol}`,
    distributorId: a.distributorId,
    link:
      a.resourceId && UUID.test(a.resourceId)
        ? { entity: a.resource, id: a.resourceId }
        : null,
  };
}

export function itemDeCorrida(r: ProcessRun): TraceItemDto {
  const duracion =
    r.durationMs ??
    (r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null);
  const detalle = [r.trigger, duracion === null ? null : `${duracion} ms`]
    .filter(Boolean)
    .join(', ');
  return {
    at: r.startedAt,
    kind: TraceItemKind.PROCESS_RUN,
    summary: `${CATALOGO[r.process].title} — ${r.status} (${detalle})`,
    distributorId: r.distributorId,
    link: { entity: 'process-run', id: r.runId },
  };
}

export function itemDeAviso(n: AdminNotification): TraceItemDto {
  return {
    at: n.createdAt,
    kind: TraceItemKind.NOTIFICATION,
    summary: `Aviso ${n.kind}${n.distributorId ? '' : ' a la plataforma'}`,
    distributorId: n.distributorId,
    link: { entity: 'admin-notification', id: n.notificationId },
  };
}
