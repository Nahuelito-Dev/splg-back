import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import {
  Incident,
  IncidentStatus,
  IncidentType,
} from '../../incident/entities/incident.entity';
import { OrderStatusHistory } from '../entities/order-status-history.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';

/** Cómo cierra el administrador un cobro en efectivo impago. */
export type ResolucionDeImpago = 'paid' | 'written_off';

/** Resultado de una operación de cobro: el pedido y si el estado cambió. */
export interface ResultadoDeCobro<T = undefined> {
  order: Order;
  /** `false` cuando era un reintento y el pedido ya estaba en el estado pedido. */
  changed: boolean;
  /** Lo que devolvió el trabajo adicional de la misma transacción, si hubo. */
  extra: T;
}

/**
 * Caso de uso: el cobro de un pedido en EFECTIVO una vez entregado.
 *
 * Entregar no es cobrar: al pasar a DELIVERED el pago queda PENDING y recién
 * cuando el chofer confirma que cobró pasa a PAID (`confirmReceived`), o
 * informa que el cliente no pagó (`markUnpaid`, queda UNPAID y la incidencia
 * la abre el módulo `incident`). Un administrador cierra el impago como
 * cobrado después o como pérdida (`resolveUnpaid`).
 *
 * Cada operación corre en UNA transacción con lock pesimista sobre el pedido
 * y re-chequea estado y pago ya dentro del lock; se guarda con `save` (la
 * entidad cargada) para que el subscriber de auditoría registre quién y qué
 * cambió. Repetir la misma operación es un no-op (`changed: false`).
 */
@Injectable()
export class CashCollectionUseCase {
  constructor(private readonly dataSource: DataSource) {}

  /** El chofer asignado confirma que cobró el efectivo. */
  async confirmReceived(
    orderId: string,
    driverUserId: string,
    distributorId?: string | null,
  ): Promise<ResultadoDeCobro> {
    return this.dataSource.transaction(async (manager) => {
      const order = await this.lockPedidoDelChofer(
        manager,
        orderId,
        driverUserId,
        distributorId,
      );
      if (order.paymentStatus === PaymentStatus.PAID) {
        return { order, changed: false, extra: undefined as never };
      }
      if (order.paymentStatus !== PaymentStatus.PENDING) {
        throw new ConflictException(
          'El pago de este pedido ya se informó como impago: lo resuelve un administrador',
        );
      }
      order.paymentStatus = PaymentStatus.PAID;
      order.paymentConfirmedAt = new Date();
      order.paymentConfirmedBy = driverUserId;
      return {
        order: await manager.save(order),
        changed: true,
        extra: undefined as never,
      };
    });
  }

  /**
   * El chofer asignado informa que el cliente no pagó el efectivo.
   * `dentro` corre en la MISMA transacción y con el pedido bloqueado, también
   * en un reintento (así lo que cuelga del impago, como su incidencia, se
   * crea o se encuentra una sola vez aunque lleguen varios avisos a la vez).
   */
  async markUnpaid<T>(
    orderId: string,
    driverUserId: string,
    dentro: (manager: EntityManager, order: Order) => Promise<T>,
    distributorId?: string | null,
  ): Promise<ResultadoDeCobro<T>> {
    return this.dataSource.transaction(async (manager) => {
      const order = await this.lockPedidoDelChofer(
        manager,
        orderId,
        driverUserId,
        distributorId,
      );
      const changed = await this.pasarAImpago(manager, order);
      return { order, changed, extra: await dentro(manager, order) };
    });
  }

  /**
   * Un administrador registra que cobró el efectivo de un pedido entregado cuyo
   * chofer no lo confirmó (o ya no está). Exige un motivo; queda en el pedido
   * (`paymentResolution*`), en el historial de estados y en la auditoría.
   * Repetirlo es un no-op.
   */
  async registerCashByAdmin(
    orderId: string,
    adminUserId: string,
    reason: string,
    distributorId?: string | null,
  ): Promise<ResultadoDeCobro> {
    return this.dataSource.transaction(async (manager) => {
      const order = await this.lock(manager, orderId, distributorId);
      this.exigirEntregadoEnEfectivo(order);
      if (order.paymentStatus === PaymentStatus.PAID) {
        return { order, changed: false, extra: undefined as never };
      }
      if (order.paymentStatus !== PaymentStatus.PENDING) {
        throw new ConflictException(
          'El pago de este pedido ya se informó como impago: se resuelve con resolve-unpaid',
        );
      }
      const ahora = new Date();
      order.paymentStatus = PaymentStatus.PAID;
      order.paymentConfirmedAt = ahora;
      order.paymentConfirmedBy = adminUserId;
      order.paymentResolvedAt = ahora;
      order.paymentResolvedBy = adminUserId;
      order.paymentResolutionNote = reason;
      await manager.save(order);
      await this.asentarEnElHistorial(
        manager,
        order,
        adminUserId,
        `Cobro en efectivo registrado por un administrador: ${reason}`,
      );
      return { order, changed: true, extra: undefined as never };
    });
  }

  /**
   * Un administrador informa el impago de un pedido entregado en efectivo cuyo
   * chofer no lo hizo. Mismo efecto que el aviso del chofer (`unpaid` +
   * `dentro`, que abre la incidencia en la misma transacción), con motivo
   * obligatorio en el historial.
   */
  async registerUnpaidByAdmin<T>(
    orderId: string,
    adminUserId: string,
    reason: string,
    dentro: (manager: EntityManager, order: Order) => Promise<T>,
    distributorId?: string | null,
  ): Promise<ResultadoDeCobro<T>> {
    return this.dataSource.transaction(async (manager) => {
      const order = await this.lock(manager, orderId, distributorId);
      this.exigirEntregadoEnEfectivo(order);
      const changed = await this.pasarAImpago(manager, order);
      if (changed) {
        await this.asentarEnElHistorial(
          manager,
          order,
          adminUserId,
          `Impago de efectivo informado por un administrador: ${reason}`,
        );
      }
      return { order, changed, extra: await dentro(manager, order) };
    });
  }

  /**
   * Un administrador confirma que la transferencia llegó (`received: true`,
   * el pago pasa a `paid` y el pedido empieza a contar como venta) o que no
   * llegó (`received: false`, queda `failed`). Sólo para pedidos con medio
   * `transfer`, no cancelados.
   *
   * - `received: true` vale desde `pending` y también desde `failed` (el dinero
   *   llegó después: se corrige con motivo).
   * - `received: false` vale sólo desde `pending` y sólo sobre un pedido ya
   *   ENTREGADO: marcar "no recibida" antes de entregar no frenaría nada, y lo
   *   que se quiere registrar es una entrega sin cobro.
   * - Repetir la misma decisión es un no-op; `paid` → `failed` es 409.
   */
  async confirmTransfer(
    orderId: string,
    adminUserId: string,
    received: boolean,
    reason: string,
    distributorId?: string | null,
  ): Promise<ResultadoDeCobro> {
    return this.dataSource.transaction(async (manager) => {
      const order = await this.lock(manager, orderId, distributorId);
      if (order.paymentMethod !== PaymentMethod.TRANSFER) {
        throw new BadRequestException(
          'Sólo se confirman los pedidos pagados por transferencia',
        );
      }
      if (order.status === OrderStatus.CANCELLED) {
        throw new BadRequestException(
          'El pedido está cancelado: no se confirma su transferencia',
        );
      }
      const destino = received ? PaymentStatus.PAID : PaymentStatus.FAILED;
      if (order.paymentStatus === destino) {
        return { order, changed: false, extra: undefined as never };
      }
      const corrigeNoRecibida =
        received && order.paymentStatus === PaymentStatus.FAILED;
      if (order.paymentStatus !== PaymentStatus.PENDING && !corrigeNoRecibida) {
        throw new ConflictException(
          'La transferencia ya se confirmó: no se cambia',
        );
      }
      if (!received && order.status !== OrderStatus.DELIVERED) {
        throw new ConflictException(
          'Sólo se marca como no recibida la transferencia de un pedido entregado',
        );
      }
      const ahora = new Date();
      order.paymentStatus = destino;
      if (received) {
        order.paymentConfirmedAt = ahora;
        order.paymentConfirmedBy = adminUserId;
      }
      order.paymentResolvedAt = ahora;
      order.paymentResolvedBy = adminUserId;
      order.paymentResolutionNote = reason;
      await manager.save(order);
      await this.asentarEnElHistorial(
        manager,
        order,
        adminUserId,
        `Transferencia ${received ? 'confirmada' : 'marcada como no recibida'} por un administrador: ${reason}`,
      );
      return { order, changed: true, extra: undefined as never };
    });
  }

  /** PENDING → UNPAID; `false` si ya estaba impago. 409 si ya no está pendiente. */
  private async pasarAImpago(
    manager: EntityManager,
    order: Order,
  ): Promise<boolean> {
    if (order.paymentStatus === PaymentStatus.UNPAID) return false;
    if (order.paymentStatus !== PaymentStatus.PENDING) {
      throw new ConflictException(
        'El pago de este pedido ya no está pendiente: no se puede informar como impago',
      );
    }
    order.paymentStatus = PaymentStatus.UNPAID;
    await manager.save(order);
    return true;
  }

  /**
   * Los cobros manuales no cambian el estado del pedido, pero el historial es
   * la bitácora de lo que se hizo sobre él: queda una fila con el mismo estado
   * de origen y de destino y el motivo.
   */
  private async asentarEnElHistorial(
    manager: EntityManager,
    order: Order,
    actorUserId: string,
    motivo: string,
  ): Promise<void> {
    await manager.insert(OrderStatusHistory, {
      orderId: order.orderId,
      fromStatus: order.status,
      toStatus: order.status,
      changedByUserId: actorUserId,
      reason: motivo,
    });
  }

  /**
   * El administrador cierra un impago: cobrado después o pérdida. En la misma
   * transacción y con el pedido bloqueado cierra la incidencia abierta de cobro
   * impago con la misma nota. Si el pedido ya estaba en el destino (reintento o
   * segundo admin) no toca nada: `changed: false`.
   * Un cobro (`paid`) llena `paymentConfirmed*`; una pérdida no es un cobro y
   * sólo llena `paymentResolved*`.
   */
  async resolveUnpaid(
    orderId: string,
    adminUserId: string,
    resolution: ResolucionDeImpago,
    note: string,
    distributorId?: string | null,
  ): Promise<ResultadoDeCobro> {
    return this.dataSource.transaction(async (manager) => {
      const order = await this.lock(manager, orderId, distributorId);
      const destino =
        resolution === 'paid' ? PaymentStatus.PAID : PaymentStatus.WRITTEN_OFF;
      // Repetir la resolución es un no-op, pero sólo de una resolución de
      // IMPAGO real: un pedido cobrado por el chofer, por `register-cash` o con
      // una transferencia confirmada también tiene `paid` y una nota, y no es un
      // impago resuelto (409).
      if (
        order.paymentStatus === destino &&
        (await this.fueUnImpagoResuelto(manager, order, destino))
      ) {
        return { order, changed: false, extra: undefined as never };
      }
      if (order.paymentStatus !== PaymentStatus.UNPAID) {
        throw new ConflictException(
          'Sólo se resuelve un pedido cuyo pago está informado como impago',
        );
      }
      order.paymentStatus = destino;
      const ahora = new Date();
      if (destino === PaymentStatus.PAID) {
        order.paymentConfirmedAt = ahora;
        order.paymentConfirmedBy = adminUserId;
      }
      order.paymentResolvedAt = ahora;
      order.paymentResolvedBy = adminUserId;
      order.paymentResolutionNote = note;
      await manager.update(
        Incident,
        {
          orderId: order.orderId,
          type: IncidentType.UNPAID_COLLECTION,
          status: IncidentStatus.OPEN,
        },
        {
          status: IncidentStatus.RESOLVED,
          resolutionNote: note,
          resolvedAt: ahora,
        },
      );
      return {
        order: await manager.save(order),
        changed: true,
        extra: undefined as never,
      };
    });
  }

  /**
   * ¿Este pedido pasó de verdad por un impago y se resolvió? `written_off` sólo
   * lo escribe `resolve-unpaid`. Un `paid` es un impago resuelto sólo si la
   * incidencia de cobro impago del pedido quedó cerrada como resuelta (la cierra
   * `resolve-unpaid` en la misma transacción).
   */
  private async fueUnImpagoResuelto(
    manager: EntityManager,
    order: Order,
    destino: PaymentStatus,
  ): Promise<boolean> {
    if (destino === PaymentStatus.WRITTEN_OFF) {
      return order.paymentResolutionNote !== null;
    }
    const resuelta = await manager.findOne(Incident, {
      where: {
        orderId: order.orderId,
        type: IncidentType.UNPAID_COLLECTION,
        status: IncidentStatus.RESOLVED,
      },
    });
    return resuelta !== null;
  }

  /**
   * Pedido bloqueado, y sólo si lo puede tocar este chofer, está entregado y
   * era en efectivo. El orden de los chequeos fija el código HTTP: pertenencia
   * (403) antes que estado y método (400).
   */
  private async lockPedidoDelChofer(
    manager: EntityManager,
    orderId: string,
    driverUserId: string,
    distributorId?: string | null,
  ): Promise<Order> {
    const order = await this.lock(manager, orderId, distributorId);
    if (order.delivery?.userId !== driverUserId) {
      throw new ForbiddenException('Este pedido no está asignado a tu usuario');
    }
    this.exigirEntregadoEnEfectivo(order);
    return order;
  }

  private exigirEntregadoEnEfectivo(order: Order): void {
    if (order.status !== OrderStatus.DELIVERED) {
      throw new BadRequestException(
        'El cobro se informa sobre un pedido ya entregado',
      );
    }
    if (order.paymentMethod !== PaymentMethod.CASH) {
      throw new BadRequestException(
        'Sólo los pedidos en efectivo se cobran en la entrega',
      );
    }
  }

  /**
   * `FOR UPDATE OF "ord"`: el chofer es LEFT JOIN y no se puede bloquear. Con
   * distribuidora en contexto, el pedido de otra es 404 (el lock no lo toma).
   */
  private async lock(
    manager: EntityManager,
    orderId: string,
    distributorId?: string | null,
  ): Promise<Order> {
    const consulta = manager
      .createQueryBuilder(Order, 'ord')
      .setLock('pessimistic_write', undefined, ['ord'])
      .leftJoinAndSelect('ord.delivery', 'delivery')
      .where('ord.orderId = :id', { id: orderId });
    if (distributorId) {
      consulta.andWhere('ord.distributorId = :distributorId', {
        distributorId,
      });
    }
    const order = await consulta.getOne();
    if (!order) {
      throw new NotFoundException(`Order with ID: ${orderId} not found`);
    }
    return order;
  }
}
