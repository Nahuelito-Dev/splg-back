import type { EstadoDePedido } from '../despacho';
import type { Transaccion } from './unit-of-work.port';

/** El pedido visto desde envases para cargarle envases: titular, estado y chofer. */
export interface PedidoParaDespacho {
  orderId: string;
  customerId: string;
  status: EstadoDePedido;
  deliveryId: string | null;
}

/**
 * PUERTO de pedidos visto desde envases. Envases no conoce el módulo de
 * pedidos: sólo necesita saber de quién es un pedido, en qué está y quién lo
 * lleva.
 */
export abstract class OrderDispatchPort {
  /**
   * El pedido de la distribuidora (lo ajeno es `null`), leído dentro de la
   * transacción y bloqueado para que una entrega, cancelación o reasignación
   * concurrente espere: lo validado sigue valiendo hasta el final.
   */
  abstract paraDespacho(
    orderId: string,
    distributorId: string,
    tx: Transaccion,
  ): Promise<PedidoParaDespacho | null>;

  /** El titular del pedido. */
  abstract titular(
    orderId: string,
    distributorId?: string | null,
  ): Promise<{ customerId: string } | null>;
}
