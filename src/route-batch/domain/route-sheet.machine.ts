import { derivarTransiciones } from '../../common/domain/derivar-transiciones';
import { RouteBatchKind, RouteBatchStatus } from './route-batch.enums';
import { InvalidRouteBatchTransitionError } from './errors/route-sheet.errors';

type Tabla = Readonly<Record<RouteBatchStatus, readonly RouteBatchStatus[]>>;

const S = RouteBatchStatus;

/**
 * Máquina de la modalidad `offer` (agrupación dinámica de M4): se forma, se
 * ofrece a un chofer, lo acepta (queda asignado) y se completa; en cualquier
 * punto antes de aceptarse puede deshacerse.
 */
export const OFFER_TRANSITIONS: Tabla = derivarTransiciones(
  Object.values(S),
  (desde) => {
    switch (desde) {
      case S.FORMING:
        return [S.OFFERED, S.DISSOLVED];
      case S.OFFERED:
        return [S.ASSIGNED, S.DISSOLVED];
      case S.ASSIGNED:
        return [S.COMPLETED];
      default:
        return [];
    }
  },
);

/**
 * Máquina de la modalidad `planned` (hoja de ruta): borrador → confirmada (el
 * administrador) → en curso (`assigned`, al iniciarla el chofer) → cerrada. Una
 * confirmada que no se inició vuelve a borrador; borrador y confirmada pueden
 * cancelarse. Una hoja en curso ya no se cancela: se cierra.
 */
export const PLANNED_TRANSITIONS: Tabla = derivarTransiciones(
  Object.values(S),
  (desde) => {
    switch (desde) {
      case S.DRAFT:
        return [S.CONFIRMED, S.DISSOLVED];
      case S.CONFIRMED:
        return [S.DRAFT, S.ASSIGNED, S.DISSOLVED];
      case S.ASSIGNED:
        return [S.COMPLETED];
      default:
        return [];
    }
  },
);

export const TRANSITIONS_BY_KIND: Readonly<Record<RouteBatchKind, Tabla>> = {
  [RouteBatchKind.OFFER]: OFFER_TRANSITIONS,
  [RouteBatchKind.PLANNED]: PLANNED_TRANSITIONS,
};

export function canTransition(
  kind: RouteBatchKind,
  from: RouteBatchStatus,
  to: RouteBatchStatus,
): boolean {
  if (from === to) return true; // re-aplicar el mismo estado es no-op
  return TRANSITIONS_BY_KIND[kind][from].includes(to);
}

/** Como `canTransition`, pero lanza un error de dominio (409) si no se puede. */
export function assertTransition(
  kind: RouteBatchKind,
  from: RouteBatchStatus,
  to: RouteBatchStatus,
): void {
  if (!canTransition(kind, from, to)) {
    throw new InvalidRouteBatchTransitionError(kind, from, to);
  }
}

/** Estados en los que la hoja todavía retiene sus pedidos (aún no se asignaron). */
export const PLANNED_HOLDING_STATUSES: readonly RouteBatchStatus[] = [
  S.DRAFT,
  S.CONFIRMED,
];
