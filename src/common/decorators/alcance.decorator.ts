import { SetMetadata } from '@nestjs/common';

export const ALCANCE_KEY = 'alcance';

/**
 * A quién le sirve un endpoint, para el administrador general (modo soporte):
 *  - `plataforma`: lo de la plataforma (empresas, roles del sistema, pruebas).
 *    Sin tenant y sin sesión de soporte.
 *  - `empresa`: la operación de una distribuidora. El administrador general
 *    sólo entra con una sesión de soporte activa, y sólo a leer.
 *  - `ambos`: existe para los dos con contenido distinto; sin sesión devuelve
 *    la versión de plataforma, con sesión la de la empresa (sólo lectura).
 *
 * Casi nada se marca a mano: la regla por defecto está en `resolverAlcance`.
 */
export type Alcance = 'plataforma' | 'empresa' | 'ambos';

/** Marca el alcance de un endpoint o de un controller entero. */
export const Alcance = (alcance: Alcance) => SetMetadata(ALCANCE_KEY, alcance);
