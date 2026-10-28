/**
 * Se le cortó el acceso a un usuario (bloqueo o baja): las conexiones de tiempo
 * real que tenga abiertas se cierran en el momento, sin esperar a que venza su
 * token. Lo escucha `SocketSesionesService`.
 */
export const EVENTO_ACCESO_REVOCADO = 'usuario.acceso-revocado';

export type MotivoAccesoRevocado = 'bloqueo' | 'baja';

export class AccesoRevocadoEvent {
  constructor(
    readonly userId: string,
    readonly motivo: MotivoAccesoRevocado,
  ) {}
}
