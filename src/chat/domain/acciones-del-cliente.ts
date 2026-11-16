import { AccionNoDisponibleError, AccionSoloDeLaAppError } from './chat.errors';

/**
 * Botones de acción para el cliente en el chat (4e). Puras: sin base ni Nest.
 *
 * - `message`: la app manda con un toque un mensaje predefinido (lo atiende
 *   el asistente o el equipo como cualquier mensaje).
 * - `handoff`: manda el mensaje y la conversación pasa directo a «esperando
 *   persona» (el asistente no contesta).
 * - `app`: la abre la app (repetir el último pedido arma el pedido en su
 *   pantalla); el chat no crea pedidos, así que el back no la ejecuta.
 */
export type TipoDeAccion = 'message' | 'handoff' | 'app';

export interface AccionDelCliente {
  key: ClaveDeAccion;
  label: string;
  kind: TipoDeAccion;
  /** El mensaje que manda (salvo las de la app). */
  text: string | null;
}

export const CLAVES_DE_ACCION = [
  'where_is_my_order',
  'repeat_last_order',
  'payment_methods',
  'talk_to_person',
] as const;

export type ClaveDeAccion = (typeof CLAVES_DE_ACCION)[number];

/** El catálogo, en el orden en que se muestran. */
export const ACCIONES_DEL_CLIENTE: Readonly<
  Record<ClaveDeAccion, AccionDelCliente>
> = {
  where_is_my_order: {
    key: 'where_is_my_order',
    label: '¿Dónde está mi pedido?',
    kind: 'message',
    text: '¿Dónde está mi pedido?',
  },
  repeat_last_order: {
    key: 'repeat_last_order',
    label: 'Repetir mi último pedido',
    kind: 'app',
    text: null,
  },
  payment_methods: {
    key: 'payment_methods',
    label: 'Medios de pago',
    kind: 'message',
    text: '¿Qué medios de pago aceptan?',
  },
  talk_to_person: {
    key: 'talk_to_person',
    label: 'Hablar con una persona',
    kind: 'handoff',
    text: 'Quiero hablar con una persona.',
  },
};

/** Por omisión, todas (la empresa elige cuáles se muestran). */
export const ACCIONES_POR_DEFECTO: readonly ClaveDeAccion[] = [
  ...CLAVES_DE_ACCION,
];

/** Las que muestra la empresa, en el orden del catálogo (las desconocidas se ignoran). */
export function accionesHabilitadas(
  claves: readonly string[],
): AccionDelCliente[] {
  return CLAVES_DE_ACCION.filter((k) => claves.includes(k)).map(
    (k) => ACCIONES_DEL_CLIENTE[k],
  );
}

/**
 * La acción que el cliente tocó, si se puede mandar por el chat: 400 si la
 * empresa no la muestra o si es de la app.
 */
export function accionParaMandar(
  key: ClaveDeAccion,
  habilitadas: readonly string[],
): AccionDelCliente & { text: string } {
  if (!habilitadas.includes(key)) throw new AccionNoDisponibleError();
  const accion = ACCIONES_DEL_CLIENTE[key];
  if (accion.kind === 'app' || accion.text === null) {
    throw new AccionSoloDeLaAppError();
  }
  return { ...accion, text: accion.text };
}
