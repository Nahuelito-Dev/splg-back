import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';
import type { PagoDelLibro } from '../domain/reconciliation';

interface FilaPago {
  payment_id: string;
  order_id: string;
  gateway_payment_id: string;
  distributor_id: string | null;
}

interface FilaMovimiento {
  reference_id: string;
  cash_box_id: string;
  amount: string;
  occurred_at: Date;
}

/** Qué pagos de Mercado Pago son de la distribuidora y cómo están en el libro de cajas. */
@Injectable()
export class MpLedgerReader {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Separa los ids de Mercado Pago del reporte en los de la distribuidora
   * (con su estado en el libro) y los de otras distribuidoras.
   */
  async pagosDeLosIds(
    manager: EntityManager,
    distributorId: string,
    gatewayIds: string[],
  ): Promise<{
    propios: Map<string, PagoDelLibro>;
    ajenos: Set<string>;
    sinDistribuidora: Set<string>;
  }> {
    const propios = new Map<string, PagoDelLibro>();
    const ajenos = new Set<string>();
    const sinDistribuidora = new Set<string>();
    if (gatewayIds.length === 0) return { propios, ajenos, sinDistribuidora };
    const pagos: FilaPago[] = await manager.query(
      `SELECT "payment_id", "order_id", "gateway_payment_id", "distributor_id" FROM "payment"
       WHERE "gateway" = 'mercadopago' AND "gateway_payment_id" = ANY($1::text[])`,
      [gatewayIds],
    );
    const deLaDistribuidora = pagos.filter(
      (p) => p.distributor_id === distributorId,
    );
    for (const p of pagos) {
      if (p.distributor_id === null) sinDistribuidora.add(p.gateway_payment_id);
      else if (p.distributor_id !== distributorId) {
        ajenos.add(p.gateway_payment_id);
      }
    }
    const estado = await this.estadoEnElLibro(
      manager,
      distributorId,
      deLaDistribuidora.map((p) => p.payment_id),
    );
    for (const p of deLaDistribuidora) {
      propios.set(p.gateway_payment_id, {
        paymentId: p.payment_id,
        orderId: p.order_id,
        gatewayPaymentId: p.gateway_payment_id,
        ...(estado.get(p.payment_id) ?? {
          ingreso: null,
          comision: null,
          devolucionComprometida: new Decimal(0),
        }),
      });
    }
    return { propios, ajenos, sinDistribuidora };
  }

  /** Los cobros de la distribuidora cuyo ingreso entró a la caja entre `desde` y `hasta`. */
  async ingresosDelRango(
    manager: EntityManager,
    distributorId: string,
    desde: Date,
    hasta: Date,
  ): Promise<PagoDelLibro[]> {
    const pagos: FilaPago[] = await manager.query(
      `SELECT p."payment_id", p."order_id", p."gateway_payment_id", p."distributor_id"
       FROM "payment" p
       WHERE p."distributor_id" = $1 AND p."gateway" = 'mercadopago' AND p."gateway_payment_id" IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM "cash_movement" m
           WHERE m."reference_type" = 'payment' AND m."reference_id" = p."payment_id"
             AND m."occurred_at" >= $2 AND m."occurred_at" < $3)`,
      [distributorId, desde, hasta],
    );
    const estado = await this.estadoEnElLibro(
      manager,
      distributorId,
      pagos.map((p) => p.payment_id),
    );
    return pagos.map((p) => ({
      paymentId: p.payment_id,
      orderId: p.order_id,
      gatewayPaymentId: p.gateway_payment_id,
      ...(estado.get(p.payment_id) ?? {
        ingreso: null,
        comision: null,
        devolucionComprometida: new Decimal(0),
      }),
    }));
  }

  /** Entradas y salidas de una caja entre `desde` y `hasta`. */
  async movimientosDeLaCaja(
    manager: EntityManager,
    distributorId: string,
    cashBoxId: string,
    desde: Date,
    hasta: Date,
  ): Promise<{ income: Decimal; expense: Decimal }> {
    const filas: Array<{ direction: string; total: string }> =
      await manager.query(
        `SELECT "direction", COALESCE(SUM("amount"), 0) AS total FROM "cash_movement"
         WHERE "distributor_id" = $1 AND "cash_box_id" = $2 AND "occurred_at" >= $3 AND "occurred_at" < $4
         GROUP BY "direction"`,
        [distributorId, cashBoxId, desde, hasta],
      );
    const total = (sentido: string): Decimal =>
      new Decimal(filas.find((f) => f.direction === sentido)?.total ?? 0);
    return { income: total('in'), expense: total('out') };
  }

  private async estadoEnElLibro(
    manager: EntityManager,
    distributorId: string,
    paymentIds: string[],
  ): Promise<
    Map<
      string,
      Pick<PagoDelLibro, 'ingreso' | 'comision' | 'devolucionComprometida'>
    >
  > {
    const estado = new Map<
      string,
      Pick<PagoDelLibro, 'ingreso' | 'comision' | 'devolucionComprometida'>
    >();
    if (paymentIds.length === 0) return estado;
    for (const id of paymentIds) {
      estado.set(id, {
        ingreso: null,
        comision: null,
        devolucionComprometida: new Decimal(0),
      });
    }
    const movimientos = (tipo: string): Promise<FilaMovimiento[]> =>
      manager.query(
        `SELECT "reference_id", "cash_box_id", "amount", "occurred_at" FROM "cash_movement"
         WHERE "distributor_id" = $1 AND "reference_type" = $2 AND "reference_id" = ANY($3::uuid[])`,
        [distributorId, tipo, paymentIds],
      );
    for (const m of await movimientos('payment')) {
      const e = estado.get(m.reference_id);
      if (e) {
        e.ingreso = {
          cashBoxId: m.cash_box_id,
          amount: new Decimal(m.amount),
          occurredAt: m.occurred_at,
        };
      }
    }
    for (const m of await movimientos('payment_fee')) {
      const e = estado.get(m.reference_id);
      if (e) e.comision = new Decimal(m.amount);
    }
    // Los ajustes de comisión que ya se asentaron desde una conciliación forman parte de lo que cobró Mercado Pago.
    const ajustes: Array<{ payment_id: string; total: string }> =
      await manager.query(
        `SELECT "payment_id", COALESCE(SUM("difference"), 0) AS total FROM "mp_reconciliation_item"
         WHERE "distributor_id" = $1 AND "kind" = 'fee_mismatch' AND "status" = 'applied' AND "payment_id" = ANY($2::uuid[])
         GROUP BY "payment_id"`,
        [distributorId, paymentIds],
      );
    for (const a of ajustes) {
      const e = estado.get(a.payment_id);
      if (e?.comision) e.comision = e.comision.plus(a.total);
    }
    // Lo devuelto o a punto de devolverse (como `comprometidoDelPago` de la etapa 3).
    const comprometidos: Array<{ payment_id: string; total: string }> =
      await manager.query(
        `SELECT p."payment_id", (
           COALESCE((SELECT SUM(r."amount") FROM "payment_refund" r
                     WHERE r."payment_id" = p."payment_id" AND r."status" IN ('succeeded', 'pending')), 0)
         + COALESCE((SELECT SUM(m."amount") FROM "cash_movement" m
                     WHERE m."reference_type" = 'payment_external_refund' AND m."reference_id" = p."payment_id"), 0)
         ) AS total
         FROM "payment" p WHERE p."payment_id" = ANY($1::uuid[])`,
        [paymentIds],
      );
    for (const c of comprometidos) {
      const e = estado.get(c.payment_id);
      if (e) e.devolucionComprometida = new Decimal(c.total);
    }
    return estado;
  }
}
