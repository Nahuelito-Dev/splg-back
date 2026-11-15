import type { SelectQueryBuilder } from 'typeorm';
import type { Conversation } from '../entities/conversation.entity';

/**
 * La cola de las que esperan a una persona (el asistente con IA las derivó,
 * `awaiting_human_since`), para la bandeja de la empresa y los chats de la
 * plataforma. El alias de la conversación en la consulta es `c`.
 */

/** `awaiting=true`: sólo las que esperan; `false`: sólo las que no; sin él, todas. */
export function filtrarPorEspera(
  qb: SelectQueryBuilder<Conversation>,
  awaiting: boolean | undefined,
): void {
  if (awaiting === true) qb.andWhere('c.awaitingHumanSince IS NOT NULL');
  if (awaiting === false) qb.andWhere('c.awaitingHumanSince IS NULL');
}

/**
 * En «sin asignar», primero las que esperan a una persona, la que espera hace
 * más primero; después, el orden de siempre (que agrega quien llama con
 * `addOrderBy`).
 */
export function primeroLasQueEsperan(
  qb: SelectQueryBuilder<Conversation>,
  sinAsignar: boolean,
): void {
  if (sinAsignar) qb.orderBy('c.awaitingHumanSince', 'ASC', 'NULLS LAST');
}
