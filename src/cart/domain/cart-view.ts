import Decimal from 'decimal.js';

/** Máximo de unidades de un mismo tipo de garrafa en el carrito. */
export const CANTIDAD_MAXIMA_POR_ITEM = 999;

/** Un renglón del carrito con los datos vigentes de su tipo de garrafa. */
export interface ItemDelCarrito {
  cartItemId: string;
  gasCylinderId: string;
  type: string;
  quantity: number;
  /** Precio que vio el cliente al agregarlo. */
  savedUnitPrice: number;
  /** Precio vigente en el catálogo. */
  currentUnitPrice: number;
  /** Tipo de garrafa vigente en el catálogo (no dado de baja). */
  available: boolean;
  /** El stock vendible alcanza para la cantidad del renglón. */
  hasEnoughStock: boolean;
}

export interface RenglonDeVista extends ItemDelCarrito {
  /** Vigente menos guardado: positivo si subió. 0 si no cambió. */
  priceDifference: number;
  /** Cantidad × precio vigente. 0 si el tipo no está disponible. */
  subtotal: number;
}

export interface VistaDelCarrito {
  items: RenglonDeVista[];
  /** Unidades de los renglones disponibles. */
  totalUnits: number;
  /** Suma de los subtotales, sobre los precios vigentes del catálogo. */
  total: number;
  hasPriceChanges: boolean;
  hasUnavailableItems: boolean;
}

/**
 * Calcula el total del carrito sobre los precios VIGENTES del catálogo, no
 * sobre el guardado (CU-125): el precio guardado sólo sirve para avisar la
 * diferencia. Un tipo dado de baja se muestra pero no suma. Todo en Decimal.
 */
export function armarVista(items: ItemDelCarrito[]): VistaDelCarrito {
  let total = new Decimal(0);
  let totalUnits = 0;
  const renglones = items.map((item): RenglonDeVista => {
    const subtotal = item.available
      ? new Decimal(item.currentUnitPrice).times(item.quantity)
      : new Decimal(0);
    total = total.plus(subtotal);
    if (item.available) totalUnits += item.quantity;
    return {
      ...item,
      priceDifference: new Decimal(item.currentUnitPrice)
        .minus(item.savedUnitPrice)
        .toNumber(),
      subtotal: subtotal.toNumber(),
    };
  });
  return {
    items: renglones,
    totalUnits,
    total: total.toNumber(),
    hasPriceChanges: renglones.some((r) => r.priceDifference !== 0),
    hasUnavailableItems: renglones.some((r) => !r.available),
  };
}
