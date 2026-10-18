export enum DriverSettlementStatus {
  OPEN = 'open',
  SUBMITTED = 'submitted',
  APPROVED = 'approved',
}

/** Qué se hace con la diferencia (faltante o sobrante) al aprobar. */
export enum DifferenceResolution {
  NONE = 'none',
  CHARGED_TO_DRIVER = 'charged_to_driver',
  ABSORBED = 'absorbed',
}
