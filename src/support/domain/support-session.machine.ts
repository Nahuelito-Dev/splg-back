import {
  SupportEndReason,
  SupportScope,
  SupportSessionKind,
  SupportSessionStatus,
} from './support-session.enums';
import {
  AprobacionExcedeLoPedidoError,
  DuracionInvalidaError,
  SesionNoPendienteError,
  SesionYaTerminadaError,
  SolicitudCaducadaError,
} from './support-session.errors';

/** Duraciones que se pueden pedir y aprobar, en minutos (D2). */
export const DURACIONES_PERMITIDAS: readonly number[] = [15, 30, 60, 120];
/** Tope de una sesión de emergencia, en minutos (D1). */
export const MAXIMO_DE_EMERGENCIA = 60;
/** Cuánto espera una solicitud la respuesta de la empresa antes de caducar. */
export const VIGENCIA_DE_LA_SOLICITUD_MS = 24 * 60 * 60 * 1000;

/** Lo que se le puede hacer a una sesión. */
export enum AccionDeSoporte {
  APROBAR = 'approve',
  RECHAZAR = 'reject',
  RETIRAR = 'cancel',
  CADUCAR = 'expire_request',
  SALIR = 'exit',
  REVOCAR = 'revoke',
  VENCER = 'expire',
}

const S = SupportSessionStatus;
const A = AccionDeSoporte;

/**
 * Las transiciones válidas. Las acciones de una solicitud (aprobar, rechazar,
 * retirar, caducar) sólo valen sobre una pendiente; las de una sesión en curso
 * (salir, revocar, vencer), sólo sobre una activa. Los demás estados son finales.
 */
const TRANSICIONES: Readonly<
  Record<
    SupportSessionStatus,
    Partial<Record<AccionDeSoporte, SupportSessionStatus>>
  >
> = {
  [S.PENDING]: {
    [A.APROBAR]: S.ACTIVE,
    [A.RECHAZAR]: S.REJECTED,
    [A.RETIRAR]: S.CANCELLED,
    [A.CADUCAR]: S.EXPIRED_REQUEST,
  },
  [S.ACTIVE]: {
    [A.SALIR]: S.ENDED,
    [A.REVOCAR]: S.REVOKED,
    [A.VENCER]: S.EXPIRED,
  },
  [S.REJECTED]: {},
  [S.EXPIRED_REQUEST]: {},
  [S.CANCELLED]: {},
  [S.ENDED]: {},
  [S.REVOKED]: {},
  [S.EXPIRED]: {},
};

const ACCIONES_DE_SOLICITUD: ReadonlySet<AccionDeSoporte> = new Set([
  A.APROBAR,
  A.RECHAZAR,
  A.RETIRAR,
  A.CADUCAR,
]);

/** El estado al que lleva la acción, o el error de dominio si no se puede. */
export function siguienteEstado(
  actual: SupportSessionStatus,
  accion: AccionDeSoporte,
): SupportSessionStatus {
  const destino = TRANSICIONES[actual][accion];
  if (destino) return destino;
  throw ACCIONES_DE_SOLICITUD.has(accion)
    ? new SesionNoPendienteError()
    : new SesionYaTerminadaError();
}

/** Si el estado ya no cambia más. */
export function esFinal(estado: SupportSessionStatus): boolean {
  return Object.keys(TRANSICIONES[estado]).length === 0;
}

/** Valida la duración pedida según el tipo de acceso. */
export function validarDuracion(
  minutos: number,
  tipo: SupportSessionKind,
): void {
  if (!DURACIONES_PERMITIDAS.includes(minutos)) {
    throw new DuracionInvalidaError(
      `La duración tiene que ser de ${DURACIONES_PERMITIDAS.join(', ')} minutos`,
    );
  }
  if (tipo === SupportSessionKind.EMERGENCY && minutos > MAXIMO_DE_EMERGENCIA) {
    throw new DuracionInvalidaError(
      `Un acceso de emergencia dura como máximo ${MAXIMO_DE_EMERGENCIA} minutos`,
    );
  }
}

export interface LoPedido {
  minutos: number;
  alcance: readonly SupportScope[];
}

/**
 * Lo que queda aprobado: la empresa puede acortar la duración y achicar el
 * alcance, nunca ampliarlos. Sin valores, se aprueba tal cual se pidió.
 */
export function resolverAprobacion(
  pedido: LoPedido,
  aprobado: { minutos?: number; alcance?: readonly SupportScope[] },
): LoPedido {
  const minutos = aprobado.minutos ?? pedido.minutos;
  if (minutos > pedido.minutos) {
    throw new AprobacionExcedeLoPedidoError(
      `Se pidieron ${pedido.minutos} minutos: se puede aprobar esa duración o una menor`,
    );
  }
  if (!DURACIONES_PERMITIDAS.includes(minutos)) {
    throw new DuracionInvalidaError(
      `La duración tiene que ser de ${DURACIONES_PERMITIDAS.join(', ')} minutos`,
    );
  }
  const alcance = aprobado.alcance ?? pedido.alcance;
  if (alcance.some((a) => !pedido.alcance.includes(a))) {
    throw new AprobacionExcedeLoPedidoError(
      'Sólo se puede aprobar el alcance que se pidió o uno menor',
    );
  }
  return { minutos, alcance: [...new Set(alcance)] };
}

/** Si la solicitud ya pasó su plazo de respuesta. */
export function solicitudCaducada(vence: Date | null, ahora: Date): boolean {
  return vence !== null && vence.getTime() <= ahora.getTime();
}

/** La aprobación de una solicitud: tiene que estar pendiente y en plazo. */
export function assertAprobable(
  estado: SupportSessionStatus,
  vence: Date | null,
  ahora: Date,
): void {
  siguienteEstado(estado, AccionDeSoporte.APROBAR);
  if (solicitudCaducada(vence, ahora)) throw new SolicitudCaducadaError();
}

/** El fin de la sesión desde el inicio y los minutos. */
export function finDeLaSesion(inicio: Date, minutos: number): Date {
  return new Date(inicio.getTime() + minutos * 60_000);
}

/** Por qué termina, según la acción y quién la corta. */
export function motivoDeFin(
  accion:
    | AccionDeSoporte.SALIR
    | AccionDeSoporte.REVOCAR
    | AccionDeSoporte.VENCER,
  quien: 'empresa' | 'plataforma',
): SupportEndReason {
  if (accion === AccionDeSoporte.SALIR) return SupportEndReason.EXIT;
  if (accion === AccionDeSoporte.VENCER) return SupportEndReason.EXPIRED;
  return quien === 'empresa'
    ? SupportEndReason.REVOKED_BY_COMPANY
    : SupportEndReason.REVOKED_BY_PLATFORM;
}
