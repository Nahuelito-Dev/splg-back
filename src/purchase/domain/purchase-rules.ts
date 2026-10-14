import Decimal from 'decimal.js';
import {
  OrdenNoEditableError,
  CompraInvalidaError,
  TransicionDeOrdenInvalidaError,
} from './errors/purchase.errors';
import { PurchaseOrderStatus as E } from './purchase.enums';

/**
 * Máquina de estados de la orden de compra. Las vueltas atrás (recibida o
 * parcial hacia parcial o enviada) sólo las produce anular una recepción.
 */
const TRANSICIONES: Record<E, readonly E[]> = {
  [E.DRAFT]: [E.SENT, E.CANCELLED],
  [E.SENT]: [E.PARTIALLY_RECEIVED, E.RECEIVED, E.CANCELLED],
  [E.PARTIALLY_RECEIVED]: [
    E.PARTIALLY_RECEIVED,
    E.RECEIVED,
    E.SENT,
    E.CLOSED_SHORT,
  ],
  [E.RECEIVED]: [E.PARTIALLY_RECEIVED, E.SENT],
  [E.CLOSED_SHORT]: [],
  [E.CANCELLED]: [],
};

export function validarTransicion(desde: E, hacia: E): void {
  if (!TRANSICIONES[desde].includes(hacia)) {
    throw new TransicionDeOrdenInvalidaError(desde, hacia);
  }
}

export function validarEditable(estado: E): void {
  if (estado !== E.DRAFT) throw new OrdenNoEditableError(estado);
}

/**
 * Estados en los que lo recibido define el estado de la orden. Una orden
 * cancelada o cerrada con faltante conserva el suyo aunque se anule una
 * recepción.
 */
export const ESTADOS_QUE_SIGUEN_A_LO_RECIBIDO: readonly E[] = [
  E.SENT,
  E.PARTIALLY_RECEIVED,
  E.RECEIVED,
];

/** Estados desde los que la orden recibe mercadería. */
export const ESTADOS_RECIBIBLES: readonly E[] = [E.SENT, E.PARTIALLY_RECEIVED];

export interface RenglonRecibido {
  quantity: number;
  receivedQuantity: number;
}

/** Cuánto falta recibir de un renglón (nunca negativo). */
export const pendienteDe = (r: RenglonRecibido): number =>
  Math.max(0, r.quantity - r.receivedQuantity);

/**
 * Estado de la orden según lo recibido: nada recibido es `sent`, todo recibido
 * es `received` y lo demás `partially_received`.
 */
export function estadoSegunRecibido(renglones: RenglonRecibido[]): E {
  if (renglones.every((r) => r.receivedQuantity === 0)) return E.SENT;
  if (renglones.every((r) => r.receivedQuantity >= r.quantity))
    return E.RECEIVED;
  return E.PARTIALLY_RECEIVED;
}

export interface RenglonDeOrden {
  quantity: number;
  unitCost: number;
}

/** Total de la orden: Σ cantidad × costo unitario, con aritmética decimal. */
export function totalDe(renglones: RenglonDeOrden[]): number {
  const total = renglones
    .reduce(
      (acc, r) => acc.plus(new Decimal(r.unitCost).times(r.quantity)),
      new Decimal(0),
    )
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toNumber();
  if (total > TOTAL_MAXIMO) {
    throw new CompraInvalidaError(
      'El total supera el máximo permitido: dividí la compra en más de un documento',
    );
  }
  return total;
}

const dos = (d: Decimal): number =>
  d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();

/**
 * Costo promedio ponderado al entrar `cantidad` unidades a `costoNuevo`:
 * `(existencia × costoPrevio + cantidad × costoNuevo) / (existencia + cantidad)`.
 * Sin existencia previa o sin costo previo, el promedio es el costo nuevo.
 */
export function costoPromedioPonderado(args: {
  existenciaPrevia: number;
  costoPrevio: number | null;
  cantidad: number;
  costoNuevo: number;
}): number {
  const { existenciaPrevia, costoPrevio, cantidad, costoNuevo } = args;
  if (cantidad <= 0)
    throw new CompraInvalidaError('La cantidad debe ser positiva');
  if (costoPrevio === null || existenciaPrevia <= 0)
    return dos(new Decimal(costoNuevo));
  const total = new Decimal(costoPrevio)
    .times(existenciaPrevia)
    .plus(new Decimal(costoNuevo).times(cantidad));
  return dos(total.div(existenciaPrevia + cantidad));
}

export interface RenglonDeRecepcion {
  gasCylinderId: string;
  quantityFull: number;
  quantityEmptyOut: number;
}

/** Reglas propias de los renglones de una recepción, antes de tocar la base. */
export function validarRenglonesDeRecepcion(r: RenglonDeRecepcion[]): void {
  if (r.length === 0) {
    throw new CompraInvalidaError(
      'La recepción tiene que tener al menos un renglón',
    );
  }
  const vistos = new Set<string>();
  for (const item of r) {
    if (vistos.has(item.gasCylinderId)) {
      throw new CompraInvalidaError(
        'Una garrafa aparece dos veces en la recepción: juntá las cantidades en un solo renglón',
      );
    }
    vistos.add(item.gasCylinderId);
    if (item.quantityFull === 0 && item.quantityEmptyOut === 0) {
      throw new CompraInvalidaError(
        'Cada renglón tiene que recibir llenas o entregar vacías',
      );
    }
  }
}

/**
 * Lo recibido no puede pasar de lo pedido: devuelve las garrafas que se pasan
 * (con lo que falta recibir de cada una) para armar el mensaje.
 */
export function excesosDeRecepcion(
  pedido: Map<string, RenglonRecibido>,
  recibido: Array<Pick<RenglonDeRecepcion, 'gasCylinderId' | 'quantityFull'>>,
): Array<{ gasCylinderId: string; pendiente: number; recibido: number }> {
  return recibido
    .filter((r) => {
      const p = pedido.get(r.gasCylinderId);
      return p !== undefined && r.quantityFull > pendienteDe(p);
    })
    .map((r) => ({
      gasCylinderId: r.gasCylinderId,
      pendiente: pendienteDe(pedido.get(r.gasCylinderId)!),
      recibido: r.quantityFull,
    }));
}

/** Una recepción de llenas de una garrafa, con lo que se guardó al confirmarla. */
export interface CompraDeLaGarrafa {
  /** Número interno: define el orden en que se calculó el promedio. */
  numero: number;
  cantidad: number;
  costoUnitario: number;
  /** Promedio justo antes de esta recepción. */
  costoPrevio: number | null;
  /** Llenas totales justo antes de esta recepción; `null` en una recepción vieja sin esos datos. */
  existenciaPrevia: number | null;
  /** ¿Sigue confirmada? La que se está anulando va como `false`. */
  vigente: boolean;
  /**
   * Instante (ms) en que se leyó `existenciaPrevia`, bajo el lock de la garrafa
   * (`previous_on_hand_at`; en una recepción vieja, su `createdAt`). Es el que
   * decide si una anulación ya estaba en esa existencia.
   */
  altaEn: number;
  /**
   * Instante en que se anuló (ms), `null` si sigue confirmada. La que se anula
   * ahora lleva el instante actual.
   */
  anuladaEn: number | null;
}

/**
 * Costo promedio de una garrafa recalculado a partir de las recepciones que
 * siguen confirmadas, en el orden en que se confirmaron. Es exacto y no depende
 * del orden en que se anularon las demás:
 *  - parte del promedio que había antes de la primera recepción;
 *  - repite la fórmula de la recepción (`costoPromedioPonderado`) con la
 *    existencia previa que se guardó en cada una, restándole las llenas de las
 *    recepciones anteriores que se anularon DESPUÉS de que ésta se confirmó (si
 *    se anularon antes, la existencia guardada ya no las incluía);
 *  - sin ninguna recepción vigente vuelve al promedio de partida.
 * Las ventas, mermas y ajustes no cambian el promedio, sólo lo hace una compra:
 * por eso alcanza con repetir las compras. Si alguna recepción necesaria es
 * anterior a las columnas `previous_*` (`existenciaPrevia` nula) no se puede
 * reconstruir y devuelve `'no-reconstruible'`: quien llama deja el promedio como está.
 *
 * @param compras todas las recepciones de llenas de la garrafa (vigentes y no),
 *   por número ascendente.
 */
export function recalcularCostoPromedio(
  compras: CompraDeLaGarrafa[],
): number | null | 'no-reconstruible' {
  if (compras.length === 0) return null;
  const vigentes = compras.filter((c) => c.vigente);
  if (
    compras.some(
      (c) => (c.vigente || c === compras[0]) && c.existenciaPrevia === null,
    )
  ) {
    return 'no-reconstruible';
  }
  let costo = compras[0].costoPrevio;
  for (const c of vigentes) {
    const anuladasDespues = compras
      .filter(
        (o) =>
          o.numero < c.numero &&
          !o.vigente &&
          o.anuladaEn !== null &&
          o.anuladaEn > c.altaEn,
      )
      .reduce((total, o) => total + o.cantidad, 0);
    costo = costoPromedioPonderado({
      existenciaPrevia: Math.max(0, c.existenciaPrevia! - anuladasDespues),
      costoPrevio: costo,
      cantidad: c.cantidad,
      costoNuevo: c.costoUnitario,
    });
  }
  return costo;
}

/** El total de una orden o remito tiene que entrar en `numeric(12,2)`. */
export const TOTAL_MAXIMO = 9_999_999_999.99;
