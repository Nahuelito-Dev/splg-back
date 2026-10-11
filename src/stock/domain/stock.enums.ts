/** Condición física de una garrafa en una ubicación. */
export enum StockCondition {
  FULL = 'full',
  EMPTY = 'empty',
  DEFECTIVE = 'defective',
}

export enum WarehouseKind {
  DEPOT = 'depot',
  BRANCH = 'branch',
}

export enum StockLocationKind {
  WAREHOUSE = 'warehouse',
  VEHICLE = 'vehicle',
}

/** Por qué se movió el stock. Es lo que se filtra en el libro de movimientos. */
export enum StockMovementReason {
  INITIAL_COUNT = 'initial_count',
  PURCHASE_RECEIPT = 'purchase_receipt',
  PLANT_EMPTY_OUT = 'plant_empty_out',
  TRUCK_LOAD = 'truck_load',
  TRUCK_RETURN = 'truck_return',
  DELIVERY = 'delivery',
  EMPTY_COLLECTED = 'empty_collected',
  TRANSFER = 'transfer',
  ADJUSTMENT = 'adjustment',
  SHRINKAGE = 'shrinkage',
  CONDITION_CHANGE = 'condition_change',
  REVERSAL = 'reversal',
}

/** Qué documento u operación originó el movimiento. */
export enum StockReferenceType {
  ORDER = 'order',
  PURCHASE_RECEIPT = 'purchase_receipt',
  TRUCK_LOAD = 'truck_load',
  STOCK_ADJUSTMENT = 'stock_adjustment',
  TRANSFER = 'transfer',
  INITIAL = 'initial',
}

export enum StockAdjustmentReason {
  COUNT_CORRECTION = 'count_correction',
  SHRINKAGE = 'shrinkage',
  LEAK = 'leak',
  DAMAGED = 'damaged',
  LOST = 'lost',
  FOUND = 'found',
  INITIAL_COUNT = 'initial_count',
  /** Corrige sólo el vendible hasta la invariante; no mueve el físico. */
  RECONCILIATION = 'reconciliation',
}
