import { diasEntre } from './dia-calendario';

/**
 * Vigencia de un envase (dominio puro): decide si puede circular a partir de su
 * fecha de vencimiento. Es el único cálculo: lo comparten la consulta de un
 * envase, el listado de próximos a vencer y el bloqueo del despacho.
 */
export enum EstadoDeVigencia {
  /** Tiene vencimiento y no pasó. */
  VIGENTE = 'valid',
  /** El vencimiento ya pasó: no se puede despachar. */
  VENCIDO = 'expired',
  /** Sin vencimiento cargado: puede estar en regla y sin el dato. No bloquea. */
  SIN_ACREDITAR = 'unverified',
}

/**
 * Valores del filtro `vigencia` del listado: los tres estados más
 * `dispatchable` (vigentes y sin revisión registrada: los que se pueden
 * asignar a un pedido).
 */
export type FiltroDeVigencia = EstadoDeVigencia | 'dispatchable';
export const FILTROS_DE_VIGENCIA: FiltroDeVigencia[] = [
  ...Object.values(EstadoDeVigencia),
  'dispatchable',
];

export interface Vigencia {
  estado: EstadoDeVigencia;
  /** Días calendario que faltan (0 = vence hoy; negativo si ya venció). `null` sin vencimiento cargado. */
  diasRestantes: number | null;
}

export function calcularVigencia(
  expiresAt: Date | null,
  ahora: Date = new Date(),
): Vigencia {
  if (!expiresAt) {
    return { estado: EstadoDeVigencia.SIN_ACREDITAR, diasRestantes: null };
  }
  return {
    estado:
      expiresAt.getTime() <= ahora.getTime()
        ? EstadoDeVigencia.VENCIDO
        : EstadoDeVigencia.VIGENTE,
    // Días calendario argentinos: el que vence hoy "vence hoy" hasta las 23:59.
    diasRestantes: diasEntre(ahora, expiresAt),
  };
}

/** Sólo el envase con vencimiento cumplido se bloquea; el sin fecha pasa. */
export function estaVencido(
  expiresAt: Date | null,
  ahora: Date = new Date(),
): boolean {
  return calcularVigencia(expiresAt, ahora).estado === EstadoDeVigencia.VENCIDO;
}
