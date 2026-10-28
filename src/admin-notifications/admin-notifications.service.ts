import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { codigoSqlDelError } from '../common/errors/db-exceptions';
import { NotificarAdminEvent } from '../common/events/notificar-admin.event';
import { AdminNotificationMapper } from './admin-notifications.mapper';
import {
  AdminNotificationListResponseDto,
  AdminNotificationResponseDto,
  ReadAllResponseDto,
  UnreadCountResponseDto,
} from './dto/admin-notification-response.dto';
import { QueryAdminNotificationsDto } from './dto/query-admin-notifications.dto';
import { AdminNotification } from './entities/admin-notification.entity';
import { AdminNotificationRead } from './entities/admin-notification-read.entity';

const UNICO_VIOLADO = '23505';
const TITULO_MAX = 160;

/**
 * La bandeja de avisos de los administradores. Los avisos son de la
 * distribuidora; la lectura es de cada admin. `distributorId` `null` es el
 * super admin sin `X-Distributor`: ve las bandejas de todas las empresas.
 */
@Injectable()
export class AdminNotificationsService {
  constructor(
    @InjectRepository(AdminNotification)
    private readonly avisos: Repository<AdminNotification>,
    @InjectRepository(AdminNotificationRead)
    private readonly lecturas: Repository<AdminNotificationRead>,
  ) {}

  /**
   * Guarda el aviso. Devuelve `null` si esa distribuidora ya tiene uno con la
   * misma `dedupeKey` (no se repite ni se vuelve a avisar). La consulta previa
   * es el camino normal; el único `(distributor_id, dedupe_key)` de la base
   * cubre a dos emisores simultáneos: el segundo `save` falla con 23505 y se
   * toma como repetido. Se usa `save` para que la auditoría de datos lo registre.
   */
  async registrar(
    evento: NotificarAdminEvent,
  ): Promise<AdminNotification | null> {
    const existente = await this.avisos.findOne({
      where: {
        distributorId: evento.distributorId,
        dedupeKey: evento.dedupeKey,
      },
      select: { notificationId: true },
    });
    if (existente) return null;

    const aviso = this.avisos.create({
      distributorId: evento.distributorId,
      kind: evento.kind,
      title: evento.title.slice(0, TITULO_MAX),
      body: evento.body,
      linkEntity: evento.link?.entity ?? null,
      linkId: evento.link?.id ?? null,
      dedupeKey: evento.dedupeKey,
      email: evento.email,
      emailedAt: null,
    });
    try {
      return await this.avisos.save(aviso);
    } catch (error) {
      if (codigoSqlDelError(error) === UNICO_VIOLADO) return null;
      throw error;
    }
  }

  /** Deja anotado que el correo del aviso salió. */
  async marcarCorreoEnviado(aviso: AdminNotification): Promise<void> {
    aviso.emailedAt = new Date();
    await this.avisos.save(aviso);
  }

  async listar(
    userId: string,
    distributorId: string | null,
    query: QueryAdminNotificationsDto,
  ): Promise<AdminNotificationListResponseDto> {
    const qb = this.delAlcance(distributorId);
    if (query.unread !== undefined) {
      this.filtrarLeidos(qb, userId, query.unread ? 'sin_leer' : 'leidos');
    }
    const [avisos, total] = await qb
      .orderBy('n.createdAt', 'DESC')
      .addOrderBy('n.notificationId', 'DESC')
      .take(query.limit)
      .skip(query.offset)
      .getManyAndCount();

    const lecturas = avisos.length
      ? await this.lecturas.find({
          where: {
            userId,
            notificationId: In(avisos.map((a) => a.notificationId)),
          },
        })
      : [];
    const leidoEn = new Map(lecturas.map((l) => [l.notificationId, l.readAt]));
    return {
      items: avisos.map((a) =>
        AdminNotificationMapper.toDto(a, leidoEn.get(a.notificationId) ?? null),
      ),
      total,
    };
  }

  async contarSinLeer(
    userId: string,
    distributorId: string | null,
  ): Promise<UnreadCountResponseDto> {
    const qb = this.delAlcance(distributorId);
    this.filtrarLeidos(qb, userId, 'sin_leer');
    return { count: await qb.getCount() };
  }

  /** Idempotente: marcar dos veces deja la primera fecha. Un aviso de otra empresa es 404. */
  async marcarLeido(
    userId: string,
    distributorId: string | null,
    notificationId: string,
  ): Promise<AdminNotificationResponseDto> {
    const aviso = await this.delAlcance(distributorId)
      .andWhere('n.notificationId = :notificationId', { notificationId })
      .getOne();
    if (!aviso) throw new NotFoundException('No existe ese aviso');

    let lectura = await this.lecturas.findOneBy({ notificationId, userId });
    if (!lectura) {
      try {
        lectura = await this.lecturas.save(
          this.lecturas.create({ notificationId, userId, readAt: new Date() }),
        );
      } catch (error) {
        // Otra solicitud lo marcó en el mismo instante: ya está leído.
        if (codigoSqlDelError(error) !== UNICO_VIOLADO) throw error;
        lectura = await this.lecturas.findOneByOrFail({
          notificationId,
          userId,
        });
      }
    }
    return AdminNotificationMapper.toDto(aviso, lectura.readAt);
  }

  /** Marca como leídos los avisos sin leer del alcance de quien pide. */
  async marcarTodosLeidos(
    userId: string,
    distributorId: string | null,
  ): Promise<ReadAllResponseDto> {
    const qb = this.delAlcance(distributorId).select('n.notificationId');
    this.filtrarLeidos(qb, userId, 'sin_leer');
    const pendientes = await qb.getMany();
    if (pendientes.length === 0) return { updated: 0 };

    // Una lectura por aviso, cada una por su cuenta: si otra solicitud ya marcó
    // alguno (abrirlo, otra pestaña), ése se saltea sin deshacer los demás ni
    // pisar la fecha en que se leyó primero. `insert` (no `save`) para que
    // nunca sea un UPDATE; igual pasa por el subscriber de auditoría.
    const ahora = new Date();
    let marcados = 0;
    for (const { notificationId } of pendientes) {
      try {
        await this.lecturas.insert({ notificationId, userId, readAt: ahora });
        marcados++;
      } catch (error) {
        if (codigoSqlDelError(error) !== UNICO_VIOLADO) throw error;
      }
    }
    return { updated: marcados };
  }

  private delAlcance(
    distributorId: string | null,
  ): SelectQueryBuilder<AdminNotification> {
    const qb = this.avisos.createQueryBuilder('n');
    if (distributorId) {
      qb.where('n.distributorId = :distributorId', { distributorId });
    } else {
      qb.where('1 = 1');
    }
    return qb;
  }

  private filtrarLeidos(
    qb: SelectQueryBuilder<AdminNotification>,
    userId: string,
    cuales: 'sin_leer' | 'leidos',
  ): void {
    const existe = `EXISTS (SELECT 1 FROM admin_notification_read r WHERE r.notification_id = n.notification_id AND r.user_id = :userId)`;
    qb.andWhere(cuales === 'sin_leer' ? `NOT ${existe}` : existe, { userId });
  }
}
