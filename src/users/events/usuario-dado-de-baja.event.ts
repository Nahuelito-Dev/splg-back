import { EntityManager } from 'typeorm';

/** Nombre del evento de la baja de CUALQUIER usuario (`UsersService.remove`). */
export const EVENTO_USUARIO_DADO_DE_BAJA = 'usuario.dado-de-baja';

/**
 * Se está dando de baja un usuario. Se emite con `emitAsync` dentro de la
 * transacción de la baja, después del evento del chofer: quien escuche (hoy
 * `employee`, que egresa el legajo y suelta la cuenta) escribe con `manager` y
 * si falla la baja entera se revierte.
 */
export class UsuarioDadoDeBajaEvent {
  constructor(
    readonly userId: string,
    readonly manager: EntityManager,
  ) {}
}
