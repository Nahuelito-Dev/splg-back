import { EntityManager } from 'typeorm';
import { SupportEndReason } from '../domain/support-session.enums';
import {
  AccionDeSoporte,
  siguienteEstado,
} from '../domain/support-session.machine';
import { SupportSession } from '../entities/support-session.entity';

/**
 * Carga la sesión con bloqueo de fila (`FOR UPDATE`), dentro de la transacción
 * de quien la va a cambiar: dos decisiones simultáneas (aprobar y revocar, dos
 * admins aprobando) se ordenan y la segunda ve el estado que dejó la primera.
 */
export async function bloquearSesion(
  manager: EntityManager,
  id: string,
  distributorId?: string,
): Promise<SupportSession | null> {
  return manager.getRepository(SupportSession).findOne({
    where: distributorId
      ? { supportSessionId: id, distributorId }
      : { supportSessionId: id },
    lock: { mode: 'pessimistic_write' },
  });
}

/**
 * Lleva la sesión al estado de la acción (o lanza el error de dominio si la
 * máquina no lo permite) y guarda. Es el único camino para cambiar el estado:
 * ningún servicio escribe `status` a mano.
 */
export async function transicionar(
  manager: EntityManager,
  sesion: SupportSession,
  accion: AccionDeSoporte,
  cambios: Partial<SupportSession> = {},
): Promise<SupportSession> {
  sesion.status = siguienteEstado(sesion.status, accion);
  Object.assign(sesion, cambios);
  return manager.getRepository(SupportSession).save(sesion);
}

/** Los campos del cierre de una sesión activa. */
export function cierre(
  motivo: SupportEndReason,
  quien: string | null,
  cuando: Date,
): Partial<SupportSession> {
  return { endedAt: cuando, endedBy: quien, endReason: motivo };
}
