import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Order, OrderStatus } from '../entities/order.entity';
import { transitionOrder } from '../domain/order-status.machine';
import { releaseDriverAssignment } from '../domain/release-driver-assignment';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';

/**
 * Camino ÚNICO para volver un pedido a PENDING liberando al chofer que tenía
 * asignado. Lo usan, con el MISMO efecto:
 *  - `PATCH /orders/:id/status` con `status: pending` (admin que destraba a
 *    mano, o el propio chofer).
 *  - `PATCH /orders/:id/cancel` cuando el actor es el chofer (libera, no
 *    cancela — ver `CancelOrderUseCase`).
 *
 * `POST /orders/:id/reject` sobre una asignación MANUAL NO pasa por acá: no
 * se libera sólo porque el chofer rechazó o dejó vencer el aviso (ver la
 * segunda revisión, punto 1) — se avisa a los admins y el pedido queda
 * exactamente igual (ver `OrderService.rejectOffer`).
 *
 * Antes cada camino limpiaba el pedido a su manera (y alguno ni lo hacía);
 * unificado acá, los dos dejan el pedido exactamente igual: sin chofer, sin
 * tracking, sin oferta colgada, y con los mismos tres avisos (chofer
 * anterior, cliente, admins).
 */
@Injectable()
export class ReleaseOrderUseCase {
  constructor(
    private readonly dataSource: DataSource,
    private readonly dispatch: RealtimeDispatchPort,
    private readonly dispatchOrchestrator: DispatchOrchestratorService,
  ) {}

  /**
   * Re-lee el pedido con lock pesimista (protege contra dos liberaciones/
   * cancelaciones concurrentes del mismo pedido), aplica la liberación y
   * guarda, todo en una transacción. Las notificaciones son best-effort y
   * corren DESPUÉS del commit.
   *
   * `expectedDriverUserId` (segunda revisión, punto 6): si se pasa, revalida
   * DUEÑO con el dato que acaba de traer el lock (no con el que se leyó
   * antes de pedirlo) — si entre ese chequeo externo y conseguir el lock el
   * pedido se reasignó a otro chofer, esta relectura lo frena ACÁ, con 403,
   * en vez de liberar un pedido que ya no es del que llamó. El ESTADO ya se
   * revalida solo: `applyRelease` corre `transitionOrder` sobre el dato
   * recién lockeado, así que una cancelación concurrente que ya haya hecho
   * commit también corta acá (con 400).
   */
  async execute(
    orderId: string,
    expectedDriverUserId?: string,
  ): Promise<Order> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let order: Order;
    let previousDriverUserId: string | null;
    try {
      // `FOR UPDATE OF "ord"` (tercer argumento de setLock): sin acotar la
      // tabla, Postgres rechaza el lock con "FOR UPDATE cannot be applied to
      // the nullable side of an outer join" — `delivery` es un LEFT JOIN
      // (el pedido puede no tener chofer) y el error sale SIEMPRE, con o sin
      // chofer asignado (verificado contra la base real). Alias `ord`, no
      // `order`: TypeORM no cita el nombre de la tabla en `FOR UPDATE OF`, y
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

      if (
        expectedDriverUserId &&
        locked.delivery?.userId !== expectedDriverUserId
      ) {
        throw new ForbiddenException(
          'Este pedido no está asignado a tu usuario',
        );
      }

      previousDriverUserId = this.applyRelease(locked);
      order = await queryRunner.manager.save(locked);
      await queryRunner.commitTransaction();
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }

    await this.notifyReleased(order, previousDriverUserId);
    return order;
  }

  /**
   * Mutación PURA: transiciona a PENDING (no-op si ya lo estaba) y limpia la
   * asignación. Sin I/O propio — la usa `CancelOrderUseCase` para aplicarla
   * DENTRO de su propia transacción con lock (rol `driver`), en vez de abrir
   * una segunda transacción/lock sobre el mismo pedido.
   *
   * Devuelve el `user_id` del chofer que tenía el pedido (o null), para que
   * el caller dispare `notifyReleased` con el mismo dato una vez que su
   * transacción haga commit.
   */
  applyRelease(order: Order): string | null {
    transitionOrder(order, OrderStatus.PENDING);
    const previousDriverUserId = order.delivery?.userId ?? null;
    releaseDriverAssignment(order);
    return previousDriverUserId;
  }

  /**
   * Side-effects best-effort de una liberación, SIEMPRE los mismos sin
   * importar el camino que llegó acá: corta el tracking del chofer anterior,
   * cierra cualquier oferta de despacho que hubiera quedado, le avisa a ÉL
   * (sala `driver_<user_id>`, nunca por `deliveryId`: son ids distintos), al
   * cliente (vuelve a buscar chofer) y al panel. Nunca dispara el push de
   * "¡Pedido Confirmado!" (ese es sólo para pedidos nuevos).
   */
  async notifyReleased(
    order: Order,
    previousDriverUserId: string | null,
  ): Promise<void> {
    if (previousDriverUserId) {
      this.dispatch.stopTracking(previousDriverUserId);
      await this.dispatchOrchestrator
        .releaseOffer(order.orderId, previousDriverUserId)
        .catch(() => undefined);
      this.dispatch.notifyDriverOrderCancelled(previousDriverUserId, {
        orderId: order.orderId,
        status: order.status,
        message: 'El pedido se liberó. No hace falta que vayas.',
      });
    } else {
      await this.dispatchOrchestrator
        .onOrderClosed(order.orderId)
        .catch(() => undefined);
    }

    this.dispatch.notifyCustomer(order.customerId, 'order:searching-driver', {
      orderId: order.orderId,
      status: order.status,
    });

    this.dispatch.notifyAdmins(
      'order:pending',
      { orderId: order.orderId, status: order.status },
      order.distributorId,
    );
  }
}
