import { DispatchOfferStatus } from '../entities/dispatch-offer.entity';
import { derivarTransiciones } from '../../common/domain/derivar-transiciones';

/** Estado de una oferta viva: la única desde la que se cierra (aceptar, rechazar, vencer, reemplazar). */
export const ESTADO_ABIERTO = DispatchOfferStatus.OFFERED;

/** Cómo se cierra una oferta abierta. */
const CIERRES = [
  DispatchOfferStatus.ACCEPTED,
  DispatchOfferStatus.REJECTED,
  DispatchOfferStatus.EXPIRED,
  DispatchOfferStatus.SUPERSEDED,
] as const;

/** El chofer que sostenía el pedido lo soltó: aceptada → rechazada. */
const LIBERACION = {
  desde: DispatchOfferStatus.ACCEPTED,
  hacia: DispatchOfferStatus.REJECTED,
} as const;

/**
 * Transiciones válidas del estado de una oferta de despacho, derivadas de
 * `ESTADO_ABIERTO` (que usa el repositorio en todos sus `where`), `CIERRES` y
 * `LIBERACION` (la base las repite en el trigger
 * `TRG_order_dispatch_offer_transicion_de_estado` y un spec compara las dos).
 * El resto de los estados son terminales.
 */
export const DISPATCH_OFFER_TRANSITIONS: Readonly<
  Record<DispatchOfferStatus, readonly DispatchOfferStatus[]>
> = derivarTransiciones(Object.values(DispatchOfferStatus), (desde) => [
  ...(desde === ESTADO_ABIERTO ? CIERRES : []),
  ...(desde === LIBERACION.desde ? [LIBERACION.hacia] : []),
]);
