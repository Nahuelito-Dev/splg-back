/**
 * Fixtures de pedidos que cumplen las reglas de la base (tanda V1): un pedido
 * aceptado, en camino o entregado tiene chofer y las fechas de cada paso; el
 * cancelado lleva motivo; el total es la suma de sus partes.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Delivery } from '../../../src/delivery/entities/delivery.entity';
import { User } from '../../../src/users/entities/user.entity';
import { OrderStatus } from '../../../src/order/entities/order.entity';
import { telefonoDePrueba } from './test-env';

/** Las tres fechas de un pedido entregado (aceptado, en camino, entregado). */
export function fechasDeEntrega(entregado: Date = new Date()): {
  acceptedAt: Date;
  onTheWayAt: Date;
  deliveredAt: Date;
} {
  return {
    acceptedAt: entregado,
    onTheWayAt: entregado,
    deliveredAt: entregado,
  };
}

/** Un chofer de la distribuidora, para los pedidos que lo exigen. */
export async function sembrarChoferDeFixture(
  dataSource: DataSource,
  distributorId: string,
): Promise<Delivery> {
  const sufijo = randomUUID().slice(0, 8);
  const user = await dataSource.getRepository(User).save({
    email: `chofer.fixture.${sufijo}@splg.local`,
    fullName: `Chofer ${sufijo}`,
    phoneNumber: telefonoDePrueba(),
  } as Partial<User>);
  return dataSource.getRepository(Delivery).save({
    userId: user.userId,
    distributorId,
    validated: true,
    isEnabled: true,
  } as Partial<Delivery>);
}

/**
 * Las fechas y el motivo que la base exige según el estado del pedido
 * (`CHK_order_aceptado_fecha`, `_en_camino_fecha`, `_entregado_fecha`,
 * `_cancelado_motivo`). Se mezcla antes de los campos propios del caso.
 */
export function fechasSegunEstado(
  estado: OrderStatus,
  instante: Date = new Date(),
): {
  acceptedAt?: Date;
  onTheWayAt?: Date;
  deliveredAt?: Date;
  cancellationReason?: string;
} {
  switch (estado) {
    case OrderStatus.ACCEPTED:
      return { acceptedAt: instante };
    case OrderStatus.ON_THE_WAY:
      return { acceptedAt: instante, onTheWayAt: instante };
    case OrderStatus.DELIVERED:
      return fechasDeEntrega(instante);
    case OrderStatus.CANCELLED:
      return { cancellationReason: 'Cancelado en la prueba' };
    default:
      return {};
  }
}
