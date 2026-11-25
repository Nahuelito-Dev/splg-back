import { Injectable } from '@nestjs/common';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import {
  OrderDispatchPort,
  PedidoParaDespacho,
} from '../domain/ports/order-dispatch.port';
import { Transaccion } from '../domain/ports/unit-of-work.port';
import { managerDe } from './typeorm-unit-of-work.adapter';

/**
 * Adaptador: el pedido lo lee `OrderLookupModule` (no `OrderModule`, que
 * importa a envases para avanzar los envases al entregar).
 */
@Injectable()
export class OrderDispatchAdapter extends OrderDispatchPort {
  constructor(private readonly orders: OrderLookupService) {
    super();
  }

  paraDespacho(
    orderId: string,
    distributorId: string,
    tx: Transaccion,
  ): Promise<PedidoParaDespacho | null> {
    // `OrderStatus` y `EstadoDePedido` comparten los mismos valores.
    return this.orders.findParaDespacho(orderId, distributorId, managerDe(tx));
  }

  titular(
    orderId: string,
    distributorId?: string | null,
  ): Promise<{ customerId: string } | null> {
    return this.orders.findRef(orderId, distributorId);
  }
}
