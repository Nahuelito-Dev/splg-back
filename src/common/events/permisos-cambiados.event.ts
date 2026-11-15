/**
 * Cambiaron los permisos del panel de uno o más usuarios (se les asignó otro
 * rol, se editó o se dio de baja su rol). Las conexiones de tiempo real ya
 * abiertas vuelven a evaluar sus salas: quien perdió `soporte.ver` deja de
 * recibir el chat y los tickets al instante. Lo escucha `AdminGateway`.
 */
export const EVENTO_PERMISOS_CAMBIADOS = 'usuario.permisos-cambiados';

export class PermisosCambiadosEvent {
  constructor(readonly userIds: readonly string[]) {}
}
