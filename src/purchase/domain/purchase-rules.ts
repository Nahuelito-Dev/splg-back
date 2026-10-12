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

export interface DatosParaAnular {
  costoActual: number | null;
  /** Promedio y existencia (llenas totales) justo antes de la recepción; `null` si es una recepción vieja sin esos datos. */
  costoPrevio: number | null;
  existenciaPrevia: number | null;
  cantidad: number;
  costoRecibido: number;
  /** ¿Quedan otras recepciones confirmadas de esta garrafa? */
  hayOtrasCompras: boolean;
  /** ¿Hay una recepción confirmada POSTERIOR a ésta? */
  hayCompraPosterior: boolean;
  /** Σ cantidad x costo / Σ cantidad de las otras recepciones confirmadas. */
  promedioDeLasOtras: number | null;
}

/**
 * Costo promedio al anular una recepción. Las ventas, mermas y ajustes no
 * cambian el promedio (sólo lo cambia una compra), así que:
 *  1. si no queda ninguna otra compra confirmada, el costo vuelve a `null`;
 *  2. si ésta es la última compra, vuelve EXACTO al promedio que tenía antes
 *     (el guardado en el renglón), hayan pasado las ventas que hayan pasado;
 *  3. si hubo compras posteriores, se resta de hoy lo que esta compra había
 *     movido el promedio: `cantidad x (costo recibido - costo previo) / (existencia
 *     previa + cantidad)`. Es una aproximación (las compras posteriores lo
 *     diluyeron) y nunca queda negativo;
 *  4. si antes no había costo previo, el promedio es el de las otras compras;
 *  5. una recepción vieja sin los datos guardados usa la existencia actual.
 */
export function costoPromedioAlAnular(a: DatosParaAnular): number | null {
  if (!a.hayOtrasCompras) return null;
  if (a.costoPrevio === null) return a.promedioDeLasOtras;
  if (a.existenciaPrevia === null) return a.costoActual;
  if (!a.hayCompraPosterior) return dos(new Decimal(a.costoPrevio));
  if (a.costoActual === null) return a.promedioDeLasOtras;
  const desvio = new Decimal(a.costoRecibido)
    .minus(a.costoPrevio)
    .times(a.cantidad)
    .div(a.existenciaPrevia + a.cantidad);
  const nuevo = new Decimal(a.costoActual).minus(desvio);
  return dos(nuevo.lt(0) ? new Decimal(0) : nuevo);
}

/** El total de una orden o remito tiene que entrar en `numeric(12,2)`. */
export const TOTAL_MAXIMO = 9_999_999_999.99;
