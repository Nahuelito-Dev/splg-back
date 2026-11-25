import { ConflictException, NotFoundException } from '@nestjs/common';
import { RoleType } from '../../common/constants/role-type.enum';
import {
  etiquetaDeEstadoDePedido,
  pedidoAdmiteCarga,
} from '../domain/despacho';
import type { PedidoParaDespacho } from '../domain/ports/order-dispatch.port';

/** Un chofer sólo opera sobre pedidos asignados a él: el ajeno no existe para él (404). */
export function asegurarPedidoDelChofer(
  pedido: PedidoParaDespacho,
  deliveryId: string | null,
  role?: RoleType,
): void {
  if (role !== RoleType.DELIVERY) return;
  if (!deliveryId || pedido.deliveryId !== deliveryId) {
    throw new NotFoundException('Pedido no encontrado');
  }
}

/** Sólo se cargan envases a pedidos pendientes, aceptados o en camino (409). */
export function asegurarPedidoDespachable(pedido: PedidoParaDespacho): void {
  if (!pedidoAdmiteCarga(pedido.status)) {
    throw new ConflictException(
      `El pedido está ${etiquetaDeEstadoDePedido(pedido.status)}: no se le pueden asignar envases`,
    );
  }
}
