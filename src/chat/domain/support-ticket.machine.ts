import { Party, TicketPriority, TicketStatus } from './chat.enums';
import {
  TicketCerradoError,
  TicketNoResueltoError,
  TransicionDeTicketInvalidaError,
} from './chat.errors';

const S = TicketStatus;

/**
 * Máquina del ticket (diseño §4.2.2). Una copia congelada vive en la base
 * (`sql/mensajeria.ts`, trigger `BEFORE UPDATE`); `support-ticket.machine.spec`
 * verifica que coinciden.
 *
 * - `new → open`: la plataforma lo toma (se asigna).
 * - `new → waiting_company`: la plataforma responde sin haberlo tomado antes
 *   (responder es atenderlo; el diagrama lo muestra como dos pasos).
 * - `open → waiting_company`: responde la plataforma.
 * - `waiting_company → open`: responde la empresa.
 * - `open | waiting_company → resolved`: lo resuelve la plataforma.
 * - `waiting_company → closed`: 7 días sin respuesta de la empresa.
 * - `resolved → open`: la empresa responde antes de que se cierre.
 * - `resolved → closed`: 7 días, o la empresa confirma.
 */
export const TRANSICIONES_DEL_TICKET: Readonly<
  Record<TicketStatus, readonly TicketStatus[]>
> = {
  [S.NEW]: [S.OPEN, S.WAITING_COMPANY],
  [S.OPEN]: [S.WAITING_COMPANY, S.RESOLVED],
  [S.WAITING_COMPANY]: [S.OPEN, S.RESOLVED, S.CLOSED],
  [S.RESOLVED]: [S.OPEN, S.CLOSED],
  [S.CLOSED]: [],
};

/** Cómo se nombra cada estado en un mensaje para la persona. */
export const ETIQUETA_DEL_ESTADO_DEL_TICKET: Readonly<
  Record<TicketStatus, string>
> = {
  [S.NEW]: 'nuevo',
  [S.OPEN]: 'en curso',
  [S.WAITING_COMPANY]: 'esperando a la empresa',
  [S.RESOLVED]: 'resuelto',
  [S.CLOSED]: 'cerrado',
};

export function puedePasar(de: TicketStatus, a: TicketStatus): boolean {
  return TRANSICIONES_DEL_TICKET[de].includes(a);
}

/** Valida un cambio pedido a mano (el `PATCH` de la plataforma). Repetir el estado no es un cambio. */
export function assertTransicion(de: TicketStatus, a: TicketStatus): void {
  if (de === a) return;
  if (!puedePasar(de, a)) {
    throw new TransicionDeTicketInvalidaError(
      ETIQUETA_DEL_ESTADO_DEL_TICKET[de],
      ETIQUETA_DEL_ESTADO_DEL_TICKET[a],
    );
  }
}

/** El hilo de un ticket cerrado ya no admite mensajes ni citas. */
export function assertAbierto(estado: TicketStatus): void {
  if (estado === S.CLOSED) throw new TicketCerradoError();
}

/** El estado inicial: la empresa lo deja nuevo; la plataforma, esperando a la empresa. */
export function estadoInicial(
  abre: Party.COMPANY | Party.PLATFORM,
): TicketStatus {
  return abre === Party.COMPANY ? S.NEW : S.WAITING_COMPANY;
}

/**
 * A qué estado lleva un mensaje público en el hilo, o `null` si no lo cambia.
 * Las notas internas no cuentan como respuesta.
 */
export function estadoTrasResponder(
  actual: TicketStatus,
  quien: Party.COMPANY | Party.PLATFORM,
): TicketStatus | null {
  assertAbierto(actual);
  if (quien === Party.COMPANY) {
    return actual === S.WAITING_COMPANY || actual === S.RESOLVED
      ? S.OPEN
      : null;
  }
  return actual === S.NEW || actual === S.OPEN ? S.WAITING_COMPANY : null;
}

/** Tomarlo (asignarlo) saca a un ticket nuevo de la cola. */
export function estadoTrasAsignar(actual: TicketStatus): TicketStatus | null {
  return actual === S.NEW ? S.OPEN : null;
}

/** La empresa confirma un resuelto: se cierra. */
export function estadoTrasConfirmar(actual: TicketStatus): TicketStatus {
  if (actual !== S.RESOLVED) throw new TicketNoResueltoError();
  return S.CLOSED;
}

/** Plazos del cierre automático (configurables por la plataforma). */
export interface PlazosDelTicket {
  /** Días esperando a la empresa antes de cerrarlo (7). */
  waitingCloseDays: number;
  /** Días esperando a la empresa para avisarle (5). */
  waitingWarnDays: number;
  /** Días resuelto antes de cerrarlo (7). */
  resolvedCloseDays: number;
}

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Qué hace el proceso automático con un ticket: cerrarlo, avisarle a la
 * empresa o nada. Cuenta desde el último cambio de estado.
 */
export function vencimientoDelTicket(
  estado: TicketStatus,
  desde: Date,
  ahora: Date,
  plazos: PlazosDelTicket,
): 'close' | 'warn' | null {
  const dias = (ahora.getTime() - desde.getTime()) / DIA_MS;
  if (estado === S.RESOLVED) {
    return dias >= plazos.resolvedCloseDays ? 'close' : null;
  }
  if (estado === S.WAITING_COMPANY) {
    if (dias >= plazos.waitingCloseDays) return 'close';
    if (dias >= plazos.waitingWarnDays) return 'warn';
  }
  return null;
}

/** Objetivo de primera respuesta por prioridad, en minutos. */
export type ObjetivosDeRespuesta = Readonly<Record<TicketPriority, number>>;

export const OBJETIVOS_POR_DEFECTO: ObjetivosDeRespuesta = {
  [TicketPriority.URGENT]: 60,
  [TicketPriority.HIGH]: 4 * 60,
  [TicketPriority.NORMAL]: 24 * 60,
  [TicketPriority.LOW]: 3 * 24 * 60,
};

/** Cuándo vence la primera respuesta, desde que se abrió (reloj corrido). */
export function venceLaPrimeraRespuesta(
  abierto: Date,
  prioridad: TicketPriority,
  objetivos: ObjetivosDeRespuesta,
): Date {
  return new Date(abierto.getTime() + objetivos[prioridad] * 60_000);
}

/** El número que ve la persona: `T-000123`. */
export function numeroDeTicket(numero: number): string {
  return `T-${String(numero).padStart(6, '0')}`;
}
