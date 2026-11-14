/**
 * Confirmación automática de la hoja de ruta: cuándo vence la ventana de
 * revisión de un borrador.
 *
 * La ventana corre desde la propuesta del día (`route_plan.proposed_at`): el
 * borrador que el sistema propuso y el que el admin armó o editó después se
 * confirman solos pasados `reviewMinutes` desde la propuesta (lo que el admin
 * dejó armado vale). La excepción es la hoja que el admin **reabrió** (ya tenía
 * número de una confirmación anterior): la volvió a borrador para corregirla,
 * así que la ventana corre desde su última edición (la reapertura cuenta como
 * edición). Sin eso, una hoja reabierta pasada la ventana se volvería a
 * confirmar en la pasada siguiente, antes de que el admin la tocara.
 */
export interface BorradorEnRevision {
  /** Cuándo se propuso el día. */
  proposedAtMs: number;
  /** Última edición del admin (la reapertura también la marca). */
  editedAtMs: number | null;
  /** Ya se había confirmado alguna vez (tiene número) y el admin la reabrió. */
  reabierta: boolean;
}

export function revisionVencida(
  b: BorradorEnRevision,
  reviewMinutes: number,
  nowMs: number,
): boolean {
  const desde =
    b.reabierta && b.editedAtMs !== null
      ? Math.max(b.proposedAtMs, b.editedAtMs)
      : b.proposedAtMs;
  return nowMs >= desde + reviewMinutes * 60_000;
}
