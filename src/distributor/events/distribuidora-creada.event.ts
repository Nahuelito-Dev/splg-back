/** Nombre del evento que publica `distributor` después de confirmar un alta. */
export const EVENTO_DISTRIBUIDORA_CREADA = 'distribuidora.creada';

/**
 * Se dio de alta una distribuidora nueva. Quien necesite sembrar datos base
 * por distribuidora (hoy: `fleet`, con sus 4 planes de mantenimiento) lo
 * escucha acá en vez de que `distributor` lo llame directo: así `distributor`
 * no depende de `fleet` (CONVENCIONES §4).
 */
export class DistribuidoraCreadaEvent {
  constructor(readonly distributorId: string) {}
}
