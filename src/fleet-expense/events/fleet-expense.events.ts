/** Una carga de combustible con el consumo del tramo fuera de lo habitual (CU-195). */
export const EVENTO_CARGA_ANOMALA = 'fleet-expense.carga-anomala';

export class CargaDeCombustibleAnomalaEvent {
  constructor(
    readonly distributorId: string,
    readonly fuelLoadId: string,
    readonly carId: string,
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
