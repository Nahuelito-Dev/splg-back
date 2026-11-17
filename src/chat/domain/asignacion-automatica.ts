import type { CanalDeLaBandeja } from './bandeja';

/**
 * Asignación automática de la bandeja de la empresa (tanda 8b, punto 13 del
 * relevamiento). Reglas puras: sin base ni Nest.
 *
 * Cada persona del equipo se marca «en línea» o «ausente», tiene un tope de
 * conversaciones abiertas (el de la empresa o uno propio) y la conversación
 * que queda esperando a una persona se le da a la que tiene más lugar libre.
 */

/** Lo que elige cada persona del equipo: en línea (recibe conversaciones) o ausente. */
export const ESTADOS_DEL_AGENTE = ['online', 'away'] as const;
export type EstadoDelAgente = (typeof ESTADOS_DEL_AGENTE)[number];

/** Por omisión, quien nunca eligió está ausente: no recibe nada sin marcarse en línea. */
export const ESTADO_POR_OMISION: EstadoDelAgente = 'away';

/** El tope de conversaciones abiertas (de la empresa y el propio): de 1 a 50. */
export const TOPE_MINIMO = 1;
export const TOPE_MAXIMO = 50;
/** El tope de la empresa cuando no lo eligió. */
export const TOPE_POR_OMISION = 5;

/**
 * Cuánto sigue contando una persona «en línea» que se desconectó del panel
 * (recarga la página, se le corta la red): pasado este plazo deja de
 * recibir conversaciones, pero su estado elegido se conserva.
 */
export const GRACIA_DE_DESCONEXION_MS = 2 * 60_000;

/** El tope que rige para una persona: el suyo o, si no tiene, el de la empresa. */
export function topeDe(propio: number | null, deLaEmpresa: number): number {
  return propio ?? deLaEmpresa;
}

/** Lo que hace falta para saber si alguien puede recibir conversaciones ahora. */
export interface Presencia {
  estado: EstadoDelAgente;
  /** Tiene el panel abierto ahora. */
  conectado: boolean;
  /** La última vez que se lo vio conectado (ms); `null` si nunca. */
  vistoEn: number | null;
  /** La empresa atiende ahora según su horario de atención. */
  enHorario: boolean;
}

/**
 * Disponible para recibir conversaciones: «en línea», con el panel abierto
 * (o desconectado hace menos de {@link GRACIA_DE_DESCONEXION_MS}) y dentro
 * del horario de atención de la empresa.
 */
export function estaDisponible(p: Presencia, ahora: number): boolean {
  if (p.estado !== 'online' || !p.enHorario) return false;
  if (p.conectado) return true;
  return p.vistoEn !== null && ahora - p.vistoEn <= GRACIA_DE_DESCONEXION_MS;
}

/** Una persona del equipo, como la ve el reparto. */
export interface Candidato {
  userId: string;
  /** Los canales que atiende (permiso de cada canal). */
  canales: readonly CanalDeLaBandeja[];
  disponible: boolean;
  /** El tope que le rige ({@link topeDe}). */
  tope: number;
  /** Las conversaciones abiertas asignadas a esa persona, de los dos canales. */
  abiertas: number;
  /** La última vez que recibió una (ms); `null` si nunca. */
  ultimaAsignacion: number | null;
}

/** Lugar libre de una persona: cuántas más puede recibir antes del tope. */
export const lugarLibre = (c: Candidato): number => c.tope - c.abiertas;

/**
 * A quién darle una conversación de ese canal, o `null` si nadie puede:
 * entre los que atienden el canal, están disponibles y no llegaron al tope,
 * el que tiene más lugar libre; si empatan, el que hace más que no recibe
 * una (nunca primero); si siguen empatados, por id (para que sea estable).
 */
export function elegir(
  candidatos: readonly Candidato[],
  canal: CanalDeLaBandeja,
): Candidato | null {
  let mejor: Candidato | null = null;
  for (const c of candidatos) {
    if (!c.canales.includes(canal) || !c.disponible || lugarLibre(c) <= 0) {
      continue;
    }
    if (mejor === null || antes(c, mejor)) mejor = c;
  }
  return mejor;
}

function antes(a: Candidato, b: Candidato): boolean {
  if (lugarLibre(a) !== lugarLibre(b)) return lugarLibre(a) > lugarLibre(b);
  if (a.ultimaAsignacion !== b.ultimaAsignacion) {
    if (a.ultimaAsignacion === null) return true;
    if (b.ultimaAsignacion === null) return false;
    return a.ultimaAsignacion < b.ultimaAsignacion;
  }
  return a.userId < b.userId;
}

/** Una conversación de la cola: esperando a una persona y sin asignar. */
export interface EnLaCola {
  conversationId: string;
  canal: CanalDeLaBandeja;
  /**
   * La última persona del equipo que le respondió (sin tenerla asignada): si
   * está disponible, atiende el canal y tiene lugar, se la queda ella, así
   * no se la sacan a quien ya está respondiendo. Si no, reparto normal.
   */
  preferido?: string | null;
}

/** El preferido, si puede recibirla (canal, disponible y con lugar); si no, `null`. */
export function preferidoConLugar(
  candidatos: readonly Candidato[],
  conversacion: EnLaCola,
): Candidato | null {
  if (!conversacion.preferido) return null;
  const c = candidatos.find((x) => x.userId === conversacion.preferido);
  return c &&
    c.canales.includes(conversacion.canal) &&
    c.disponible &&
    lugarLibre(c) > 0
    ? c
    : null;
}

/**
 * Cuántas conversaciones de cada canal se pueden dar en esta vuelta: el
 * lugar libre de los disponibles que atienden ese canal. La cola no toma
 * (ni bloquea) más que eso.
 */
export function lugarPorCanal(
  candidatos: readonly Candidato[],
): Map<CanalDeLaBandeja, number> {
  const r = new Map<CanalDeLaBandeja, number>();
  for (const c of candidatos) {
    if (!c.disponible) continue;
    const libre = Math.max(0, lugarLibre(c));
    for (const canal of c.canales) r.set(canal, (r.get(canal) ?? 0) + libre);
  }
  return r;
}

export interface Asignacion {
  conversationId: string;
  userId: string;
}

/**
 * Reparte la cola (que llega de la más vieja a la más nueva) entre los
 * candidatos: a cada una, su preferido si puede ({@link preferidoConLugar})
 * o el elegido según {@link elegir}, contando las que
 * ya se le dieron en esta misma vuelta (así nadie pasa su tope). La que no
 * tiene a quién queda en la cola. No modifica lo que recibe.
 */
export function repartir(
  cola: readonly EnLaCola[],
  candidatos: readonly Candidato[],
  ahora: number,
): Asignacion[] {
  const carga = candidatos.map((c) => ({ ...c }));
  const asignaciones: Asignacion[] = [];
  for (const conversacion of cola) {
    const elegido =
      preferidoConLugar(carga, conversacion) ??
      elegir(carga, conversacion.canal);
    if (!elegido) continue;
    elegido.abiertas += 1;
    elegido.ultimaAsignacion = ahora;
    asignaciones.push({
      conversationId: conversacion.conversationId,
      userId: elegido.userId,
    });
  }
  return asignaciones;
}
