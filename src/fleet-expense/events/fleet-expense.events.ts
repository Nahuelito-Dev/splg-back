/** Una carga de combustible con el consumo del tramo fuera de lo habitual (CU-195). */
export const EVENTO_CARGA_ANOMALA = 'fleet-expense.carga-anomala';

export class CargaDeCombustibleAnomalaEvent {
  constructor(
    readonly distributorId: string,
    readonly fuelLoadId: string,
    readonly carId: string,
  ) {}
}

/**
 * Un siniestro dejó el vehículo fuera de servicio pero su chofer sigue con un
 * pedido en curso o una carga de camión abierta: la asignación se mantiene y
 * los administradores tienen que resolverlo (CU-201).
 */
export const EVENTO_SINIESTRO_CON_ASIGNACION_PENDIENTE =
  'fleet-expense.siniestro-con-asignacion-pendiente';

export class SiniestroConAsignacionPendienteEvent {
  constructor(
    readonly distributorId: string,
    readonly accidentId: string,
    readonly carId: string,
    readonly motivo: string,
  ) {}
}

/** Siniestro con fuga o derrame de gas (CU-201): se avisa de inmediato. */
export const EVENTO_SINIESTRO_CON_DERRAME =
  'fleet-expense.siniestro-con-derrame';

export class SiniestroConDerrameEvent {
  constructor(
    readonly distributorId: string,
    readonly accidentId: string,
    readonly carId: string,
  ) {}
}
