import { MencionNoPermitidaError } from './chat.errors';

/**
 * Notas internas de la bandeja con @menciones (4a). Puras: sin base ni Nest.
 *
 * Una nota la escribe el personal en una conversación con un cliente (C3) o
 * con un chofer (C2); la ve sólo el personal de esa empresa. Puede mencionar
 * a alguien del personal que atienda ese canal (la misma regla que
 * `assignees`): esa persona recibe un aviso y la nota aparece en «Me
 * mencionaron» hasta que la marca leída.
 */

/** Personas que se pueden mencionar en una nota. */
export const TOPE_DE_MENCIONES = 10;

/**
 * 400 si alguna mención no es de alguien que atiende el canal (de otra
 * empresa, dado de baja, bloqueado o sin el permiso del canal): no se le dice
 * cuál, para no confirmar quién existe.
 */
export function assertMencionables(
  menciones: readonly string[],
  quienesAtienden: ReadonlySet<string>,
): void {
  if (menciones.some((id) => !quienesAtienden.has(id))) {
    throw new MencionNoPermitidaError();
  }
}

/** A quiénes se avisa: los mencionados, sin quien escribió la nota. */
export function aQuienesAvisar(
  menciones: readonly string[],
  autorId: string,
): string[] {
  return [...new Set(menciones)].filter((id) => id !== autorId);
}

/** El texto del aviso al mencionado: el comienzo de la nota, en una línea. */
export function textoDelAvisoDeMencion(nota: string, largo = 140): string {
  const plano = nota.replace(/\s+/g, ' ').trim();
  return plano.length > largo ? `${plano.slice(0, largo - 1)}…` : plano;
}
