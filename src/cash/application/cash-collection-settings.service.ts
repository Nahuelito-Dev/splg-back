import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';
import { aCentavos } from '../../common/utils/dinero';
import {
  inicioDelDiaArgentino,
  sumarDias,
  diaArgentino,
} from '../../common/utils/dias-argentina';
import { PaymentGatewayPort } from '../../payments/domain/ports/payment-gateway.port';
import { CashBoxKind, CashReferenceType } from '../domain/cash.enums';
import { CajaNoEncontradaError } from '../domain/errors/cash.errors';
import {
  OrderCashSettlementResponseDto,
  OrderCollectionEntryDto,
  PendingCollectionsResponseDto,
  SettlePendingResponseDto,
  UpdateCashCollectionSettingsDto,
} from '../dto/cash-collection-settings.dto';
import { CashBox } from '../entities/cash-box.entity';
import { CashCollectionSettings } from '../entities/cash-collection-settings.entity';
import { CashMovement } from '../entities/cash-movement.entity';
import { ResultadoDelAsiento, SalesCashService } from './sales-cash.service';

/** Ventana por omisión del conteo de cobros sin asentar. */
const DIAS_POR_OMISION = 30;

/** Hasta cuántos días hacia atrás se puede pedir asentar cobros. */
const DIAS_MAXIMOS = 365;

interface CobroMpPendiente {
  payment_id: string;
  order_id: string;
  gateway_payment_id: string | null;
  credential_id: string | null;
  amount: string;
  metadata: Record<string, unknown> | null;
  approved_at: Date;
}

interface DevolucionPendiente {
  refund_id: string;
  payment_id: string;
  order_id: string;
  gateway_payment_id: string | null;
  amount: string;
  refunded_at: Date;
}

interface ComisionPendiente {
  payment_id: string;
  order_id: string;
  gateway_payment_id: string | null;
  credential_id: string | null;
  metadata: Record<string, unknown> | null;
}

const numeroDe = (valor: unknown): number | null =>
  typeof valor === 'number' && Number.isFinite(valor) ? valor : null;

/**
 * Configuración de la caja de cobro de Mercado Pago y los
 * cobros de las ventas que todavía no entraron a una caja: cuántos hay y cómo
 * asentarlos cuando el administrador lo pide. Nada se asienta hacia atrás por
 * su cuenta: `settle-pending` exige la fecha desde la que se quiere.
 */
@Injectable()
export class CashCollectionSettingsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ventas: SalesCashService,
    private readonly pasarela: PaymentGatewayPort,
  ) {}

  async obtener(distributorId: string): Promise<{
    config: CashCollectionSettings | null;
    nombres: Map<string, string>;
  }> {
    const manager = this.dataSource.manager;
    const config = await manager.findOne(CashCollectionSettings, {
      where: { distributorId },
    });
    const ids = [config?.mercadoPagoCashBoxId].filter(
      (id): id is string => !!id,
    );
    const cajas = ids.length
      ? await manager
          .createQueryBuilder(CashBox, 'c')
          .withDeleted()
          .where('c.cashBoxId IN (:...ids)', { ids })
          .getMany()
      : [];
    return {
      config,
      nombres: new Map(cajas.map((c) => [c.cashBoxId, c.name])),
    };
  }

  /** Cambia las cajas de cobro; lo que no viene queda como está y `null` la quita. */
  async actualizar(
    dto: UpdateCashCollectionSettingsDto,
    distributorId: string,
    userId: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const actual =
        (await manager.findOne(CashCollectionSettings, {
          where: { distributorId },
          lock: { mode: 'pessimistic_write' },
        })) ??
        manager.create(CashCollectionSettings, {
          distributorId,
          mercadoPagoCashBoxId: null,
        });
      if (dto.mercadoPagoCashBoxId !== undefined) {
        if (dto.mercadoPagoCashBoxId) {
          await this.exigirCaja(
            manager,
            dto.mercadoPagoCashBoxId,
            distributorId,
            CashBoxKind.WALLET,
            'Mercado Pago entra a una billetera: elegí una caja de clase billetera',
          );
        }
        actual.mercadoPagoCashBoxId = dto.mercadoPagoCashBoxId;
      }
      actual.updatedByUserId = userId;
      await manager.save(actual);
    });
  }

  /** Cobros de ventas confirmados desde `from` que no tienen movimiento de caja. */
  async pendientes(
    distributorId: string,
    from?: string,
  ): Promise<PendingCollectionsResponseDto> {
    const desde = this.desde(from);
    const manager = this.dataSource.manager;
    const mp = await this.cobrosMpPendientes(manager, distributorId, desde);
    const devoluciones = await this.devolucionesPendientes(
      manager,
      distributorId,
      desde,
    );
    const suma = <T>(filas: T[], importe: (f: T) => Decimal.Value) =>
      filas.reduce((acc, f) => acc.plus(importe(f)), new Decimal(0));
    const sumaMp = suma(mp, (c) => this.importeMp(c));
    const sumaDevoluciones = suma(devoluciones, (d) => d.amount);
    const fechas = [
      ...mp.map((c) => c.approved_at),
      ...devoluciones.map((d) => d.refunded_at),
    ].sort((a, b) => a.getTime() - b.getTime());
    const respuesta = new PendingCollectionsResponseDto();
    respuesta.from = desde;
    respuesta.count = mp.length + devoluciones.length;
    // Lo que falta entrar menos lo que falta salir: el efecto neto sobre las cajas.
    respuesta.amount = aCentavos(sumaMp.minus(sumaDevoluciones));
    respuesta.mercadoPago = { count: mp.length, amount: aCentavos(sumaMp) };
    respuesta.refunds = {
      count: devoluciones.length,
      amount: aCentavos(sumaDevoluciones),
    };
    respuesta.oldestAt = fechas[0] ?? null;
    return respuesta;
  }

  /**
   * Asienta los cobros pendientes desde `from` en las cajas configuradas: los
   * cobros de Mercado Pago (con sus devoluciones),
   * las devoluciones cuyo egreso falló y las comisiones que faltan. Cada uno va
   * en su propia transacción: uno que la caja rechaza no frena a los demás.
   * Idempotente: lo que ya tiene movimiento no se vuelve a asentar.
   */
  async asentarPendientes(
    distributorId: string,
    from: string,
    userId: string,
  ): Promise<SettlePendingResponseDto> {
    const desde = this.desde(from);
    const resumen = new SettlePendingResponseDto();
    resumen.settled = 0;
    resumen.alreadySettled = 0;
    resumen.withoutCashBox = 0;
    resumen.failed = 0;
    resumen.refundsSettled = 0;
    resumen.feesSettled = 0;
    const contar = (
      r: ResultadoDelAsiento,
      aparte?: 'refundsSettled' | 'feesSettled',
    ): void => {
      if (r === 'asentado') resumen[aparte ?? 'settled'] += 1;
      else if (r === 'ya_asentado') resumen.alreadySettled += 1;
      else if (r === 'sin_caja') resumen.withoutCashBox += 1;
      else if (r === 'fallo') resumen.failed += 1;
    };
    const base = this.dataSource.manager;

    for (const cobro of await this.cobrosMpPendientes(
      base,
      distributorId,
      desde,
    )) {
      const datos = await this.datosDelCobro(cobro);
      contar(
        await this.dataSource.transaction(async (manager) => {
          await this.bloquearPago(manager, cobro.payment_id, distributorId);
          const resultado = await this.ventas.asentarCobroDeMercadoPago(
            manager,
            {
              distributorId,
              orderId: cobro.order_id,
              paymentId: cobro.payment_id,
              gatewayPaymentId: cobro.gateway_payment_id ?? cobro.payment_id,
              amount: datos.amount,
              feeAmount: datos.fee,
              feeUnreported: datos.fee === null,
              userId,
            },
          );
          if (resultado === 'asentado') {
            await this.guardarDatosDelCobro(manager, cobro.payment_id, datos);
            await this.asentarDevolucionesYa(
              manager,
              distributorId,
              cobro,
              userId,
            );
          }
          return resultado;
        }),
      );
    }

    for (const d of await this.devolucionesPendientes(
      base,
      distributorId,
      desde,
    )) {
      contar(
        await this.dataSource.transaction(async (manager) => {
          await this.bloquearPago(manager, d.payment_id, distributorId);
          return this.ventas.asentarDevolucion(manager, {
            distributorId,
            orderId: d.order_id,
            paymentId: d.payment_id,
            refundId: d.refund_id,
            gatewayPaymentId: d.gateway_payment_id ?? d.payment_id,
            amount: d.amount,
            userId,
          });
        }),
        'refundsSettled',
      );
    }

    for (const p of await this.pagosConIngreso(base, distributorId, desde)) {
      const devuelto = numeroDe(p.metadata?.gatewayRefunded);
      if (devuelto !== null && devuelto > 0) {
        contar(
          await this.dataSource.transaction(async (manager) => {
            await this.bloquearPago(manager, p.payment_id, distributorId);
            return this.ventas.asentarDevolucionExterna(manager, {
              distributorId,
              orderId: p.order_id,
              paymentId: p.payment_id,
              gatewayPaymentId: p.gateway_payment_id ?? p.payment_id,
              refundedTotal: devuelto,
              contracargo: p.metadata?.gatewayStatus === 'charged_back',
              userId,
            });
          }),
          'refundsSettled',
        );
      }
    }

    for (const p of await this.comisionesPendientes(
      base,
      distributorId,
      desde,
    )) {
      const fee = await this.comisionDe(p);
      if (fee === null || fee <= 0) continue;
      contar(
        await this.dataSource.transaction(async (manager) => {
          await this.bloquearPago(manager, p.payment_id, distributorId);
          const r = await this.ventas.asentarComision(manager, {
            distributorId,
            orderId: p.order_id,
            paymentId: p.payment_id,
            gatewayPaymentId: p.gateway_payment_id ?? p.payment_id,
            feeAmount: fee,
            userId,
          });
          if (r === 'asentado' || r === 'ya_asentado') {
            await manager.query(
              `UPDATE "payment" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || $2::jsonb WHERE "payment_id" = $1`,
              [
                p.payment_id,
                JSON.stringify({ feeAmount: fee, feeStatus: 'reported' }),
              ],
            );
          }
          return r;
        }),
        'feesSettled',
      );
    }
    return resumen;
  }

  /**
   * Los cobros del pedido por Mercado Pago o seña y su movimiento de caja. Un
   * pedido viejo por transferencia (o su seña) no aplica: no se asentó en
   * ninguna caja ni hay nada que asentar, así que no figura acá.
   */
  async delPedido(
    orderId: string,
    distributorId: string,
  ): Promise<OrderCashSettlementResponseDto> {
    const manager = this.dataSource.manager;
    const pedidos: Array<{
      payment_method: string;
      payment_status: string;
      total: string;
      deposit_amount: string;
      deposit_paid: boolean;
      confirmed_at: Date | null;
      deposit_paid_at: Date | null;
    }> = await manager.query(
      `SELECT "paymentMethod" AS payment_method, "paymentStatus" AS payment_status, "totalAmount" AS total,
              "deposit_amount" AS deposit_amount, "deposit_paid" AS deposit_paid, "payment_confirmed_at" AS confirmed_at,
              "deposit_paid_at" AS deposit_paid_at
       FROM "order" WHERE "order_id" = $1 AND "distributor_id" = $2`,
      [orderId, distributorId],
    );
    const pedido = pedidos[0];
    if (!pedido) {
      throw new NotFoundException('Pedido no encontrado');
    }
    const pagos: Array<{
      payment_id: string;
      status: string;
      amount: string;
      metadata: Record<string, unknown> | null;
      approved_at: Date | null;
    }> = await manager.query(
      `SELECT "payment_id", "status", "amount", "metadata", "approved_at" FROM "payment"
       WHERE "order_id" = $1 AND "gateway" = 'mercadopago' AND "status" IN ('approved', 'in_mediation', 'refunded', 'charged_back')
       ORDER BY "approved_at" NULLS LAST, "createdAt"`,
      [orderId],
    );
    const haySena =
      pedido.deposit_paid_at != null && pedido.payment_method !== 'transfer';
    const referencias = [
      ...pagos.map((p) => ({
        tipo: CashReferenceType.PAYMENT,
        id: p.payment_id,
      })),
      ...(haySena
        ? [{ tipo: CashReferenceType.ORDER_DEPOSIT, id: orderId }]
        : []),
    ];
    const movimientos = referencias.length
      ? await manager.find(CashMovement, {
          where: referencias.map((r) => ({
            distributorId,
            referenceType: r.tipo,
            referenceId: r.id,
          })),
        })
      : [];
    const cajas = movimientos.length
      ? await manager.findBy(
          CashBox,
          [...new Set(movimientos.map((m) => m.cashBoxId))].map(
            (cashBoxId) => ({
              cashBoxId,
            }),
          ),
        )
      : [];
    const nombreDeCaja = new Map(cajas.map((c) => [c.cashBoxId, c.name]));
    const movimientoDe = (tipo: CashReferenceType, id: string) =>
      movimientos.find((m) => m.referenceType === tipo && m.referenceId === id);
    const entradas: OrderCollectionEntryDto[] = [];
    for (const pago of pagos) {
      const movimiento = movimientoDe(
        CashReferenceType.PAYMENT,
        pago.payment_id,
      );
      // Un pago devuelto por completo que nunca entró a una caja no se asienta (neto cero): no es un cobro pendiente.
      if (
        !movimiento &&
        (pago.status === 'refunded' || pago.status === 'charged_back')
      ) {
        continue;
      }
      entradas.push(
        this.entrada(
          'mercadopago',
          aCentavos(
            this.importeMp({ amount: pago.amount, metadata: pago.metadata }),
          ),
          pago.approved_at,
          movimiento,
          nombreDeCaja,
        ),
      );
    }
    if (haySena) {
      entradas.push(
        this.entrada(
          'deposit',
          Number(pedido.deposit_amount),
          pedido.deposit_paid_at,
          movimientoDe(CashReferenceType.ORDER_DEPOSIT, orderId),
          nombreDeCaja,
        ),
      );
    }
    const respuesta = new OrderCashSettlementResponseDto();
    respuesta.orderId = orderId;
    respuesta.entries = entradas;
    return respuesta;
  }

  private entrada(
    kind: OrderCollectionEntryDto['kind'],
    amount: number,
    collectedAt: Date | null,
    movimiento: CashMovement | undefined,
    nombreDeCaja: Map<string, string>,
  ): OrderCollectionEntryDto {
    const e = new OrderCollectionEntryDto();
    e.kind = kind;
    e.amount = amount;
    e.collectedAt = collectedAt;
    e.settled = !!movimiento;
    e.movementId = movimiento?.movementId ?? null;
    e.cashBoxId = movimiento?.cashBoxId ?? null;
    e.cashBoxName = movimiento
      ? (nombreDeCaja.get(movimiento.cashBoxId) ?? null)
      : null;
    return e;
  }

  /**
   * Lo cobrado y la comisión de un pago. Si el webhook ya los guardó, de ahí; si
   * no (pagos anteriores), se le pregunta a Mercado Pago. Si no responde, se
   * asienta por el importe del ledger y sin comisión, marcado para completarla
   * después.
   */
  private async datosDelCobro(cobro: CobroMpPendiente): Promise<{
    amount: Decimal;
    fee: number | null;
    refunded: number | null;
    consultado: boolean;
  }> {
    const guardado = numeroDe(cobro.metadata?.gatewayAmount);
    if (guardado !== null) {
      return {
        amount: new Decimal(guardado),
        fee: numeroDe(cobro.metadata?.feeAmount),
        refunded: numeroDe(cobro.metadata?.gatewayRefunded),
        consultado: false,
      };
    }
    if (cobro.gateway_payment_id) {
      try {
        const mp = await this.pasarela.getPayment(
          cobro.gateway_payment_id,
          cobro.credential_id,
        );
        return {
          amount: new Decimal(mp.amount ?? cobro.amount),
          fee: mp.feeAmount ?? null,
          refunded: mp.refundedAmount ?? null,
          consultado: true,
        };
      } catch {
        // Sin respuesta de Mercado Pago: se asienta con lo que tiene el ledger.
      }
    }
    return {
      amount: new Decimal(cobro.amount),
      fee: null,
      refunded: null,
      consultado: false,
    };
  }

  /** Deja en el pago lo que se tomó de Mercado Pago, para no volver a preguntarle. */
  private async guardarDatosDelCobro(
    manager: EntityManager,
    paymentId: string,
    datos: {
      amount: Decimal;
      fee: number | null;
      refunded: number | null;
      consultado: boolean;
    },
  ): Promise<void> {
    if (!datos.consultado && datos.fee !== null) return;
    await manager.query(
      `UPDATE "payment" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || $2::jsonb WHERE "payment_id" = $1`,
      [
        paymentId,
        JSON.stringify({
          ...(datos.consultado && {
            gatewayAmount: datos.amount.toNumber(),
            gatewayRefunded: datos.refunded,
          }),
          feeAmount: datos.fee,
          feeStatus: datos.fee === null ? 'unreported' : 'reported',
        }),
      ],
    );
  }

  /** La comisión de un cobro que entró sin ella: la guardada o, si no se informó, la que diga Mercado Pago ahora. */
  private async comisionDe(p: ComisionPendiente): Promise<number | null> {
    const guardada = numeroDe(p.metadata?.feeAmount);
    if (guardada !== null) return guardada;
    if (!p.gateway_payment_id) return null;
    try {
      return (
        (await this.pasarela.getPayment(p.gateway_payment_id, p.credential_id))
          .feeAmount ?? null
      );
    } catch {
      return null;
    }
  }

  /** Al asentar tarde un cobro, las devoluciones que ya se hicieron salen de la misma caja. */
  private async asentarDevolucionesYa(
    manager: EntityManager,
    distributorId: string,
    cobro: CobroMpPendiente,
    userId: string,
  ): Promise<void> {
    const devoluciones: Array<{ refund_id: string; amount: string }> =
      await manager.query(
        `SELECT "refund_id", "amount" FROM "payment_refund"
         WHERE "payment_id" = $1 AND "status" = 'succeeded' ORDER BY "createdAt"`,
        [cobro.payment_id],
      );
    for (const d of devoluciones) {
      await this.ventas.asentarDevolucion(manager, {
        distributorId,
        orderId: cobro.order_id,
        paymentId: cobro.payment_id,
        refundId: d.refund_id,
        gatewayPaymentId: cobro.gateway_payment_id ?? cobro.payment_id,
        amount: d.amount,
        userId,
      });
    }
  }

  private importeMp(cobro: {
    amount: string;
    metadata: Record<string, unknown> | null;
  }): Decimal {
    return new Decimal(numeroDe(cobro.metadata?.gatewayAmount) ?? cobro.amount);
  }

  private bloquearPago(
    manager: EntityManager,
    paymentId: string,
    distributorId: string,
  ): Promise<unknown> {
    return manager.query(
      `SELECT 1 FROM "payment" WHERE "payment_id" = $1 AND "distributor_id" = $2 FOR UPDATE`,
      [paymentId, distributorId],
    );
  }

  private bloquearPedido(
    manager: EntityManager,
    orderId: string,
    distributorId: string,
  ): Promise<unknown> {
    return manager.query(
      `SELECT 1 FROM "order" WHERE "order_id" = $1 AND "distributor_id" = $2 FOR UPDATE`,
      [orderId, distributorId],
    );
  }

  private cobrosMpPendientes(
    manager: EntityManager,
    distributorId: string,
    desde: Date,
  ): Promise<CobroMpPendiente[]> {
    return manager.query(
      `SELECT p."payment_id", p."order_id", p."gateway_payment_id", p."credential_id", p."amount", p."metadata", p."approved_at"
       FROM "payment" p
       WHERE p."distributor_id" = $1 AND p."gateway" = 'mercadopago' AND p."status" IN ('approved', 'in_mediation')
         AND p."approved_at" >= $2
         AND NOT EXISTS (
           SELECT 1 FROM "cash_movement" m
           WHERE m."reference_type" = 'payment' AND m."reference_id" = p."payment_id")
       ORDER BY p."approved_at"`,
      [distributorId, desde],
    );
  }

  /** Devoluciones cerradas cuyo cobro entró a una caja pero su egreso no. */
  private devolucionesPendientes(
    manager: EntityManager,
    distributorId: string,
    desde: Date,
  ): Promise<DevolucionPendiente[]> {
    return manager.query(
      `SELECT r."refund_id", r."payment_id", r."order_id", r."amount", r."refunded_at", p."gateway_payment_id"
       FROM "payment_refund" r JOIN "payment" p ON p."payment_id" = r."payment_id"
       WHERE r."distributor_id" = $1 AND r."status" = 'succeeded' AND r."refunded_at" >= $2
         AND EXISTS (
           SELECT 1 FROM "cash_movement" m
           WHERE m."reference_type" = 'payment' AND m."reference_id" = r."payment_id")
         AND NOT EXISTS (
           SELECT 1 FROM "cash_movement" m
           WHERE m."reference_type" = 'payment_refund' AND m."reference_id" = r."refund_id")
       ORDER BY r."refunded_at"`,
      [distributorId, desde],
    );
  }

  /** Pagos que ya entraron a una caja desde `desde`. */
  private pagosConIngreso(
    manager: EntityManager,
    distributorId: string,
    desde: Date,
  ): Promise<ComisionPendiente[]> {
    return manager.query(
      `SELECT p."payment_id", p."order_id", p."gateway_payment_id", p."credential_id", p."metadata"
       FROM "payment" p
       WHERE p."distributor_id" = $1 AND p."gateway" = 'mercadopago' AND p."approved_at" >= $2
         AND EXISTS (
           SELECT 1 FROM "cash_movement" m
           WHERE m."reference_type" = 'payment' AND m."reference_id" = p."payment_id")`,
      [distributorId, desde],
    );
  }

  /** Pagos que entraron a una caja sin su comisión: con la comisión conocida o sin que Mercado Pago la haya informado. */
  private comisionesPendientes(
    manager: EntityManager,
    distributorId: string,
    desde: Date,
  ): Promise<ComisionPendiente[]> {
    return manager.query(
      `SELECT p."payment_id", p."order_id", p."gateway_payment_id", p."credential_id", p."metadata"
       FROM "payment" p
       WHERE p."distributor_id" = $1 AND p."gateway" = 'mercadopago' AND p."approved_at" >= $2
         AND (COALESCE((p."metadata"->>'feeAmount')::numeric, 0) > 0 OR p."metadata"->>'feeStatus' = 'unreported')
         AND EXISTS (
           SELECT 1 FROM "cash_movement" m
           WHERE m."reference_type" = 'payment' AND m."reference_id" = p."payment_id")
         AND NOT EXISTS (
           SELECT 1 FROM "cash_movement" m
           WHERE m."reference_type" = 'payment_fee' AND m."reference_id" = p."payment_id")`,
      [distributorId, desde],
    );
  }

  private desde(from?: string): Date {
    const dia = from
      ? from.slice(0, 10)
      : sumarDias(diaArgentino(), -DIAS_POR_OMISION);
    const inicio = inicioDelDiaArgentino(dia);
    if (!inicio) throw new BadRequestException('Desde: fecha inválida');
    if (dia < sumarDias(diaArgentino(), -DIAS_MAXIMOS)) {
      throw new BadRequestException(
        `Desde: no se asienta más de ${DIAS_MAXIMOS} días hacia atrás`,
      );
    }
    return inicio;
  }

  private async exigirCaja(
    manager: EntityManager,
    cashBoxId: string,
    distributorId: string,
    clase: CashBoxKind,
    mensaje: string,
  ): Promise<void> {
    const caja = await manager.findOne(CashBox, {
      where: { cashBoxId, distributorId },
    });
    if (!caja) throw new CajaNoEncontradaError(cashBoxId);
    if (caja.kind !== clase) throw new BadRequestException(mensaje);
    if (!caja.isActive) {
      throw new BadRequestException(
        'La caja está desactivada: activala o elegí otra',
      );
    }
  }
}
