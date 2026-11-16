import { FindOptionsWhere, SelectQueryBuilder } from 'typeorm';
import { Order, PaymentStatus } from '../../order/entities/order.entity';

/**
 * Qué cuenta como VENTA en los reportes: un pedido entregado y COBRADO, o sea
 * con `paymentStatus: paid`, cualquiera sea el medio. Una transferencia o un
 * Mercado Pago `pending` todavía no está cobrado; tampoco el efectivo sin
 * confirmar por el chofer, el impago (`unpaid`) ni lo perdido (`written_off`);
 * esas cifras van aparte (`ReportsService.getCollections`).
 */
export function esVentaCobrada(order: Pick<Order, 'paymentStatus'>): boolean {
  return order.paymentStatus === PaymentStatus.PAID;
}

/** Lo mismo como `where` de TypeORM (find/sum/count). */
export function ventaCobradaWhere(
  base: FindOptionsWhere<Order>,
): FindOptionsWhere<Order>[] {
  return [{ ...base, paymentStatus: PaymentStatus.PAID }];
}

/** Lo mismo para un query builder cuyo alias de `Order` es `alias`. */
export function soloVentaCobrada<T extends object>(
  qb: SelectQueryBuilder<T>,
  alias: string,
): SelectQueryBuilder<T> {
  return qb.andWhere(`${alias}.paymentStatus = :vcPaid`, {
    vcPaid: PaymentStatus.PAID,
  });
}
