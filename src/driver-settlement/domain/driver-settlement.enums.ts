export enum DriverSettlementStatus {
  OPEN = 'open',
  SUBMITTED = 'submitted',
  APPROVED = 'approved',
}

/**
 * Rendición «sin cerrar»: todavía no aprobada, así que el efectivo no entró a
 * ninguna caja. Es el único criterio de «pendiente» del módulo: lo usan el
 * tablero financiero (CU-245) y el egreso del chofer (CU-181).
 */
export const ESTADOS_SIN_CERRAR: readonly DriverSettlementStatus[] = [
  DriverSettlementStatus.OPEN,
  DriverSettlementStatus.SUBMITTED,
];

/** Qué se hace con la diferencia (faltante o sobrante) al aprobar. */
export enum DifferenceResolution {
  NONE = 'none',
  CHARGED_TO_DRIVER = 'charged_to_driver',
  ABSORBED = 'absorbed',
}
