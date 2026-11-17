/**
 * Cierre por inactividad de la bandeja (C2/C3, tanda 7c, como el cierre
 * automático de Chatwoot). La empresa lo prende con `inactivityCloseMinutes`
 * y, si quiere, un aviso `inactivityWarningMinutes` antes. Sólo cierra cuando
 * la pelota está del lado del cliente o del chofer: el último mensaje que
 * cuenta es del equipo o una respuesta del asistente con IA y pasó el tiempo
 * sin que conteste. Si el último es de la persona (está esperando al equipo),
 * si espera a una persona (el asistente la derivó) o si la última respuesta
 * automática es sólo un aviso (fuera de horario, recibido), nunca. Tampoco
 * fuera del horario de atención de la empresa (lo hace cuando abre), con el
 * módulo `chat` apagado o, con los clientes, con su chat apagado.
 */

export const MINUTOS_DE_INACTIVIDAD_MINIMOS = 30;
export const MINUTOS_DE_INACTIVIDAD_MAXIMOS = 10080;
export const MINUTOS_DE_AVISO_MINIMOS = 5;
export const MINUTOS_DE_AVISO_MAXIMOS = 1440;

export interface PlazosDeInactividad {
  /** `null`: apagado. */
  cerrarMinutos: number | null;
  /** `null`: cierra sin avisar. */
  avisarMinutos: number | null;
  /**
   * Desde cuándo rigen estos plazos (se prendió o se cambió el cierre o el
   * aviso). Nada anterior cuenta: al prenderlo no se cierra el atraso de
   * golpe, y un aviso anterior no vale.
   */
  habilitadoAt?: Date | null;
}

/** El aviso de cierre ya mandado, con el cierre que se le mostró a la persona. */
export interface AvisoDado {
  at: Date;
  cierraAt: Date;
}

/** El último mensaje que cuenta, la última reapertura y el último aviso. */
export interface EstadoDeInactividad {
  /** Quién escribió el último mensaje que cuenta (`null`: ninguno todavía). */
  ultimo: 'person' | 'team' | 'assistant' | null;
  ultimoAt: Date | null;
  /** La última vez que la empresa la reabrió (`reopened`); `null` si nunca. */
  reabiertaAt?: Date | null;
  /** El último aviso de cierre; vale sólo si es del ciclo vigente. */
  aviso: AvisoDado | null;
  /** El asistente la pasó a una persona y nadie la tomó. */
  esperandoPersona: boolean;
}

export type DecisionDeInactividad =
  | { accion: 'nada' }
  | { accion: 'avisar'; minutos: number; cierraAt: Date }
  | { accion: 'cerrar' };

const MINUTO = 60_000;

/** Los plazos son válidos: cierre de 30 min a 7 días y aviso de 5 min a 24 h, antes del cierre. */
export function plazosValidos(
  p: Pick<PlazosDeInactividad, 'cerrarMinutos' | 'avisarMinutos'>,
): boolean {
  if (p.cerrarMinutos === null) return p.avisarMinutos === null;
  if (
    !Number.isInteger(p.cerrarMinutos) ||
    p.cerrarMinutos < MINUTOS_DE_INACTIVIDAD_MINIMOS ||
    p.cerrarMinutos > MINUTOS_DE_INACTIVIDAD_MAXIMOS
  ) {
    return false;
  }
  if (p.avisarMinutos === null) return true;
  return (
    Number.isInteger(p.avisarMinutos) &&
    p.avisarMinutos >= MINUTOS_DE_AVISO_MINIMOS &&
    p.avisarMinutos <= MINUTOS_DE_AVISO_MAXIMOS &&
    p.avisarMinutos < p.cerrarMinutos
  );
}

/**
 * Dónde arranca el ciclo vigente: el último mensaje que cuenta, la última
 * reapertura o desde cuándo rigen los plazos, lo que sea más tarde.
 */
export function inicioDelCiclo(
  e: Pick<EstadoDeInactividad, 'ultimoAt' | 'reabiertaAt'>,
  habilitadoAt: Date | null | undefined,
): Date | null {
  if (e.ultimoAt === null) return null;
  return new Date(
    Math.max(
      e.ultimoAt.getTime(),
      e.reabiertaAt?.getTime() ?? -Infinity,
      habilitadoAt?.getTime() ?? -Infinity,
    ),
  );
}

/**
 * Qué hacer con una conversación abierta ahora (dentro del horario de
 * atención: fuera de él no se avisa ni se cierra, lo decide quien llama).
 * El ciclo arranca en `inicioDelCiclo`; un aviso vale sólo si es de ese
 * ciclo (si no, se vuelve a avisar). Sin aviso configurado: cierra al pasar
 * `cerrarMinutos`. Con aviso: avisa a los `cerrarMinutos − avisarMinutos`
 * («cerramos en N min») y cierra cuando pasó el plazo. Nunca antes del
 * cierre que se le mostró a la persona en el aviso.
 */
export function decidirInactividad(
  e: EstadoDeInactividad,
  p: PlazosDeInactividad,
  ahora: Date,
): DecisionDeInactividad {
  if (p.cerrarMinutos === null || e.esperandoPersona) return { accion: 'nada' };
  if (e.ultimo === null || e.ultimo === 'person') return { accion: 'nada' };
  const inicio = inicioDelCiclo(e, p.habilitadoAt);
  if (inicio === null) return { accion: 'nada' };
  const cierre = inicio.getTime() + p.cerrarMinutos * MINUTO;
  const t = ahora.getTime();
  const aviso =
    e.aviso && e.aviso.at.getTime() >= inicio.getTime() ? e.aviso : null;
  const prometido = aviso ? aviso.cierraAt.getTime() : -Infinity;
  if (p.avisarMinutos === null || aviso) {
    return t >= Math.max(cierre, prometido)
      ? { accion: 'cerrar' }
      : { accion: 'nada' };
  }
  return t >= cierre - p.avisarMinutos * MINUTO
    ? {
        accion: 'avisar',
        minutos: p.avisarMinutos,
        cierraAt: new Date(Math.max(cierre, t + p.avisarMinutos * MINUTO)),
      }
    : { accion: 'nada' };
}

/** «Si no tenés más consultas, cerramos la conversación en 15 min.» */
export function textoDelAviso(minutos: number): string {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  const plazo = h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
  return `Si no tenés más consultas, cerramos la conversación en ${plazo}.`;
}
