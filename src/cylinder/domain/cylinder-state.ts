/**
 * Estado del ciclo de vida FÍSICO del envase. No confundir con `OrderStatus`
 * (estado del pedido) ni con `gas_cylinder` (el TIPO de producto, ej "Garrafa
 * 10kg"): acá cada fila es UNA garrafa real, identificada por su serial.
 */
export enum CylinderState {
  IN_DEPOT = 'in_depot',
  FILLED = 'filled',
  DISPATCHED = 'dispatched',
  WITH_CUSTOMER = 'with_customer',
  EMPTY_RETURNED = 'empty_returned',
  /** Dado de baja: estado terminal, ya no vuelve a circular. */
  RETIRED = 'retired',
}

/** Estados en los que el envase está fuera de la distribuidora. */
export const FUERA_DEL_DEPOSITO: readonly CylinderState[] = [
  CylinderState.DISPATCHED,
  CylinderState.WITH_CUSTOMER,
];
