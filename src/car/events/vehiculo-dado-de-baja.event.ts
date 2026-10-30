/**
 * Se dio de baja un vehículo (baja lógica). Lo escuchan los módulos que tienen
 * algo abierto sobre el vehículo (el planificador de taller, CU-105): `car` no
 * los conoce.
 */
export const EVENTO_VEHICULO_DADO_DE_BAJA = 'car.dado-de-baja';

export class VehiculoDadoDeBajaEvent {
  constructor(
    readonly carId: string,
    readonly distributorId: string,
  ) {}
}
