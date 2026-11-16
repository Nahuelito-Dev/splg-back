import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { Order, OrderStatus, PaymentMethod } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { transitionOrder } from '../domain/order-status.machine';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { ReleaseOrderUseCase } from './release-order.use-case';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import { RoleType } from '../../common/constants/role-type.enum';
import { RefundsService } from '../../payments/application/refunds.service';
import { PaymentsService } from '../../payments/application/payments.service';
import { errorMessage } from '../../common/errors/error-message';
import { DispatchOfferRepositoryPort } from '../domain/ports/dispatch-offer.repository.port';
import { DispatchOfferStatus } from '../entities/dispatch-offer.entity';

/**
 * Quién dispara la cancelación (define la política de estado y stock).
 * `system`: un proceso automático, sin usuario (el vencimiento sin chofer).
 */
export type CancelActor =
  | 'customer'
  | 'driver'
  | 'admin'
  | 'superadmin'
  | 'system';

/** Los actores que llegan desde un request (todos menos el sistema). */
export type UserCancelActor = Exclude<CancelActor, 'system'>;

/**
 * Condición que se evalúa con el pedido ya bloqueado (y sus renglones leídos),
 * dentro de la transacción: si da `false`, no se cancela y no queda ningún
 * efecto ni aviso. La usan los procesos automáticos para re-decidir con el
 * dato fresco lo que eligieron antes de pedir el lock.
 */
export type CondicionBajoLock = (
  locked: Order,
  manager: EntityManager,
) => Promise<boolean>;

/** Opciones de `execute` para los procesos automáticos. */
export interface CancelOrderOptions {
  siSigueCorrespondiendo?: CondicionBajoLock;
}

/** Quién canceló, como lo ve el cliente en `order:cancelled` y en `GET /orders/:id`. */
export type CancelledBy = 'customer' | 'admin' | 'system' | 'driver';

/** El super admin cuenta como administrador. */
export function cancelledByDe(actor: CancelActor): CancelledBy {
  return actor === 'superadmin' ? 'admin' : actor;
}

/**
 * Traduce el rol autenticado (RoleType) al actor que espera `execute`.
 * super_admin se trata como admin. Único lugar de este mapeo: lo usan el
 * controller (`PATCH /orders/:id/cancel`) y `UpdateOrderStatusUseCase` (cuando
 * `PATCH /orders/:id/status` delega la cancelación acá).
 */
export function mapRoleToCancelActor(role?: RoleType): UserCancelActor {
  switch (role) {
    case RoleType.CUSTOMER:
      return 'customer';
    case RoleType.DELIVERY:
      return 'driver';
    default:
      return 'admin';
  }
}

/**
 * Caso de uso: cancelar (o liberar) un pedido.
 *
 * La política depende del actor:
 *  - customer/admin → CANCELLED + restitución de stock.
 *  - driver → NO cancela: libera el pedido a PENDING (re-dispatch) sin tocar
 *    stock, por el camino ÚNICO de liberación (`ReleaseOrderUseCase`, el
 *    mismo que usan `PATCH /status` con `pending` y `POST /reject` sobre una
 *    asignación manual).
 *
 * TODO (ownership + estado + política + guardado) corre dentro de UNA sola
 * transacción con lock pesimista sobre el pedido: dos cancelaciones
 * concurrentes del mismo pedido no pueden devolver el stock dos veces —
 * la segunda, al re-leer con el lock, ya ve el `status` que dejó la primera
 * (`CANCELLED`) y corta con 400 antes de tocar nada. Los avisos de tiempo
 * real son best-effort y corren DESPUÉS del commit.
 */
export const MENSAJE_MOTIVO_OBLIGATORIO =
  'Para cancelar el pedido hay que indicar el motivo';

@Injectable()
export class CancelOrderUseCase {
  private readonly logger = new Logger(CancelOrderUseCase.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly stock: GasCylinderService,
    private readonly dispatch: RealtimeDispatchPort,
    private readonly releaseOrder: ReleaseOrderUseCase,
    private readonly dispatchOrchestrator: DispatchOrchestratorService,
    private readonly refunds: RefundsService,
    private readonly payments: PaymentsService,
    private readonly offers: DispatchOfferRepositoryPort,
  ) {}

  async execute(
    orderId: string,
    userId: string,
    role: CancelActor,
    reason?: string,
    opciones: CancelOrderOptions = {},
  ): Promise<Order> {
    // El chofer no cancela: devuelve el pedido al pool. Quien sí cancela
    // (cliente, administrador) tiene que dejar el motivo.
    const motivo = reason?.trim() ?? '';
    if (role !== 'driver' && motivo === '') {
      throw new BadRequestException(MENSAJE_MOTIVO_OBLIGATORIO);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let order: Order;
    let previousDriverUserId: string | null;
    let ofertasRetiradas: string[] = [];
    try {
      // `FOR UPDATE OF "ord"` (tercer argumento de setLock): sin acotar la
      // tabla, Postgres rechaza el lock con "FOR UPDATE cannot be applied to
      // the nullable side of an outer join" — `delivery`/`items` son LEFT
      // JOIN y el error sale SIEMPRE (verificado contra la base real). Alias
      // `ord`, no `order`: TypeORM no cita el nombre en `FOR UPDATE OF`, y
      // `order` es palabra reservada de SQL → "syntax error at or near
      // order" (verificado también contra la base real).
      const locked = await queryRunner.manager
        .createQueryBuilder(Order, 'ord')
        .setLock('pessimistic_write', undefined, ['ord'])
        .leftJoinAndSelect('ord.delivery', 'delivery')
        .where('ord.orderId = :id', { id: orderId })
        .getOne();

      if (!locked) {
        throw new NotFoundException('Pedido no encontrado');
      }

      // Los renglones se leen DESPUÉS del lock y en una consulta aparte: en
      // READ COMMITTED, un SELECT que esperó el lock re-lee la fila del pedido
      // pero no los renglones que otra transacción cambió en el medio (una
      // edición), y se devolvería stock de renglones viejos.
      locked.items = await queryRunner.manager.find(OrderItem, {
        where: { orderId },
      });

      // Antes que el estado: quién pide tiene que poder tocar este pedido. El
      // cliente, sólo los suyos (lo ajeno = 404); el chofer, sólo el que tiene
      // asignado.
      if (role === 'customer' && locked.customerId !== userId) {
        throw new NotFoundException('Pedido no encontrado');
      }
      if (role === 'driver' && locked.delivery?.userId !== userId) {
        throw new ForbiddenException(
          'Este pedido no está asignado a tu usuario',
        );
      }

      // Re-chequeado DENTRO del lock (no con el dato leído antes de pedirlo):
      // si esta cancelación pierde la carrera contra otra concurrente, ve el
      // estado que dejó la que ganó y corta acá, sin devolver el stock de
      // nuevo.
      if (
        locked.status === OrderStatus.DELIVERED ||
        locked.status === OrderStatus.CANCELLED
      ) {
        throw new BadRequestException(
          'No se puede cancelar un pedido finalizado',
        );
      }

      // Lo que eligió un proceso automático antes del lock se re-decide acá,
      // con la fila bloqueada: si ya no corresponde, no queda nada hecho.
      if (
        opciones.siSigueCorrespondiendo &&
        !(await opciones.siSigueCorrespondiendo(locked, queryRunner.manager))
      ) {
        await queryRunner.rollbackTransaction();
        return locked;
      }

      // El driver_id de una oferta (DispatchOffer) y las salas de socket del
      // chofer son por `user_id`, no por `order.deliveryId` (el id de su
      // perfil de reparto: son ids distintos).
      previousDriverUserId = locked.delivery?.userId ?? null;

      if (role === 'driver') {
        // Mutación pura del camino único, aplicada DENTRO de esta misma
        // transacción/lock (no abre una segunda sobre el mismo pedido).
        await this.releaseOrder.releaseWithin(queryRunner.manager, locked);
      } else {
        if (role === 'customer' && locked.status === OrderStatus.ON_THE_WAY) {
          throw new BadRequestException(
            'El pedido ya está en camino. Contacte al soporte.',
          );
        }
        transitionOrder(locked, OrderStatus.CANCELLED);
        locked.cancellationReason = motivo;
        await this.releaseOrder.borrarVaciasDeclaradas(
          queryRunner.manager,
          locked,
        );
        await this.stock.restituirStock(queryRunner.manager, locked.items);
        // La oferta que un chofer tenía en pantalla deja de valer en la misma
        // transacción: no puede aceptar un pedido cancelado.
        ofertasRetiradas = await this.offers.withdrawOtherActiveOffers(
          queryRunner.manager,
          orderId,
          null,
          DispatchOfferStatus.SUPERSEDED,
        );
      }

      order = await queryRunner.manager.save(locked);
      await queryRunner.commitTransaction();
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }

    if (role === 'driver') {
      await this.releaseOrder.notifyReleased(order, previousDriverUserId);
    } else {
      await this.dispatchOrchestrator
        .onOrderClosed(order.orderId)
        .catch(() => undefined);
      this.notify(order, previousDriverUserId, role);
      for (const driverUserId of ofertasRetiradas) {
        this.dispatch.notifyDriverOrderCancelled(driverUserId, {
          orderId: order.orderId,
          status: order.status,
          message: 'El pedido se canceló: la oferta ya no está vigente',
        });
      }
      // La cancelación no espera a la pasarela: la devolución sale aparte, con
      // su error registrado, y si falla la retoma el administrador.
      void this.reintegrarPago(order.orderId);
      // El enlace de pago de Mercado Pago deja de cobrar: sin esto el cliente podría
      // pagar un pedido cancelado (y el dinero habría que devolverlo).
      if (order.paymentMethod === PaymentMethod.MERCADOPAGO) {
        void this.payments.cerrarCheckoutsDelPedido(order.orderId);
      }
    }

    return order;
  }

  /**
   * CU-168 (extiende CU-008 y CU-010): si el pedido tenía un pago aprobado por
   * una pasarela, se pide la devolución. Corre después del commit y no puede
   * deshacer ni demorar la cancelación: si la pasarela falla, queda registrado
   * para que el administrador lo reintente.
   */
  private async reintegrarPago(orderId: string): Promise<void> {
    try {
      await this.refunds.reintegrarPorCancelacion(orderId);
    } catch (error) {
      this.logger.error(
        `No se pudo pedir la devolución del pedido cancelado ${orderId}: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Avisos de tiempo real de una cancelación REAL (customer/admin). El payload
   * lleva `cancelledBy` (`customer` o `admin`; el super admin cuenta como
   * `admin`) además del motivo.
   */
  private notify(
    order: Order,
    previousDriverUserId: string | null,
    role: CancelActor,
  ): void {
    const payload = {
      orderId: order.orderId,
      status: order.status,
      reason: order.cancellationReason,
      cancelledBy: cancelledByDe(role),
    };

    this.dispatch.notifyCustomer(order.customerId, 'order:cancelled', payload);

    // El chofer que tenía el pedido: por `user_id` (sala `driver_<user_id>`),
    // NUNCA por `order.deliveryId` (el id de su perfil de reparto, otro id).
    if (previousDriverUserId) {
      // Segunda revisión, punto 3: cancelar un pedido ACCEPTED/ON_THE_WAY por
      // CUALQUIER puerta corta el tracking del chofer que lo tenía. Antes
      // sólo lo hacía `ReleaseOrderUseCase` (cuando el actor es el propio
      // chofer); esta rama (customer/admin cancelan de verdad) no lo hacía.
      // Inofensivo si el pedido todavía no estaba ON_THE_WAY (no hay nada
      // que cortar, `stopTracking` sólo limpia una clave de Redis).
      this.dispatch.stopTracking(previousDriverUserId);
      this.dispatch.notifyDriverOrderCancelled(previousDriverUserId, {
        ...payload,
        message: 'El cliente canceló el pedido. No es necesario ir.',
      });
    }

    this.dispatch.notifyAdmins('order:cancelled', payload, order.distributorId);
  }
}
