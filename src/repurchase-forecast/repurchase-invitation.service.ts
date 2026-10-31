import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import { PaymentMethod } from '../order/entities/order.entity';
import {
  RepurchaseEstimateSource,
  RepurchaseInvitation,
  RepurchaseInvitationStatus,
  SuggestedItem,
} from './entities/repurchase-invitation.entity';

const MS_POR_DIA = 86_400_000;
const UNICO_VIOLADO = '23505';
/** Hasta dónde mira atrás la última invitación de un cliente. */
const HISTORIAL_DIAS = 400;

/** Lo que hace falta para abrir una invitación. */
export interface NuevaInvitacion {
  distributorId: string;
  userId: string;
  addressId: string;
  timeSlotId: string | null;
  paymentMethod: PaymentMethod;
  projectedDepletionAt: Date;
  estimateSource: RepurchaseEstimateSource;
  suggestedItems: SuggestedItem[];
  expiresAt: Date;
}

export interface FiltroDeInvitaciones {
  status?: RepurchaseInvitationStatus;
  userId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

export interface ResumenDeInvitaciones {
  counts: Record<RepurchaseInvitationStatus, number>;
  /** Pedidos creados por invitaciones aceptadas en el período. */
  acceptedRevenue: number;
}

const MENSAJE_POR_ESTADO: Readonly<
  Record<Exclude<RepurchaseInvitationStatus, 'pending'>, string>
> = {
  [RepurchaseInvitationStatus.ACCEPTED]:
    'La invitación ya fue aceptada: el pedido está creado',
  [RepurchaseInvitationStatus.REJECTED]: 'La invitación ya fue descartada',
  [RepurchaseInvitationStatus.EXPIRED]: 'La invitación venció',
  [RepurchaseInvitationStatus.CANCELLED]:
    'La invitación se cerró porque ya hiciste un pedido',
};

/**
 * Las invitaciones de recompra (CU-106): su ciclo de vida y las lecturas del
 * administrador. Toda transición es una sola sentencia condicionada al estado
 * `pending`, así dos respuestas simultáneas (o una respuesta y el vencimiento)
 * no se pisan.
 */
@Injectable()
export class RepurchaseInvitationService {
  private readonly logger = new Logger(RepurchaseInvitationService.name);

  constructor(
    @InjectRepository(RepurchaseInvitation)
    private readonly repo: Repository<RepurchaseInvitation>,
  ) {}

  /** Abre una invitación; `null` si el cliente ya tiene una abierta (otra corrida se adelantó). */
  async abrir(datos: NuevaInvitacion): Promise<RepurchaseInvitation | null> {
    try {
      return await this.repo.save(this.repo.create(datos));
    } catch (error) {
      if ((error as { code?: string }).code === UNICO_VIOLADO) {
        this.logger.warn(
          `Invitación duplicada evitada (cliente ${datos.userId}, distribuidora ${datos.distributorId})`,
        );
        return null;
      }
      throw error;
    }
  }

  /**
   * La última invitación de cada cliente de la distribuidora (de los últimos
   * `HISTORIAL_DIAS`), para decidir si se le vuelve a ofrecer: no antes del
   * intervalo mínimo y, como mucho, una por ciclo de consumo.
   */
  async ultimasPorCliente(
    distributorId: string,
    ahora: Date,
  ): Promise<Map<string, RepurchaseInvitation>> {
    const recientes = await this.repo.find({
      where: {
        distributorId,
        createdAt: MoreThan(
          new Date(ahora.getTime() - HISTORIAL_DIAS * MS_POR_DIA),
        ),
      },
      order: { createdAt: 'DESC' },
    });
    const ultimas = new Map<string, RepurchaseInvitation>();
    for (const invitacion of recientes) {
      if (!ultimas.has(invitacion.userId)) {
        ultimas.set(invitacion.userId, invitacion);
      }
    }
    return ultimas;
  }

  /** Pasa a «vencida» las abiertas cuya vigencia terminó (de una distribuidora o de todas). */
  async vencerVencidas(
    ahora: Date,
    distributorId?: string,
  ): Promise<RepurchaseInvitation[]> {
    const vencidas = await this.repo.find({
      where: {
        status: RepurchaseInvitationStatus.PENDING,
        expiresAt: LessThanOrEqual(ahora),
        ...(distributorId ? { distributorId } : {}),
      },
    });
    if (vencidas.length === 0) return [];
    const r = await this.repo
      .createQueryBuilder()
      .update(RepurchaseInvitation)
      .set({ status: RepurchaseInvitationStatus.EXPIRED, respondedAt: ahora })
      .where('invitation_id IN (:...ids)', {
        ids: vencidas.map((v) => v.invitationId),
      })
      .andWhere('status = :abierta', {
        abierta: RepurchaseInvitationStatus.PENDING,
      })
      .returning('invitation_id')
      .execute();
    const cerradas = new Set(
      (r.raw as Array<{ invitation_id: string }>).map((f) => f.invitation_id),
    );
    return vencidas.filter((v) => cerradas.has(v.invitationId));
  }

  /** Las invitaciones abiertas de una distribuidora (o de todas). */
  abiertas(distributorId?: string): Promise<RepurchaseInvitation[]> {
    return this.repo.find({
      where: {
        status: RepurchaseInvitationStatus.PENDING,
        ...(distributorId ? { distributorId } : {}),
      },
    });
  }

  /** La invitación del cliente, o 404 si no existe o es de otro. */
  async delCliente(
    invitationId: string,
    userId: string,
  ): Promise<RepurchaseInvitation> {
    const invitacion = await this.repo.findOne({
      where: { invitationId, userId },
    });
    if (!invitacion) throw new NotFoundException('Invitación no encontrada');
    return invitacion;
  }

  /** Las invitaciones del cliente, la más nueva primero; abiertas y vigentes por omisión. */
  listarDelCliente(
    userId: string,
    opciones: {
      distributorId?: string;
      /** Sólo las que todavía se pueden aceptar a `ahora`. */
      abiertasA?: Date;
    },
  ): Promise<RepurchaseInvitation[]> {
    return this.repo.find({
      where: {
        userId,
        ...(opciones.distributorId
          ? { distributorId: opciones.distributorId }
          : {}),
        ...(opciones.abiertasA
          ? {
              status: RepurchaseInvitationStatus.PENDING,
              expiresAt: MoreThan(opciones.abiertasA),
            }
          : {}),
      },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  /** El cliente descarta su invitación abierta. 409 si ya no está abierta. */
  async descartar(
    invitationId: string,
    userId: string,
    ahora: Date,
  ): Promise<RepurchaseInvitation> {
    const invitacion = await this.delCliente(invitationId, userId);
    const cerrada = await this.cerrar(
      invitacion.invitationId,
      RepurchaseInvitationStatus.REJECTED,
      ahora,
    );
    if (!cerrada) this.rechazarPorEstado(await this.releer(invitationId));
    return this.releer(invitationId);
  }

  /** Cierra sin efecto la invitación abierta (el cliente compró por su cuenta). */
  cancelar(invitationId: string, ahora: Date): Promise<boolean> {
    return this.cerrar(
      invitationId,
      RepurchaseInvitationStatus.CANCELLED,
      ahora,
    );
  }

  /**
   * Registra que la aceptó: el pedido ya está creado, así que la aceptación
   * gana sobre cualquier otro estado (vencida, descartada o cerrada por pedido
   * propio en el medio): nunca queda un pedido creado con la invitación en otro
   * estado.
   */
  async aceptada(
    invitationId: string,
    orderId: string,
    ahora: Date,
  ): Promise<RepurchaseInvitation> {
    await this.repo
      .createQueryBuilder()
      .update(RepurchaseInvitation)
      .set({
        status: RepurchaseInvitationStatus.ACCEPTED,
        respondedAt: ahora,
        orderId,
      })
      .where('invitation_id = :invitationId', { invitationId })
      .andWhere('status != :aceptada', {
        aceptada: RepurchaseInvitationStatus.ACCEPTED,
      })
      .execute();
    return this.releer(invitationId);
  }

  /** Lanza 409 con el motivo si la invitación no está abierta. */
  exigirAbierta(invitacion: RepurchaseInvitation): void {
    if (invitacion.status !== RepurchaseInvitationStatus.PENDING) {
      this.rechazarPorEstado(invitacion);
    }
  }

  /** Listado del administrador: las de su distribuidora, con el cliente. */
  async listar(
    distributorId: string,
    filtro: FiltroDeInvitaciones,
  ): Promise<[RepurchaseInvitation[], number]> {
    const qb = this.repo
      .createQueryBuilder('inv')
      .leftJoinAndSelect('inv.user', 'user')
      .leftJoinAndSelect('user.customer', 'customer')
      .where('inv.distributorId = :distributorId', { distributorId })
      .orderBy('inv.createdAt', 'DESC')
      .addOrderBy('inv.invitationId', 'ASC')
      .take(filtro.limit)
      .skip(filtro.offset);
    if (filtro.status) qb.andWhere('inv.status = :status', filtro);
    if (filtro.userId) qb.andWhere('inv.userId = :userId', filtro);
    if (filtro.from) qb.andWhere('inv.createdAt >= :from', filtro);
    if (filtro.to) qb.andWhere('inv.createdAt < :to', filtro);
    return qb.getManyAndCount();
  }

  /** Cuántas invitaciones hay por estado en el período y lo que vendieron las aceptadas. */
  async resumen(
    distributorId: string,
    desde: Date,
    hasta: Date,
  ): Promise<ResumenDeInvitaciones> {
    const filas = await this.repo
      .createQueryBuilder('inv')
      .select('inv.status', 'status')
      .addSelect('COUNT(*)', 'n')
      .where('inv.distributorId = :distributorId', { distributorId })
      .andWhere('inv.createdAt >= :desde AND inv.createdAt < :hasta', {
        desde,
        hasta,
      })
      .groupBy('inv.status')
      .getRawMany<{ status: RepurchaseInvitationStatus; n: string }>();
    const counts = Object.fromEntries(
      Object.values(RepurchaseInvitationStatus).map((s) => [s, 0]),
    ) as Record<RepurchaseInvitationStatus, number>;
    for (const f of filas) counts[f.status] = Number(f.n);

    const ingresos = await this.repo
      .createQueryBuilder('inv')
      .innerJoin('inv.order', 'ord')
      .select('COALESCE(SUM(ord.totalAmount), 0)', 'total')
      .where('inv.distributorId = :distributorId', { distributorId })
      .andWhere('inv.status = :aceptada', {
        aceptada: RepurchaseInvitationStatus.ACCEPTED,
      })
      .andWhere('inv.createdAt >= :desde AND inv.createdAt < :hasta', {
        desde,
        hasta,
      })
      .andWhere('ord.status != :cancelado', { cancelado: 'cancelled' })
      .getRawOne<{ total: string }>();
    return { counts, acceptedRevenue: Number(ingresos?.total ?? 0) };
  }

  /** Las abiertas de la distribuidora para los clientes dados: se ven en el listado de próximas recompras. */
  async abiertasDe(
    distributorId: string,
    userIds: readonly string[],
  ): Promise<Map<string, RepurchaseInvitation>> {
    if (userIds.length === 0) return new Map();
    const abiertas = await this.repo.find({
      where: {
        distributorId,
        userId: In([...userIds]),
        status: RepurchaseInvitationStatus.PENDING,
      },
    });
    return new Map(abiertas.map((i) => [i.userId, i]));
  }

  private async cerrar(
    invitationId: string,
    estado: RepurchaseInvitationStatus,
    ahora: Date,
  ): Promise<boolean> {
    const r = await this.repo
      .createQueryBuilder()
      .update(RepurchaseInvitation)
      .set({ status: estado, respondedAt: ahora })
      .where('invitation_id = :invitationId', { invitationId })
      .andWhere('status = :abierta', {
        abierta: RepurchaseInvitationStatus.PENDING,
      })
      .execute();
    return (r.affected ?? 0) > 0;
  }

  private async releer(invitationId: string): Promise<RepurchaseInvitation> {
    return this.repo.findOneOrFail({ where: { invitationId } });
  }

  private rechazarPorEstado(invitacion: RepurchaseInvitation): never {
    const estado = invitacion.status as Exclude<
      RepurchaseInvitationStatus,
      'pending'
    >;
    throw new ConflictException(
      MENSAJE_POR_ESTADO[estado] ?? 'La invitación ya no está abierta',
    );
  }
}
