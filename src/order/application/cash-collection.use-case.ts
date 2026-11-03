import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';

import { CashCategoryService } from '../../cash/application/cash-category.service';
import { CashLedgerService } from '../../cash/application/cash-ledger.service';
import {
  ResultadoDelAsiento,
  SalesCashService,
} from '../../cash/application/sales-cash.service';
import { saldoACobrar } from '../../truck-load/domain/truck-load-rules';
import {
  CashBoxKind,
  CashDirection,
  CashMethod,
  CashReferenceType,
  CashSystemCode,
} from '../../cash/domain/cash.enums';

import {
  Incident,
  IncidentStatus,
  IncidentType,
} from '../../incident/entities/incident.entity';
import { CajaNoEncontradaError } from '../../cash/domain/errors/cash.errors';
import { DriverSettlementOrder } from '../../driver-settlement/entities/driver-settlement-order.entity';
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
  constructor(
    private readonly dataSource: DataSource,
    private readonly cashLedger: CashLedgerService,
    private readonly categorias: CashCategoryService,
    private readonly ventasEnCaja: SalesCashService,
  ) {}

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
      if (order.paymentStatus !== PaymentStatus.UNPAID) {
        await this.exigirSinRendir(manager, order);
      }
      const changed = await this.pasarAImpago(manager, order);
      return { order, changed, extra: await dentro(manager, order) };
    });
  }

  /**
   * Un administrador registra que cobró el efectivo de un pedido entregado cuyo
   * chofer no lo confirmó (o ya no está). Exige un motivo; queda en el pedido
   * (`paymentResolution*`), en el historial de estados y en la auditoría.
   * El efectivo entra a la caja indicada en la misma transacción
   * (`asentarEnCaja`). Repetirlo es un no-op: no asienta otra vez.
   */
  async registerCashByAdmin(
    orderId: string,
    adminUserId: string,
    reason: string,
    distributorId?: string | null,
    cashBoxId?: string | null,
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
      await this.exigirSinRendir(manager, order);
      await this.exigirCaja(manager, order, cashBoxId);
      const ahora = new Date();
      order.paymentStatus = PaymentStatus.PAID;
      order.paymentConfirmedAt = ahora;
      order.paymentConfirmedBy = adminUserId;
      order.paymentResolvedAt = ahora;
      order.paymentResolvedBy = adminUserId;
      order.paymentResolutionNote = reason;
      await manager.save(order);
      await this.asentarEnCaja(manager, order, adminUserId, cashBoxId);
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
   * obligatorio en el historial y en el pedido (`paymentResolution*`).
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
      await this.exigirSinRendir(manager, order);
      const changed = await this.pasarAImpago(manager, order, {
        adminUserId,
        reason,
      });
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
   *
   * Al confirmar que llegó, el importe entra a la caja de transferencias en la
   * misma transacción (una sola vez por pedido). Sin caja configurada, o si la
   * caja lo rechaza, la confirmación sigue igual: el cobro queda sin asentar y
   * se avisa a la bandeja. Como `paid` → `failed` es 409, ninguna confirmación
   * se deshace, y no hay contraasiento que asentar.
   */
  async confirmTransfer(
    orderId: string,
    adminUserId: string,
    received: boolean,
    reason: string,
    distributorId?: string | null,
  ): Promise<ResultadoDeCobro> {
    let asiento: ResultadoDelAsiento | undefined;
    const resultado = await this.dataSource.transaction(async (manager) => {
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
      if (received) {
        asiento = await this.ventasEnCaja.asentarTransferencia(manager, {
          distributorId: order.distributorId,
          orderId: order.orderId,
          amount: saldoACobrar(
            Number(order.totalAmount),
            order.depositPaid ? Number(order.depositAmount) : 0,
          ),
          userId: adminUserId,
        });
      }
      return { order, changed: true, extra: undefined as never };
    });
    if (asiento) {
      this.ventasEnCaja.avisarSinAsentar(
        resultado.order.distributorId,
        asiento,
        orderId,
      );
    }
    return resultado;
  }

  /**
   * PENDING → UNPAID; `false` si ya estaba impago (no se toca nada, tampoco la
   * anotación). 409 si ya no está pendiente. Con `anotacion` (el admin que lo
   * registra) el motivo queda en el pedido, en `paymentResolved*` igual que en
   * `register-cash` y `confirm-transfer`; `resolve-unpaid` los reemplaza cuando
   * el impago se cierra. Como sólo se llega desde `pending`, no hay una
   * resolución previa que pisar.
   */
  private async pasarAImpago(
    manager: EntityManager,
    order: Order,
    anotacion?: { adminUserId: string; reason: string },
  ): Promise<boolean> {
    if (order.paymentStatus === PaymentStatus.UNPAID) return false;
    if (order.paymentStatus !== PaymentStatus.PENDING) {
      throw new ConflictException(
        'El pago de este pedido ya no está pendiente: no se puede informar como impago',
      );
    }
    order.paymentStatus = PaymentStatus.UNPAID;
    if (anotacion) {
      order.paymentResolvedAt = new Date();
      order.paymentResolvedBy = anotacion.adminUserId;
      order.paymentResolutionNote = anotacion.reason;
    }
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
   * Un cobro (`paid`) llena `paymentConfirmed*` y entra a la caja indicada en
   * la misma transacción; una pérdida no es un cobro: sólo llena
   * `paymentResolved*` y no toca ninguna caja.
   */
  async resolveUnpaid(
    orderId: string,
    adminUserId: string,
    resolution: ResolucionDeImpago,
    note: string,
    distributorId?: string | null,
    cashBoxId?: string | null,
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
      if (destino === PaymentStatus.PAID) {
        await this.exigirSinRendir(manager, order);
        await this.exigirCaja(manager, order, cashBoxId);
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
      const guardado = await manager.save(order);
      if (destino === PaymentStatus.PAID) {
        await this.asentarEnCaja(manager, order, adminUserId, cashBoxId);
      }
      return { order: guardado, changed: true, extra: undefined as never };
    });
  }

  /**
   * El efectivo de un pedido que la rendición del chofer ya tomó es del chofer:
   * si el administrador lo cobrara o lo marcara impago también, el dinero
   * entraría dos veces (caja y rendición); y el chofer que ya rindió un pedido
   * tampoco lo informa impago. Con el pedido bloqueado; la carrera
   * contraria la cubre `presentar` de la rendición, que bloquea los pedidos que
   * toma y reevalúa `payment_resolved_by`.
   */
  private async exigirSinRendir(
    manager: EntityManager,
    order: Order,
  ): Promise<void> {
    const rendido = await manager.exists(DriverSettlementOrder, {
      where: { orderId: order.orderId },
    });
    if (rendido) {
      throw new ConflictException('El chofer ya rindió este pedido');
    }
  }

  /**
   * Regla de la caja: sólo entran a una caja de EFECTIVO. Si la distribuidora
   * tiene alguna caja de efectivo activa, el cobro que registra el
   * administrador TIENE que indicar a cuál entra (400); si no tiene ninguna, se
   * cobra sin movimiento. Una caja elegida que no es de efectivo es 400, una de
   * otra distribuidora o inexistente, 404. Se chequea antes de tocar el pedido.
   *
   * Carrera conocida: si otro administrador crea la primera caja de efectivo
   * entre este chequeo y el asiento, el cobro queda sin movimiento (no se
   * bloquea el alta de cajas por esto); se corrige con un ingreso manual.
   */
  private async exigirCaja(
    manager: EntityManager,
    order: Order,
    cashBoxId?: string | null,
  ): Promise<void> {
    if (cashBoxId) {
      const filas: Array<{ kind: CashBoxKind }> = await manager.query(
        `SELECT "kind" FROM "cash_box"
         WHERE "cash_box_id" = $1 AND "distributor_id" = $2 AND "deletedAt" IS NULL`,
        [cashBoxId, order.distributorId],
      );
      if (!filas[0]) throw new CajaNoEncontradaError(cashBoxId);
      if (filas[0].kind !== CashBoxKind.CASH) {
        throw new BadRequestException(
          'El efectivo cobrado entra a una caja de efectivo: elegí otra caja',
        );
      }
      return;
    }
    const filas: Array<{ n: string }> = await manager.query(
      `SELECT count(*) AS n FROM "cash_box"
       WHERE "distributor_id" = $1 AND "is_active" = true AND "kind" = 'cash' AND "deletedAt" IS NULL`,
      [order.distributorId],
    );
    if (Number(filas[0]?.n ?? 0) > 0) {
      throw new BadRequestException(
        'Indicá la caja donde entra el efectivo cobrado (cashBoxId)',
      );
    }
  }

  /**
   * Entrada de caja por el saldo a cobrar del pedido (total menos la seña ya
   * paga, la misma regla que la rendición del chofer), con su categoría de sistema
   * `order_payment` y el pedido como referencia, por el libro (único punto por
   * el que entra el dinero). Sin `cashBoxId` (distribuidora sin cajas) o con un
   * saldo a cobrar de cero no asienta nada. El pedido ya está bloqueado: el
   * orden de locks es pedido → caja.
   */
  private async asentarEnCaja(
    manager: EntityManager,
    order: Order,
    adminUserId: string,
    cashBoxId?: string | null,
  ): Promise<void> {
    if (!cashBoxId) return;
    const importe = new Decimal(
      saldoACobrar(
        Number(order.totalAmount),
        order.depositPaid ? Number(order.depositAmount) : 0,
      ),
    );
    if (importe.lte(0)) return;
    const categoria = await this.categorias.deSistema(
      manager,
      order.distributorId,
      CashSystemCode.ORDER_PAYMENT,
    );
    await this.cashLedger.registrar(manager, {
      distributorId: order.distributorId,
      cashBoxId,
      direction: CashDirection.IN,
      amount: importe,
      categoryId: categoria.categoryId,
      method: CashMethod.CASH,
      description: `Cobro en efectivo del pedido ${order.orderId}`,
      referenceType: CashReferenceType.ORDER_PAYMENT,
      referenceId: order.orderId,
      userId: adminUserId,
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
      throw new NotFoundException('Pedido no encontrado');
    }
    return order;
  }
}
