import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { EntityManager } from 'typeorm';
import { pedirAvisoAlAdmin } from '../../common/events/aviso-al-admin';
import { errorMessage } from '../../common/errors/error-message';
import { diaArgentino } from '../../common/utils/dias-argentina';
import {
  CashDirection,
  CashMethod,
  CashReferenceType,
  CashSystemCode,
} from '../domain/cash.enums';
import { CashCollectionSettings } from '../entities/cash-collection-settings.entity';
import { CashMovement } from '../entities/cash-movement.entity';
import { CashCategoryService } from './cash-category.service';
import { CashLedgerService } from './cash-ledger.service';

/**
 * Qué pasó al intentar asentar un cobro de venta en una caja. Un cobro que no
 * se asienta NUNCA frena lo que lo origina (el webhook, la confirmación de la
 * transferencia): queda «sin asentar» y el administrador lo ve.
 */
export type ResultadoDelAsiento =
  /** Entró (o salió) de la caja en esta operación. */
  | 'asentado'
  /** Ya tenía su movimiento: repetir no lo duplica. */
  | 'ya_asentado'
  /** La distribuidora no configuró la caja de ese medio. */
  | 'sin_caja'
  /** La caja rechazó el movimiento (desactivada, sin sesión abierta…). */
  | 'fallo'
  /** No hay nada que asentar (importe cero, devolución de un cobro que nunca entró). */
  | 'sin_efecto'
  /** Hay un movimiento que el administrador tiene que conciliar a mano (no se asentó solo). */
  | 'a_conciliar';

export interface CobroDeMercadoPago {
  distributorId: string;
  orderId: string;
  /** Id del registro de `payment` (la referencia del movimiento). */
  paymentId: string;
  /** Id del pago en Mercado Pago, para la descripción. */
  gatewayPaymentId: string;
  /** Lo que Mercado Pago cobró. */
  amount: Decimal.Value;
  /** La comisión que retuvo; sin dato o cero no se asienta egreso. */
  feeAmount?: Decimal.Value | null;
  /** Mercado Pago no informó la comisión: queda anotado en la descripción para completarla después. */
  feeUnreported?: boolean;
  /** Quién lo asienta; sin usuario (webhook) queda sin autor. */
  userId?: string | null;
}

export interface ComisionDeMercadoPago {
  distributorId: string;
  orderId: string;
  paymentId: string;
  gatewayPaymentId: string;
  feeAmount: Decimal.Value;
  userId?: string | null;
}

export interface DevolucionDeMercadoPago {
  distributorId: string;
  orderId: string;
  paymentId: string;
  refundId: string;
  gatewayPaymentId: string;
  amount: Decimal.Value;
  userId?: string | null;
}

export interface DevolucionExterna {
  distributorId: string;
  orderId: string;
  paymentId: string;
  gatewayPaymentId: string;
  /** Lo devuelto en total según Mercado Pago. */
  refundedTotal: Decimal.Value;
  /** `true` si Mercado Pago lo revirtió por un contracargo. */
  contracargo: boolean;
  userId?: string | null;
}

export interface TransferenciaConfirmada {
  distributorId: string;
  orderId: string;
  amount: Decimal.Value;
  userId: string;
}

export interface SenaRecibida {
  distributorId: string;
  orderId: string;
  amount: Decimal.Value;
  userId: string;
  /** Transferencia: entra a la caja de transferencias configurada. Efectivo: a `cashBoxId`. */
  metodo: CashMethod.TRANSFER | CashMethod.CASH;
  cashBoxId?: string | null;
}

/** Id corto del pedido para los textos de los movimientos (los últimos 6 del uuid). */
const corto = (orderId: string): string => orderId.slice(-6).toUpperCase();

/**
 * Los cobros de las ventas que no pasan por la mano del chofer entran a una
 * caja por el libro: el pago aprobado de Mercado Pago (con su comisión, para que
 * el saldo de la billetera sea el neto), su devolución, la transferencia
 * confirmada y la seña de una reserva. Cada asiento corre en la transacción de
 * quien llama, dentro de un punto de guardado: si la caja lo rechaza, se deshace
 * sólo el asiento y el cobro sigue su curso. Una referencia, un movimiento
 * (índice único).
 */
@Injectable()
export class SalesCashService {
  private readonly logger = new Logger(SalesCashService.name);

  constructor(
    private readonly ledger: CashLedgerService,
    private readonly categorias: CashCategoryService,
    private readonly events: EventEmitter2,
  ) {}

  async configuracion(
    manager: EntityManager,
    distributorId: string,
  ): Promise<CashCollectionSettings | null> {
    return manager.findOne(CashCollectionSettings, {
      where: { distributorId },
    });
  }

  /** Ingreso del pago aprobado a la caja de Mercado Pago y, si se conoce, su comisión como egreso. */
  async asentarCobroDeMercadoPago(
    manager: EntityManager,
    cobro: CobroDeMercadoPago,
  ): Promise<ResultadoDelAsiento> {
    const config = await this.configuracion(manager, cobro.distributorId);
    const cajaId = config?.mercadoPagoCashBoxId;
    if (!cajaId) return 'sin_caja';
    if (
      await this.yaAsentado(manager, CashReferenceType.PAYMENT, cobro.paymentId)
    ) {
      return 'ya_asentado';
    }
    const importe = new Decimal(cobro.amount);
    if (importe.lte(0)) return 'sin_efecto';
    const userId = cobro.userId ?? null;
    return this.enUnPuntoDeGuardado(
      manager,
      'cobro de Mercado Pago',
      async () => {
        const ingreso = await this.categorias.deSistema(
          manager,
          cobro.distributorId,
          CashSystemCode.ORDER_PAYMENT,
        );
        const nota = cobro.feeUnreported ? ' (sin comisión informada)' : '';
        await this.ledger.registrar(manager, {
          distributorId: cobro.distributorId,
          cashBoxId: cajaId,
          direction: CashDirection.IN,
          amount: importe,
          categoryId: ingreso.categoryId,
          method: CashMethod.MERCADOPAGO,
          description:
            `Pedido #${corto(cobro.orderId)} — Mercado Pago ${cobro.gatewayPaymentId}${nota}`.slice(
              0,
              255,
            ),
          referenceType: CashReferenceType.PAYMENT,
          referenceId: cobro.paymentId,
          userId,
        });
        const comision = new Decimal(cobro.feeAmount ?? 0);
        if (comision.gt(0)) {
          await this.egresoDeComision(manager, cobro, cajaId, comision, userId);
        }
      },
    );
  }

  /**
   * Comisión de un cobro que ya entró a la caja sin ella (no se conocía al
   * asentarlo): sale de la misma caja. Se asienta una sola vez por pago.
   */
  async asentarComision(
    manager: EntityManager,
    c: ComisionDeMercadoPago,
  ): Promise<ResultadoDelAsiento> {
    const ingreso = await this.ingresoDelPago(manager, c.paymentId);
    if (!ingreso) return 'sin_efecto';
    if (
      await this.yaAsentado(manager, CashReferenceType.PAYMENT_FEE, c.paymentId)
    ) {
      return 'ya_asentado';
    }
    const comision = new Decimal(c.feeAmount);
    if (comision.lte(0)) return 'sin_efecto';
    return this.enUnPuntoDeGuardado(manager, 'comisión de Mercado Pago', () =>
      this.egresoDeComision(
        manager,
        c,
        ingreso.cashBoxId,
        comision,
        c.userId ?? null,
      ),
    );
  }

  /**
   * Egreso de lo devuelto al cliente, desde la caja donde entró el cobro. Un
   * cobro que nunca entró a una caja (sin configurar, o pendiente de asentar) no
   * tiene egreso: lo asentará `settle-pending` junto con sus devoluciones. Nunca
   * se egresa más de lo que ingresó el pago.
   */
  async asentarDevolucion(
    manager: EntityManager,
    devolucion: DevolucionDeMercadoPago,
  ): Promise<ResultadoDelAsiento> {
    const ingreso = await this.ingresoDelPago(manager, devolucion.paymentId);
    if (!ingreso) return 'sin_efecto';
    if (
      await this.yaAsentado(
        manager,
        CashReferenceType.PAYMENT_REFUND,
        devolucion.refundId,
      )
    ) {
      return 'ya_asentado';
    }
    const restante = new Decimal(ingreso.amount).minus(
      await this.egresadoDelPago(manager, devolucion.paymentId),
    );
    const importe = Decimal.min(new Decimal(devolucion.amount), restante);
    if (importe.lte(0)) return 'sin_efecto';
    return this.enUnPuntoDeGuardado(manager, 'devolución de Mercado Pago', () =>
      this.egresoDeDevolucion(manager, {
        distributorId: devolucion.distributorId,
        cashBoxId: ingreso.cashBoxId,
        importe,
        descripcion: `Devolución al cliente — pedido #${corto(devolucion.orderId)}, Mercado Pago ${devolucion.gatewayPaymentId}`,
        referenceType: CashReferenceType.PAYMENT_REFUND,
        referenceId: devolucion.refundId,
        userId: devolucion.userId ?? null,
      }),
    );
  }

  /**
   * Devolución o contracargo que Mercado Pago hizo por su cuenta: egreso por la
   * diferencia entre lo devuelto según Mercado Pago y lo que ya se devolvió o se
   * pidió devolver desde acá (solicitudes y egresos anteriores). Repetir la
   * notificación no duplica. Nunca más que lo ingresado.
   */
  async asentarDevolucionExterna(
    manager: EntityManager,
    d: DevolucionExterna,
  ): Promise<ResultadoDelAsiento> {
    const ingreso = await this.ingresoDelPago(manager, d.paymentId);
    if (!ingreso) return 'sin_efecto';
    const ingresado = new Decimal(ingreso.amount);
    const comprometido = await this.comprometidoDelPago(manager, d.paymentId);
    const diferencia = Decimal.min(new Decimal(d.refundedTotal), ingresado)
      .minus(comprometido)
      .toDecimalPlaces(2);
    const libre = ingresado.minus(
      await this.egresadoDelPago(manager, d.paymentId),
    );
    const importe = Decimal.min(diferencia, libre);
    if (importe.lte(0)) return 'sin_efecto';
    return this.enUnPuntoDeGuardado(manager, 'devolución externa', () =>
      this.egresoDeDevolucion(manager, {
        distributorId: d.distributorId,
        cashBoxId: ingreso.cashBoxId,
        importe,
        descripcion: `${d.contracargo ? 'Contracargo' : 'Devolución desde Mercado Pago'} — pedido #${corto(d.orderId)}, Mercado Pago ${d.gatewayPaymentId}`,
        referenceType: CashReferenceType.PAYMENT_EXTERNAL_REFUND,
        referenceId: d.paymentId,
        userId: d.userId ?? null,
      }),
    );
  }

  /**
   * Mercado Pago le devolvió al comercio lo que había retenido por un contracargo
   * (`status_detail: reimbursed`): ingreso a la misma caja por lo que salió como
   * contracargo. Una sola vez por pago, y sólo si el contracargo había salido de la
   * caja.
   * https://www.mercadopago.com.ar/developers/en/docs/checkout-api-payments/response-handling/query-results
   */
  async asentarContracargoReintegrado(
    manager: EntityManager,
    c: {
      distributorId: string;
      orderId: string;
      paymentId: string;
      gatewayPaymentId: string;
      /**
       * `true`: el caso se resolvió a favor del vendedor (`coverage_applied`) y se asienta
       * el ingreso solo. `false`: la documentación de Mercado Pago no dice a quién se
       * reintegra el dinero sin esa resolución: no se asienta; si el contracargo había
       * salido de la caja devuelve `a_conciliar` para que lo concilie el administrador.
       */
      automatico: boolean;
    },
  ): Promise<ResultadoDelAsiento> {
    const filas: Array<{
      cash_box_id: string;
      direction: string;
      total: string;
    }> = await manager.query(
      `SELECT m."cash_box_id", m."direction", SUM(m."amount") AS total FROM "cash_movement" m
         WHERE m."reference_type" = 'payment_external_refund' AND m."reference_id" = $1
           AND m."description" LIKE 'Contracargo%'
         GROUP BY m."cash_box_id", m."direction"`,
      [c.paymentId],
    );
    const salida = filas.find((f) => f.direction === 'out');
    if (!salida) return 'sin_efecto';
    if (filas.some((f) => f.direction === 'in')) return 'ya_asentado';
    if (!c.automatico) return 'a_conciliar';
    return this.enUnPuntoDeGuardado(
      manager,
      'contracargo reintegrado',
      async () => {
        const categoria = await this.categorias.deSistema(
          manager,
          c.distributorId,
          CashSystemCode.ORDER_PAYMENT,
        );
        await this.ledger.registrar(manager, {
          distributorId: c.distributorId,
          cashBoxId: salida.cash_box_id,
          direction: CashDirection.IN,
          amount: new Decimal(salida.total),
          categoryId: categoria.categoryId,
          method: CashMethod.MERCADOPAGO,
          description:
            `Contracargo reintegrado — pedido #${corto(c.orderId)}, Mercado Pago ${c.gatewayPaymentId}`.slice(
              0,
              255,
            ),
          referenceType: CashReferenceType.PAYMENT_EXTERNAL_REFUND,
          referenceId: c.paymentId,
          userId: null,
        });
      },
    );
  }

  /** Ingreso de la transferencia confirmada a la caja de transferencias. */
  async asentarTransferencia(
    manager: EntityManager,
    transferencia: TransferenciaConfirmada,
  ): Promise<ResultadoDelAsiento> {
    return this.ingresoDeUnPedido(manager, {
      ...transferencia,
      referenceType: CashReferenceType.ORDER_TRANSFER,
      metodo: CashMethod.TRANSFER,
      descripcion: `Pedido #${corto(transferencia.orderId)} — Transferencia`,
      cashBoxId: null,
    });
  }

  /**
   * Seña de una reserva recibida a mano: por transferencia entra a la caja de
   * transferencias; en efectivo, a la caja de efectivo que eligió el
   * administrador. Una sola vez por pedido.
   */
  async asentarSena(
    manager: EntityManager,
    sena: SenaRecibida,
  ): Promise<ResultadoDelAsiento> {
    return this.ingresoDeUnPedido(manager, {
      ...sena,
      referenceType: CashReferenceType.ORDER_DEPOSIT,
      descripcion: `Pedido #${corto(sena.orderId)} — Seña de la reserva (${sena.metodo === CashMethod.CASH ? 'efectivo' : 'transferencia'})`,
    });
  }

  /**
   * Aviso a la bandeja de los administradores de que hay cobros sin asentar.
   * Una vez por día argentino y distribuidora (el mismo `dedupeKey`); lleva a la
   * configuración de la caja. Se pide DESPUÉS de confirmar la transacción.
   */
  avisarSinAsentar(
    distributorId: string,
    resultado: ResultadoDelAsiento,
    orderId: string,
  ): void {
    if (resultado !== 'sin_caja' && resultado !== 'fallo') return;
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId,
      kind: 'sales_cash_unsettled',
      title: 'Cobros sin asentar en una caja',
      body:
        resultado === 'sin_caja'
          ? `El cobro del pedido #${corto(orderId)} no entró a ninguna caja: elegí la caja de Mercado Pago y la de transferencias en la configuración de caja y asentá los cobros pendientes.`
          : `Un cobro o una devolución del pedido #${corto(orderId)} no se pudo asentar en la caja configurada: revisá que esté activa y asentá los cobros pendientes.`,
      link: { entity: 'cash-settings', id: distributorId },
      dedupeKey: `sales-cash-unsettled:${distributorId}:${diaArgentino()}`,
    });
  }

  private async ingresoDeUnPedido(
    manager: EntityManager,
    c: {
      distributorId: string;
      orderId: string;
      amount: Decimal.Value;
      userId: string;
      referenceType: CashReferenceType;
      metodo: CashMethod.TRANSFER | CashMethod.CASH;
      descripcion: string;
      cashBoxId?: string | null;
    },
  ): Promise<ResultadoDelAsiento> {
    const cajaId =
      c.metodo === CashMethod.CASH
        ? c.cashBoxId
        : (await this.configuracion(manager, c.distributorId))
            ?.transferCashBoxId;
    if (!cajaId) return 'sin_caja';
    if (await this.yaAsentado(manager, c.referenceType, c.orderId)) {
      return 'ya_asentado';
    }
    const importe = new Decimal(c.amount);
    if (importe.lte(0)) return 'sin_efecto';
    return this.enUnPuntoDeGuardado(manager, 'cobro del pedido', async () => {
      const categoria = await this.categorias.deSistema(
        manager,
        c.distributorId,
        CashSystemCode.ORDER_PAYMENT,
      );
      await this.ledger.registrar(manager, {
        distributorId: c.distributorId,
        cashBoxId: cajaId,
        direction: CashDirection.IN,
        amount: importe,
        categoryId: categoria.categoryId,
        method: c.metodo,
        description: c.descripcion.slice(0, 255),
        referenceType: c.referenceType,
        referenceId: c.orderId,
        userId: c.userId,
      });
    });
  }

  private async egresoDeComision(
    manager: EntityManager,
    c: {
      distributorId: string;
      orderId: string;
      paymentId: string;
      gatewayPaymentId: string;
    },
    cashBoxId: string,
    comision: Decimal,
    userId: string | null,
  ): Promise<void> {
    const gasto = await this.categorias.deSistema(
      manager,
      c.distributorId,
      CashSystemCode.MERCADOPAGO_FEE,
    );
    await this.ledger.registrar(manager, {
      distributorId: c.distributorId,
      cashBoxId,
      direction: CashDirection.OUT,
      amount: comision,
      categoryId: gasto.categoryId,
      method: CashMethod.MERCADOPAGO,
      description:
        `Comisión de Mercado Pago ${c.gatewayPaymentId} — pedido #${corto(c.orderId)}`.slice(
          0,
          255,
        ),
      referenceType: CashReferenceType.PAYMENT_FEE,
      referenceId: c.paymentId,
      userId,
    });
  }

  private async egresoDeDevolucion(
    manager: EntityManager,
    e: {
      distributorId: string;
      cashBoxId: string;
      importe: Decimal;
      descripcion: string;
      referenceType: CashReferenceType;
      referenceId: string;
      userId: string | null;
    },
  ): Promise<void> {
    const categoria = await this.categorias.deSistema(
      manager,
      e.distributorId,
      CashSystemCode.CUSTOMER_REFUND,
    );
    await this.ledger.registrar(manager, {
      distributorId: e.distributorId,
      cashBoxId: e.cashBoxId,
      direction: CashDirection.OUT,
      amount: e.importe,
      categoryId: categoria.categoryId,
      method: CashMethod.MERCADOPAGO,
      description: e.descripcion.slice(0, 255),
      referenceType: e.referenceType,
      referenceId: e.referenceId,
      userId: e.userId,
    });
  }

  private ingresoDelPago(
    manager: EntityManager,
    paymentId: string,
  ): Promise<CashMovement | null> {
    return manager.findOne(CashMovement, {
      where: {
        referenceType: CashReferenceType.PAYMENT,
        referenceId: paymentId,
      },
    });
  }

  /** Lo que ya salió de la caja por devoluciones de ese pago (solicitudes cerradas y externas). */
  private async egresadoDelPago(
    manager: EntityManager,
    paymentId: string,
  ): Promise<Decimal> {
    const filas: Array<{ total: string }> = await manager.query(
      `SELECT COALESCE(SUM(m."amount"), 0) AS total FROM "cash_movement" m
       WHERE m."direction" = 'out' AND (
         (m."reference_type" = 'payment_external_refund' AND m."reference_id" = $1)
         OR (m."reference_type" = 'payment_refund'
             AND m."reference_id" IN (SELECT "refund_id" FROM "payment_refund" WHERE "payment_id" = $1)))`,
      [paymentId],
    );
    return new Decimal(filas[0]?.total ?? 0);
  }

  /** Lo devuelto o a punto de devolverse de ese pago: solicitudes cerradas o en curso más los egresos externos. */
  private async comprometidoDelPago(
    manager: EntityManager,
    paymentId: string,
  ): Promise<Decimal> {
    const filas: Array<{ total: string }> = await manager.query(
      `SELECT (
         COALESCE((SELECT SUM("amount") FROM "payment_refund"
                   WHERE "payment_id" = $1 AND "status" IN ('succeeded', 'pending')), 0)
       + COALESCE((SELECT SUM("amount") FROM "cash_movement"
                   WHERE "reference_type" = 'payment_external_refund' AND "reference_id" = $1
                     AND "direction" = 'out'), 0)
       ) AS total`,
      [paymentId],
    );
    return new Decimal(filas[0]?.total ?? 0);
  }

  private async yaAsentado(
    manager: EntityManager,
    referenceType: CashReferenceType,
    referenceId: string,
  ): Promise<boolean> {
    return manager.exists(CashMovement, {
      where: { referenceType, referenceId },
    });
  }

  /**
   * Ejecuta el asiento en un punto de guardado: si falla, se deshace sólo lo
   * suyo (la transacción del cobro sigue sana) y devuelve `fallo`.
   */
  private async enUnPuntoDeGuardado(
    manager: EntityManager,
    que: string,
    asiento: () => Promise<void>,
  ): Promise<ResultadoDelAsiento> {
    try {
      await manager.transaction(asiento);
      return 'asentado';
    } catch (error) {
      this.logger.error(
        `No se pudo asentar el ${que} en la caja: ${errorMessage(error)}`,
      );
      return 'fallo';
    }
  }
}
