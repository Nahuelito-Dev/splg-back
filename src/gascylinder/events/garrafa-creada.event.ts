/** Nombre del evento que publica `gascylinder` después de dar de alta un producto. */
export const EVENTO_GARRAFA_CREADA = 'garrafa.creada';

import type { EntityManager } from 'typeorm';

/**
 * Se dio de alta un tipo de garrafa con stock vendible inicial. El módulo de
 * stock lo escucha para registrar ese stock como físico del depósito
 * predeterminado (CONVENCIONES §4: `gascylinder` no depende de `stock`).
 */
export class GarrafaCreadaEvent {
  constructor(
    readonly gasCylinderId: string,
    readonly distributorId: string,
    readonly stock: number,
    readonly manager: EntityManager,
  ) {}
}
