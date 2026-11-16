import { OrderStatus } from '../entities/order.entity';

export interface Coordenada {
  lat: number;
  lng: number;
}

/** Un pedido aceptado o en camino de un chofer, con su punto de entrega. */
export interface PedidoEnCursoDeChofer {
  orderId: string;
  status: OrderStatus;
  destino: Coordenada | null;
}

/**
 * `libre`: sin pedido en curso. `por_terminar`: un solo pedido, en camino y a
 * poca distancia de su destino: puede recibir un pedido más. `ocupado`: el resto.
 */
export type SituacionDeChofer = 'libre' | 'por_terminar' | 'ocupado';

/** Una posición más vieja que esto no sirve para decir que el chofer está por terminar. */
export const POSICION_VIGENTE_MS = 2 * 60 * 1000;

const POSICION_FUTURO_TOLERADO_MS = 30 * 1000;

/** ¿La posición se registró hace POSICION_VIGENTE_MS o menos? Sin fecha, no. */
export function posicionReciente(at: string | null, ahora: number): boolean {
  if (!at) return false;
  const momento = Date.parse(at);
  const edad = ahora - momento;
  // Una fecha más de 30 s en el futuro es un reloj roto, no una posición fresca.
  return (
    Number.isFinite(momento) &&
    edad <= POSICION_VIGENTE_MS &&
    edad >= -POSICION_FUTURO_TOLERADO_MS
  );
}

const RADIO_TIERRA_M = 6_371_000;

/** Distancia entre dos puntos sobre la esfera (haversine), en metros. */
export function distanciaEnMetros(a: Coordenada, b: Coordenada): number {
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA_M * Math.asin(Math.sqrt(h));
}

/**
 * La regla única de CU-013 (paso 3.a): ¿puede un chofer recibir un pedido más?
 * Lo usa el ofrecimiento de M1; M4 (lotes), el despacho express y el diagnóstico
 * de M4 siguen pidiendo sólo choferes `libre`, y la asignación manual no mira
 * si el chofer está ocupado.
 *
 * Por terminar = exactamente UN pedido en curso, en camino, y la última posición
 * conocida y reciente (2 minutos) a `radioMetros` o menos de su punto de entrega. Radio 0 lo apaga; sin
 * posición o sin punto de entrega no hay forma de medir y queda `ocupado`.
 */
export function situacionDelChofer(
  pedidos: readonly PedidoEnCursoDeChofer[],
  posicion: Coordenada | null,
  radioMetros: number,
): SituacionDeChofer {
  if (pedidos.length === 0) return 'libre';
  if (radioMetros <= 0 || pedidos.length !== 1) return 'ocupado';
  const [pedido] = pedidos;
  if (pedido.status !== OrderStatus.ON_THE_WAY) return 'ocupado';
  if (!pedido.destino || !posicion) return 'ocupado';
  return distanciaEnMetros(posicion, pedido.destino) <= radioMetros
    ? 'por_terminar'
    : 'ocupado';
}
