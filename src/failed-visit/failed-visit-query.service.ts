import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { coordenadasDePunto } from '../common/geo/punto';
import { ZONA_ARGENTINA } from '../common/utils/dias-argentina';
import {
  ETIQUETA_DE_VISITA_FALLIDA,
  FailedVisitReason,
  RevisitStatus,
} from './domain/nueva-visita';
import {
  FailedVisitDto,
  FailedVisitOrderDto,
  FailedVisitOrdersPageDto,
} from './dto/failed-visit-response.dto';
import { QueryFailedVisitsDto } from './dto/query-failed-visits.dto';
import { OrderFailedVisit } from './entities/order-failed-visit.entity';

type FilaDeVisita = OrderFailedVisit & {
  reportedByName: string | null;
  proposedTimeSlotName: string | null;
  finalTimeSlotName: string | null;
};

/**
 * Lecturas del panel sobre las visitas fallidas (C5): los pedidos con una
 * nueva visita pendiente y el historial de un pedido. Sólo consulta, siempre
 * dentro de la distribuidora.
 */
@Injectable()
export class FailedVisitQueryService {
  constructor(private readonly dataSource: DataSource) {}

  async listar(
    distributorId: string,
    q: QueryFailedVisitsDto,
  ): Promise<FailedVisitOrdersPageDto> {
    const limit = q.limit ?? 20;
    const offset = q.offset ?? 0;
    const estado = q.status ?? 'open';
    const params: unknown[] = [distributorId];
    const donde: string[] = [
      `o."distributor_id" = $1`,
      `o."failed_visit_count" > 0`,
    ];
    if (estado !== 'all') {
      donde.push(
        `o."status"::text = 'pending' AND o."delivery_id" IS NULL AND o."revisit_status" IS NOT NULL`,
      );
      if (estado !== 'open') {
        params.push(estado);
        donde.push(`o."revisit_status" = $${params.length}`);
      }
    }
    if (q.reason) {
      params.push(q.reason);
      donde.push(`v."reason" = $${params.length}`);
    }
    if (q.from) {
      params.push(q.from);
      donde.push(
        `(v."failed_at" AT TIME ZONE '${ZONA_ARGENTINA}')::date >= $${params.length}::date`,
      );
    }
    if (q.to) {
      params.push(q.to);
      donde.push(
        `(v."failed_at" AT TIME ZONE '${ZONA_ARGENTINA}')::date <= $${params.length}::date`,
      );
    }
    const term = q.term?.trim();
    if (term) {
      params.push(`%${term.replace(/[%_\\]/g, '\\$&')}%`);
      donde.push(
        `(cu."full_name" ILIKE $${params.length} OR o."order_id"::text ILIKE $${params.length})`,
      );
    }
    const desde = `
        FROM "order" o
        JOIN LATERAL (
          SELECT * FROM "order_failed_visit" fv
           WHERE fv."order_id" = o."order_id"
           ORDER BY fv."failed_at" DESC LIMIT 1
        ) v ON true
        LEFT JOIN "user" cu ON cu."user_id" = o."customer_id"
        LEFT JOIN "user_address" a ON a."address_id" = o."address_id"
        LEFT JOIN "time_slot" ts ON ts."time_slot_id" = o."time_slot_id"
        LEFT JOIN "delivery" d ON d."delivery_id" = v."delivery_id"
        LEFT JOIN "user" du ON du."user_id" = d."user_id"
       WHERE ${donde.join(' AND ')}`;
    const [{ total }]: Array<{ total: number }> = await this.dataSource.query(
      `SELECT count(*)::int AS "total" ${desde}`,
      params,
    );
    const filas: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT o."order_id" AS "orderId", o."status"::text AS "orderStatus",
              o."delivery_mode"::text AS "deliveryMode",
              o."revisit_status" AS "revisitStatus",
              o."failed_visit_count" AS "failedVisitCount",
              v."failed_at" AS "lastFailedAt", v."reason" AS "lastReason",
              v."note" AS "lastNote", v."delivery_kind" AS "lastDeliveryKind",
              v."distance_m" AS "lastDistanceMeters", v."out_of_range" AS "lastOutOfRange",
              cu."full_name" AS "customerName", cu."phone_number" AS "customerPhone",
              COALESCE(a."formattedAddress", a."street") AS "address",
              du."full_name" AS "driverName",
              to_char(o."scheduled_date", 'YYYY-MM-DD') AS "scheduledDate",
              o."time_slot_id" AS "timeSlotId", ts."name" AS "timeSlotName",
              ts."startTime" AS "windowStart", ts."endTime" AS "windowEnd",
              o."totalAmount" AS "total", o."paymentMethod"::text AS "paymentMethod",
              o."paymentStatus"::text AS "paymentStatus"
        ${desde}
        ORDER BY (o."revisit_status" = 'awaiting_admin') DESC, v."failed_at" DESC, o."order_id"
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const pagina = new FailedVisitOrdersPageDto();
    pagina.data = filas.map((f) => {
      const dto = new FailedVisitOrderDto();
      Object.assign(dto, f);
      dto.revisitStatus = (f.revisitStatus as RevisitStatus | null) ?? null;
      dto.failedVisitCount = Number(f.failedVisitCount);
      dto.lastFailedAt = new Date(f.lastFailedAt as string);
      dto.lastReasonLabel =
        ETIQUETA_DE_VISITA_FALLIDA[f.lastReason as FailedVisitReason];
      dto.lastDistanceMeters =
        f.lastDistanceMeters === null ? null : Number(f.lastDistanceMeters);
      dto.lastOutOfRange = !!f.lastOutOfRange;
      dto.total = Number(f.total);
      return dto;
    });
    pagina.total = Number(total);
    pagina.limit = limit;
    pagina.offset = offset;
    return pagina;
  }

  /** El historial de visitas fallidas de un pedido, de la más nueva a la más vieja. */
  async historial(orderId: string): Promise<FailedVisitDto[]> {
    const filas = await this.dataSource
      .getRepository(OrderFailedVisit)
      .createQueryBuilder('v')
      .leftJoin('user', 'u', 'u."user_id" = v."reported_by_user_id"')
      .leftJoin(
        'time_slot',
        'p',
        'p."time_slot_id" = v."proposed_time_slot_id"',
      )
      .leftJoin('time_slot', 'f', 'f."time_slot_id" = v."final_time_slot_id"')
      .addSelect('u."full_name"', 'reportedByName')
      .addSelect('p."name"', 'proposedTimeSlotName')
      .addSelect('f."name"', 'finalTimeSlotName')
      .where('v.orderId = :orderId', { orderId })
      .orderBy('v.failedAt', 'DESC')
      .getRawAndEntities();
    return filas.entities.map((v, i) => {
      const crudo = filas.raw[i] as Record<string, string | null>;
      return visitaADto({
        ...v,
        reportedByName: crudo.reportedByName ?? null,
        proposedTimeSlotName: crudo.proposedTimeSlotName ?? null,
        finalTimeSlotName: crudo.finalTimeSlotName ?? null,
      });
    });
  }
}

export function visitaADto(v: FilaDeVisita): FailedVisitDto {
  const punto = coordenadasDePunto(v.point);
  const dto = new FailedVisitDto();
  dto.failedVisitId = v.failedVisitId;
  dto.orderId = v.orderId;
  dto.visitNumber = v.visitNumber;
  dto.deliveryKind = v.deliveryKind;
  dto.reason = v.reason;
  dto.reasonLabel = ETIQUETA_DE_VISITA_FALLIDA[v.reason];
  dto.note = v.note ?? null;
  dto.failedAt = v.failedAt;
  dto.latitude = punto?.lat ?? null;
  dto.longitude = punto?.lng ?? null;
  dto.accuracyMeters = v.accuracyM ?? null;
  dto.distanceMeters = v.distanceM ?? null;
  dto.outOfRange = !!v.outOfRange;
  dto.reportedByRole = v.reportedByRole as FailedVisitDto['reportedByRole'];
  dto.reportedByName = v.reportedByName;
  dto.outcome = v.outcome;
  dto.agreedWithCustomer = !!v.agreedWithCustomer;
  dto.proposedDate = v.proposedDate ?? null;
  dto.proposedTimeSlotId = v.proposedTimeSlotId ?? null;
  dto.proposedTimeSlotName = v.proposedTimeSlotName;
  dto.resolution = v.resolution ?? null;
  dto.resolvedAt = v.resolvedAt ?? null;
  dto.finalDate = v.finalDate ?? null;
  dto.finalTimeSlotName = v.finalTimeSlotName;
  return dto;
}
