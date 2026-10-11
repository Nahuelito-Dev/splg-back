import { Brackets, FindOptionsWhere, Not, SelectQueryBuilder } from 'typeorm';
import {
  Order,
  PaymentMethod,
  PaymentStatus,
} from '../../order/entities/order.entity';

/**
 * Qué cuenta como VENTA en los reportes: un pedido entregado y COBRADO.
 *  - `paid`: cobrado.
 *  - `pending` con un medio que no es efectivo (transferencia, Mercado Pago):
 *    siguen su propio flujo y cuentan como siempre.
 * No cuentan el efectivo entregado y todavía sin confirmar por el chofer
 * (`pending`), el impago (`unpaid`) ni lo dado por perdido (`written_off`);
 * esas cifras van aparte (`ReportsService.getCollections`).
 */
export function esVentaCobrada(
  order: Pick<Order, 'paymentStatus' | 'paymentMethod'>,
): boolean {
  return (
    order.paymentStatus === PaymentStatus.PAID ||
    (order.paymentStatus === PaymentStatus.PENDING &&
      order.paymentMethod !== PaymentMethod.CASH)
  );
}

/** Lo mismo como `where` de TypeORM (find/sum/count): dos alternativas. */
export function ventaCobradaWhere(
  base: FindOptionsWhere<Order>,
): FindOptionsWhere<Order>[] {
  return [
    { ...base, paymentStatus: PaymentStatus.PAID },
    {
      ...base,
      paymentStatus: PaymentStatus.PENDING,
      paymentMethod: Not(PaymentMethod.CASH),
    },
  ];
}

/** Lo mismo para un query builder cuyo alias de `Order` es `alias`. */
export function soloVentaCobrada<T extends object>(
  qb: SelectQueryBuilder<T>,
  alias: string,
): SelectQueryBuilder<T> {
  return qb.andWhere(
    new Brackets((w) => {
      w.where(`${alias}.paymentStatus = :vcPaid`, {
        vcPaid: PaymentStatus.PAID,
      }).orWhere(
        `(${alias}.paymentStatus = :vcPending AND ${alias}.paymentMethod <> :vcCash)`,
        { vcPending: PaymentStatus.PENDING, vcCash: PaymentMethod.CASH },
      );
    }),
  );
}
