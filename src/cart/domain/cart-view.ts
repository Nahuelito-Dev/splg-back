import Decimal from 'decimal.js';
import type {
  ItemPricing,
  VolumePromotion,
} from '../../order/domain/order-pricing.service';

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
  /** Precio de lista vigente en el catálogo (sin promociones). */
  listUnitPrice: number;
  /** Promociones por volumen activas (no dadas de baja) del producto. */
  promotions?: VolumePromotion[] | null;
  /** Tipo de garrafa vigente en el catálogo (no dado de baja). */
  available: boolean;
  /** El stock vendible alcanza para la cantidad del renglón. */
  hasEnoughStock: boolean;
}

/** La regla de precio por renglón del pedido (`OrderPricingService.priceItem`). */
export interface ValorizadorDeRenglon {
  priceItem(
    basePrice: number | string,
    promotions: VolumePromotion[] | null | undefined,
    quantity: number,
  ): ItemPricing;
}

export interface RenglonDeVista
  extends Omit<ItemDelCarrito, 'promotions' | 'listUnitPrice'> {
  /** Precio de lista vigente, sin promoción. */
  listUnitPrice: number;
  /** % de descuento por volumen aplicado a la cantidad del renglón (0 si no hay). */
  discountPercentage: number;
  /** Precio unitario con la promoción aplicada (igual al de lista si no hay). */
  promoUnitPrice: number;
  /** Precio unitario vigente con promoción: el mismo que cotiza y cobra el pedido. */
  currentUnitPrice: number;
  /** Precio de lista vigente menos guardado: positivo si subió. 0 si no cambió. */
  priceDifference: number;
  /** Cantidad × precio unitario con promoción. 0 si el tipo no está disponible. */
  subtotal: number;
}

export interface VistaDelCarrito {
  items: RenglonDeVista[];
  /** Unidades de los renglones disponibles. */
  totalUnits: number;
  /**
   * Suma de los subtotales con promoción. Sin recargo de zona, de pago online
   * ni express: esos los da la cotización (`POST /orders/quote`).
   */
  total: number;
  hasPriceChanges: boolean;
  hasUnavailableItems: boolean;
}

/**
 * Calcula el total del carrito sobre los precios VIGENTES del catálogo, no
 * sobre el guardado (CU-125): el precio guardado sólo sirve para avisar la
 * diferencia de precio de lista. Cada renglón se valoriza con la misma regla
 * que la cotización y el pedido (promoción por volumen y redondeo a 2
 * decimales). Un tipo dado de baja se muestra pero no suma. Todo en Decimal.
 */
export function armarVista(
  items: ItemDelCarrito[],
  pricing: ValorizadorDeRenglon,
): VistaDelCarrito {
  let total = new Decimal(0);
  let totalUnits = 0;
  const renglones = items.map((item): RenglonDeVista => {
    const { promotions, ...resto } = item;
    const { unitPrice, subtotal } = pricing.priceItem(
      item.listUnitPrice,
      promotions,
      item.quantity,
    );
    const subtotalVendible = item.available ? subtotal : new Decimal(0);
    total = total.plus(subtotalVendible);
    if (item.available) totalUnits += item.quantity;
    return {
      ...resto,
      listUnitPrice: item.listUnitPrice,
      discountPercentage: mejorDescuento(promotions, item.quantity),
      promoUnitPrice: unitPrice.toNumber(),
      currentUnitPrice: unitPrice.toNumber(),
      priceDifference: new Decimal(item.listUnitPrice)
        .minus(item.savedUnitPrice)
        .toNumber(),
      subtotal: subtotalVendible.toNumber(),
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

/** % de la promo de mayor umbral que la cantidad alcanza (misma regla que el pedido). */
function mejorDescuento(
  promotions: VolumePromotion[] | null | undefined,
  quantity: number,
): number {
  const promo = [...(promotions ?? [])]
    .sort((a, b) => b.quantity - a.quantity)
    .find((p) => quantity >= p.quantity);
  return promo?.discountPercentage ?? 0;
}
