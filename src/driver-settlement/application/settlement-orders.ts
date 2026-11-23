import Decimal from 'decimal.js';
import { EntityManager } from 'typeorm';
import {
  ZONA_ARGENTINA,
  rangoDelDiaArgentino,
} from '../../common/utils/dias-argentina';
import { dec } from '../../common/utils/dinero';
import { saldoACobrar } from '../../truck-load/domain/truck-load-rules';

/** Un pedido en efectivo entregado que el chofer todavía no rindió. */
export interface PedidoSinRendir {
  orderId: string;
  totalAmount: number;
  amountToCollect: number;
  paymentStatus: string;
  deliveredAt: Date;
}

/**
 * La regla única de "este pedido le toca a la rendición del día" (alias `o`):
 * la usan tanto la lectura de la rendición como la candidatura nocturna, para
 * que el proceso no abra rendiciones que después quedarían vacías.
 *
 * Un pedido cuyo cobro resolvió o registró un administrador (`payment_resolved_by`)
 * no lo cobró el chofer: no forma parte del efectivo que tiene que entregar.
 */
function condicionSinRendir(hasta: string, dia: string): string {
  return `o."status" = 'delivered'
       AND o."paymentMethod" = 'cash' AND o."paymentStatus" IN ('paid', 'pending')
       AND o."payment_resolved_by" IS NULL
       AND o."deliveredAt" < ${hasta}
       AND NOT EXISTS (SELECT 1 FROM "driver_settlement_order" d WHERE d."order_id" = o."order_id")
       AND NOT EXISTS (
         SELECT 1 FROM "driver_settlement" s
         WHERE s."delivery_id" = o."delivery_id" AND s."status" = 'open'
           AND s."business_date" < ${dia}::date
           AND s."business_date" = (o."deliveredAt" AT TIME ZONE '${ZONA_ARGENTINA}')::date)`;
}

/**
 * Choferes con al menos un pedido que entra a la rendición de ese día y que
 * todavía no tienen rendición para él (candidatos del proceso nocturno).
 */
export async function choferesConPedidosSinRendir(
  manager: EntityManager,
  businessDate: string,
): Promise<Array<{ distributorId: string; deliveryId: string }>> {
  const rango = rangoDelDiaArgentino(businessDate);
  if (!rango) return [];
  const filas: Array<{ distributor_id: string; delivery_id: string }> =
    await manager.query(
      `SELECT DISTINCT o."distributor_id", o."delivery_id" FROM "order" o
       WHERE o."delivery_id" IS NOT NULL
         AND ${condicionSinRendir('$1', '$2')}
         AND NOT EXISTS (
           SELECT 1 FROM "driver_settlement" s
           WHERE s."delivery_id" = o."delivery_id" AND s."business_date" = $2::date)`,
      [rango.hasta, businessDate],
    );
  return filas.map((f) => ({
    distributorId: f.distributor_id,
    deliveryId: f.delivery_id,
  }));
}

/**
 * Pedidos en efectivo que entran a la rendición de un chofer y un día de
 * negocio: entregados antes del fin de ese día, cobrados o pendientes de
 * confirmar (un impago no se cobró), y que ninguna rendición tomó todavía.
 * Los de un día anterior cuya rendición sigue abierta son de ESA rendición; si
 * esa ya se presentó, lo entregado después cae en la del día siguiente.
 *
 * Con `bloquear` (al presentar la rendición) toma los pedidos `FOR UPDATE`: un
 * cobro del administrador concurrente espera, y al soltarse la condición se
 * reevalúa (`payment_resolved_by`), así el pedido que ya cobró él no se rinde.
 *
 * Es un modelo de lectura sobre `order`: lo que el chofer efectivamente cobra
 * es el total menos la seña ya paga (la misma regla que la rendición del camión).
 */
export async function pedidosSinRendir(
  manager: EntityManager,
  args: { distributorId: string; deliveryId: string; businessDate: string },
  opciones: { bloquear?: boolean } = {},
): Promise<PedidoSinRendir[]> {
  const rango = rangoDelDiaArgentino(args.businessDate);
  if (!rango) return [];
  const filas: Array<{
    order_id: string;
    total: string;
    payment_status: string;
    delivered_at: Date;
    sena: string;
  }> = await manager.query(
    `SELECT o."order_id", o."totalAmount"::text AS total, o."paymentStatus" AS payment_status,
            o."deliveredAt" AS delivered_at,
            (CASE WHEN o."deposit_paid" THEN o."deposit_amount" ELSE 0 END)::text AS sena
     FROM "order" o
     WHERE o."distributor_id" = $1 AND o."delivery_id" = $2
       AND ${condicionSinRendir('$3', '$4')}
     ORDER BY o."deliveredAt", o."order_id"${opciones.bloquear ? '\n     FOR UPDATE OF o' : ''}`,
    [args.distributorId, args.deliveryId, rango.hasta, args.businessDate],
  );
  return filas.map((f) => ({
    orderId: f.order_id,
    totalAmount: Number(f.total),
    amountToCollect: saldoACobrar(Number(f.total), Number(f.sena)),
    paymentStatus: f.payment_status,
    deliveredAt: f.delivered_at,
  }));
}

export function sumaACobrar(pedidos: PedidoSinRendir[]): Decimal {
  return pedidos.reduce((s, p) => s.plus(p.amountToCollect), dec(0));
}

/** El efectivo cobrado y no rendido de un chofer, con lo que lleva sin entrar a una rendición. */
export interface EfectivoSinRendirDeChofer {
  deliveryId: string;
  driverName: string | null;
  orders: number;
  amount: number;
  oldestDeliveredAt: Date;
  ageHours: number;
}

/**
 * Efectivo de pedidos entregados que ninguna rendición tomó todavía, por chofer
 * (el mismo criterio de `condicionSinRendir` salvo el día: acá no hay corte).
 * Con `masViejosDeHoras` sólo cuentan los entregados hace al menos esas horas.
 * Los choferes salen del más viejo al más nuevo. El monto es el saldo que cobró
 * el chofer (total menos la seña ya paga), la misma regla de la rendición.
 *
 * Una rendición presentada (`submitted`) ya tomó sus pedidos al presentarse
 * (`driver_settlement_order`): cuenta como rendida, el chofer ya entregó el
 * efectivo. Si se reabre, los libera y vuelven a contar acá.
 */
export async function efectivoSinRendirPorChofer(
  manager: EntityManager,
  distributorId: string,
  opciones: { ahora?: Date; masViejosDeHoras?: number } = {},
): Promise<EfectivoSinRendirDeChofer[]> {
  const ahora = opciones.ahora ?? new Date();
  const corte =
    opciones.masViejosDeHoras === undefined
      ? null
      : ahora.getTime() - opciones.masViejosDeHoras * 3_600_000;
  const filas: Array<{
    delivery_id: string;
    driver_name: string | null;
    total: string;
    sena: string;
    delivered_at: Date;
  }> = await manager.query(
    `SELECT o."delivery_id", u."full_name" AS driver_name, o."totalAmount"::text AS total,
            (CASE WHEN o."deposit_paid" THEN o."deposit_amount" ELSE 0 END)::text AS sena,
            o."deliveredAt" AS delivered_at
     FROM "order" o
     JOIN "delivery" d ON d."delivery_id" = o."delivery_id"
     JOIN "user" u ON u."user_id" = d."user_id"
     WHERE o."distributor_id" = $1 AND o."delivery_id" IS NOT NULL
       AND o."status" = 'delivered'
       AND o."paymentMethod" = 'cash' AND o."paymentStatus" IN ('paid', 'pending')
       AND o."payment_resolved_by" IS NULL
       AND o."deliveredAt" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "driver_settlement_order" s WHERE s."order_id" = o."order_id")
     ORDER BY o."deliveredAt", o."order_id"`,
    [distributorId],
  );
  const porChofer = new Map<
    string,
    { nombre: string | null; pedidos: number; monto: Decimal; viejo: Date }
  >();
  for (const f of filas) {
    if (corte !== null && new Date(f.delivered_at).getTime() > corte) continue;
    const actual = porChofer.get(f.delivery_id);
    const monto = dec(saldoACobrar(Number(f.total), Number(f.sena)));
    if (actual) {
      actual.pedidos += 1;
      actual.monto = actual.monto.plus(monto);
    } else {
      porChofer.set(f.delivery_id, {
        nombre: f.driver_name,
        pedidos: 1,
        monto,
        viejo: new Date(f.delivered_at),
      });
    }
  }
  return [...porChofer.entries()]
    .map(([deliveryId, c]) => ({
      deliveryId,
      driverName: c.nombre,
      orders: c.pedidos,
      amount: c.monto.toNumber(),
      oldestDeliveredAt: c.viejo,
      ageHours: Math.max(
        0,
        Math.floor((ahora.getTime() - c.viejo.getTime()) / 3_600_000),
      ),
    }))
    .sort(
      (a, b) => a.oldestDeliveredAt.getTime() - b.oldestDeliveredAt.getTime(),
    );
}
