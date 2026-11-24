/**
 * Reglas de la nueva visita cuando no se pudo entregar (C5). Dominio puro:
 * sin Nest ni TypeORM. Fechas `AAAA-MM-DD` del día argentino.
 */

/** Por qué no se pudo entregar (lo elige el chofer). */
export enum FailedVisitReason {
  CUSTOMER_ABSENT = 'customer_absent',
  ADDRESS_CLOSED = 'address_closed',
  REJECTED = 'rejected',
  OTHER = 'other',
}

export const ETIQUETA_DE_VISITA_FALLIDA: Record<FailedVisitReason, string> = {
  [FailedVisitReason.CUSTOMER_ABSENT]: 'El cliente no estaba',
  [FailedVisitReason.ADDRESS_CLOSED]: 'El domicilio estaba cerrado',
  [FailedVisitReason.REJECTED]: 'El cliente rechazó el pedido',
  [FailedVisitReason.OTHER]: 'Otro motivo',
};

/** De qué circuito venía la entrega. */
export enum DeliveryKind {
  /** Pedido suelto del despacho (M1). */
  SINGLE = 'single',
  EXPRESS = 'express',
  /** Parada de una hoja de ruta (M4). */
  ROUTE_SHEET = 'route_sheet',
}

/** En qué quedó la visita fallida. */
export enum FailedVisitOutcome {
  /** Hoja de ruta, primer intento: la parada pasó al final del recorrido de hoy. */
  REQUEUED = 'requeued',
  /** El sistema propuso día y franja: el cliente puede aceptar o elegir otro. */
  PROPOSED = 'proposed',
  /** El chofer acordó día y franja con el cliente. */
  AGREED = 'agreed',
  /** Llegó al tope de visitas fallidas, o no hay día posible: decide el admin. */
  AWAITING_ADMIN = 'awaiting_admin',
}

/** Estado de la nueva visita del pedido (`order.revisit_status`). */
export enum RevisitStatus {
  /** Propuesta del sistema: si el cliente no contesta, queda. */
  PROPOSED = 'proposed',
  /** Confirmada: el cliente la aceptó o eligió otra, la acordó el chofer o la fijó el admin. */
  CONFIRMED = 'confirmed',
  /** El sistema dejó de reprogramar: decide el admin. */
  AWAITING_ADMIN = 'awaiting_admin',
}

/** Cómo se resolvió la propuesta de una visita fallida. */
export enum RevisitResolution {
  CUSTOMER_ACCEPTED = 'customer_accepted',
  CUSTOMER_CHANGED = 'customer_changed',
  ADMIN_SET = 'admin_set',
}

/** Decisión de nahue (18/11): a la segunda visita fallida decide el admin. */
export const MAX_VISITAS_FALLIDAS = 2;

/** Hasta cuántos días hacia adelante se busca (y se deja elegir) una nueva visita. */
export const HORIZONTE_DE_NUEVA_VISITA = 14;

/** Con esta visita fallida (la número `visitasFallidas`), ¿deja de reprogramar el sistema? */
export function decideElAdmin(visitasFallidas: number): boolean {
  return visitasFallidas >= MAX_VISITAS_FALLIDAS;
}

/** Una franja con sus cupos libres en un día (0 si ya terminó o está completa). */
export interface FranjaDelDia {
  timeSlotId: string;
  name: string;
  startTime: string;
  endTime: string;
  remaining: number;
}

/**
 * La franja de la nueva visita en un día: la del pedido original si tiene
 * cupo; si no, la primera con cupo (vienen ordenadas por hora de inicio).
 * `null` si ese día no queda ninguna.
 */
export function elegirFranja(
  franjas: readonly FranjaDelDia[],
  franjaOriginalId: string | null,
): FranjaDelDia | null {
  const libres = franjas.filter((f) => f.remaining > 0);
  return (
    libres.find((f) => f.timeSlotId === franjaOriginalId) ?? libres[0] ?? null
  );
}

/**
 * Los días candidatos de la nueva visita, en orden:
 *  - pedido suelto: los días hábiles DESPUÉS de hoy;
 *  - express: hoy (lo antes posible) si es hábil, y después los días hábiles
 *    siguientes (que hoy quede una franja vigente lo decide la propuesta).
 * La hoja de ruta no pasa por acá: su día lo pone la reprogramación de la hoja.
 */
export function diasCandidatos(
  tipo: DeliveryKind.SINGLE | DeliveryKind.EXPRESS,
  hoy: string,
  esHabil: (fecha: string) => boolean,
  sumarDias: (fecha: string, dias: number) => string,
  horizonte: number = HORIZONTE_DE_NUEVA_VISITA,
): string[] {
  const dias: string[] =
    tipo === DeliveryKind.EXPRESS && esHabil(hoy) ? [hoy] : [];
  for (let i = 1; i <= horizonte; i++) {
    const dia = sumarDias(hoy, i);
    if (esHabil(dia)) dias.push(dia);
  }
  return dias;
}

/** El día y la franja propuestos (la franja puede faltar si la distribuidora no tiene). */
export interface NuevaVisitaPropuesta {
  date: string;
  timeSlotId: string | null;
}

/**
 * Propone la nueva visita recorriendo los días candidatos: el primero con una
 * franja con cupo. El express prefiere la primera franja libre («lo antes
 * posible»); el suelto, la franja del pedido original. Si la distribuidora no
 * tiene franjas activas, el primer día candidato sin franja. `null` si no hay
 * lugar en el horizonte.
 */
export async function proponerNuevaVisita(
  tipo: DeliveryKind.SINGLE | DeliveryKind.EXPRESS,
  dias: readonly string[],
  franjaOriginalId: string | null,
  franjasDe: (fecha: string) => Promise<readonly FranjaDelDia[]>,
): Promise<NuevaVisitaPropuesta | null> {
  for (const dia of dias) {
    const franjas = await franjasDe(dia);
    if (franjas.length === 0) return { date: dia, timeSlotId: null };
    const franja = elegirFranja(
      franjas,
      tipo === DeliveryKind.EXPRESS ? null : franjaOriginalId,
    );
    if (franja) return { date: dia, timeSlotId: franja.timeSlotId };
  }
  return null;
}

/** Lo que hace falta del pedido para saber si el cliente todavía puede contestar. */
export interface PedidoConNuevaVisita {
  status: string;
  deliveryId: string | null;
  revisitStatus: string | null;
}

/** El cliente contesta («Me sirve» / elegir otro) sólo mientras es una propuesta sin chofer. */
export function puedeResponderElCliente(p: PedidoConNuevaVisita): boolean {
  return (
    p.status === 'pending' &&
    !p.deliveryId &&
    p.revisitStatus === RevisitStatus.PROPOSED
  );
}

/** El admin fija día y franja mientras el pedido siga pendiente y sin chofer con una visita fallida. */
export function puedeFijarElAdmin(p: PedidoConNuevaVisita): boolean {
  return p.status === 'pending' && !p.deliveryId && p.revisitStatus !== null;
}
