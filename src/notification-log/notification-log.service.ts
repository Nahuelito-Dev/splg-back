import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  finDelDiaArgentino,
  inicioDelDiaArgentino,
} from '../common/utils/dias-argentina';
import {
  NotificationLogItemDto,
  NotificationLogPageDto,
  QueryNotificationLogDto,
} from './dto/notification-log.dto';
import { NotificationLog } from './entities/notification-log.entity';

export function avisoADto(fila: NotificationLog): NotificationLogItemDto {
  const dto = new NotificationLogItemDto();
  dto.notificationLogId = fila.notificationLogId;
  dto.createdAt = fila.createdAt;
  dto.channel = fila.channel;
  dto.type = fila.type;
  dto.recipientMasked = fila.recipientMasked;
  dto.subject = fila.subject;
  dto.status = fila.status;
  dto.error = fila.error;
  dto.orderId = fila.relatedOrderId;
  dto.distributorId = fila.distributorId;
  return dto;
}

/**
 * Lecturas del registro de avisos, siempre dentro de una distribuidora: el
 * super admin entra con sesión de soporte de esa empresa (no hay vista global).
 * El filtro `term` usa ILIKE sobre destinatario enmascarado y asunto: queda
 * acotado por distribuidora y paginado.
 */
@Injectable()
export class NotificationLogService {
  constructor(
    @InjectRepository(NotificationLog)
    private readonly repo: Repository<NotificationLog>,
  ) {}

  async listar(
    distributorId: string,
    q: QueryNotificationLogDto,
  ): Promise<NotificationLogPageDto> {
    const limit = q.limit ?? 20;
    const offset = q.offset ?? 0;
    const consulta = this.repo.createQueryBuilder('n');
    consulta.andWhere('n.distributor_id = :distributorId', { distributorId });
    if (q.channel)
      consulta.andWhere('n.channel = :channel', { channel: q.channel });
    if (q.status) consulta.andWhere('n.status = :status', { status: q.status });
    if (q.type) consulta.andWhere('n.type = :type', { type: q.type });
    if (q.orderId) {
      consulta.andWhere('n.related_order_id = :orderId', {
        orderId: q.orderId,
      });
    }
    // El día argentino se pasa a límites de instante en la aplicación: la
    // comparación queda directa sobre `created_at` y usa el índice.
    const desde = q.from ? inicioDelDiaArgentino(q.from) : null;
    if (desde) consulta.andWhere('n.created_at >= :desde', { desde });
    const hasta = q.to ? finDelDiaArgentino(q.to) : null;
    if (hasta) consulta.andWhere('n.created_at <= :hasta', { hasta });
    const term = q.term?.trim();
    if (term) {
      consulta.andWhere(
        '(n.recipient_masked ILIKE :term OR n.subject ILIKE :term)',
        { term: `%${term.replace(/[%_\\]/g, '\\$&')}%` },
      );
    }
    const [filas, total] = await consulta
      .orderBy('n.created_at', 'DESC')
      .addOrderBy('n.notification_log_id', 'DESC')
      .take(limit)
      .skip(offset)
      .getManyAndCount();
    return { data: filas.map(avisoADto), total, limit, offset };
  }

  /** Los avisos de un pedido de la distribuidora; 404 si el pedido no es de ella. */
  async deUnPedido(
    orderId: string,
    distributorId: string,
  ): Promise<NotificationLogItemDto[]> {
    const pedido: Array<{ order_id: string }> = await this.repo.query(
      `SELECT "order_id" FROM "order" WHERE "order_id" = $1 AND "distributor_id" = $2::uuid`,
      [orderId, distributorId],
    );
    if (pedido.length === 0) {
      throw new NotFoundException('Pedido no encontrado');
    }
    const filas = await this.repo.find({
      where: { relatedOrderId: orderId, distributorId },
      order: { createdAt: 'DESC', notificationLogId: 'DESC' },
      take: 200,
    });
    return filas.map(avisoADto);
  }
}
