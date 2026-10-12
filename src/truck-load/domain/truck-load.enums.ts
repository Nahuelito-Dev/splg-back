export enum TruckLoadStatus {
  LOADING = 'loading',
  ON_ROUTE = 'on_route',
  RETURNED = 'returned',
  CLOSED = 'closed',
  CLOSED_WITH_DIFFERENCE = 'closed_with_difference',
  CANCELLED = 'cancelled',
}

/** Estados en los que el camión y el chofer tienen la carga abierta. */
export const ESTADOS_ABIERTOS: readonly TruckLoadStatus[] = [
  TruckLoadStatus.LOADING,
  TruckLoadStatus.ON_ROUTE,
  TruckLoadStatus.RETURNED,
];
