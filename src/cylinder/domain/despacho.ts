import { CylinderState } from './cylinder-state';
import { assertTransition } from './cylinder-state.machine';
import type { Envase } from './envase';
import { EnvasesVencidosError } from './errors/cylinder-rule.errors';

/** Estado del pedido tal como lo necesita envases para decidir un despacho. */
export type EstadoDePedido =
  | 'reserved'
  | 'pending'
  | 'accepted'
  | 'on_the_way'
  | 'delivered'
  | 'cancelled';

/** Pedidos a los que todavía se les pueden cargar envases en el camión. */
const PEDIDO_DESPACHABLE: ReadonlySet<EstadoDePedido> = new Set([
  'pending',
  'accepted',
  'on_the_way',
]);

const ESTADO_DEL_PEDIDO: Readonly<Record<EstadoDePedido, string>> = {
  reserved: 'reservado a futuro',
  pending: 'pendiente',
  accepted: 'aceptado',
  on_the_way: 'en camino',
  delivered: 'entregado',
  cancelled: 'cancelado',
};

/** Sólo se cargan envases a pedidos pendientes, aceptados o en camino. */
export function pedidoAdmiteCarga(estado: EstadoDePedido): boolean {
  return PEDIDO_DESPACHABLE.has(estado);
}

/** Cómo se le nombra el estado del pedido a quien carga. */
export function etiquetaDeEstadoDePedido(estado: EstadoDePedido): string {
  return ESTADO_DEL_PEDIDO[estado];
}

/**
 * Control de una carga completa, antes de escribir nada: primero la máquina de
 * estados (un despacho inválido no es un bloqueo por vencimiento) y después la
 * vigencia. Un solo envase vencido rechaza la carga entera, con todos los
 * seriales vencidos (CU-135).
 */
export function asegurarDespachables(
  envases: readonly Envase[],
  ahora: Date,
): void {
  for (const envase of envases) {
    assertTransition(envase.state, CylinderState.DISPATCHED);
  }
  const vencidos = envases
    .filter((envase) => envase.estaVencido(ahora))
    .map((envase) => envase.serial);
  if (vencidos.length > 0) throw new EnvasesVencidosError(vencidos);
}
