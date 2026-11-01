import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

/** Promoción por volumen de un producto (tabla gas_cylinder_promotion). */
export interface VolumePromotion {
  quantity: number;
  discountPercentage: number;
}

/** Resultado del cálculo de un ítem (montos con precisión Decimal). */
export interface ItemPricing {
  unitPrice: Decimal;
  subtotal: Decimal;
}

/**
 * Lógica de dominio PURA de precios de un pedido. Sin I/O ni dependencias de
 * infraestructura: recibe datos y devuelve montos. Extraída de OrderService
 * (god object) para respetar SRP y poder testearla en aislamiento.
 *
 * Reglas (según SRS):
 *  - Descuento por volumen: se aplica la promo de mayor umbral que la cantidad
 *    alcance (ej: compra 10 con promos [5→10%, 10→20%] ⇒ 20%).
 *  - Recargo por medio de pago: el % es un parámetro de la distribuidora.
 *  - Todo en Decimal.js (nunca float) — requisito de confiabilidad NFR-08.
 */
@Injectable()
export class OrderPricingService {
  /**
   * Precio unitario (con la mejor promo aplicable) y subtotal de un ítem.
   * @param basePrice precio de lista de la garrafa (fuente: DB, nunca el cliente)
   */
  priceItem(
    basePrice: number | string,
    promotions: VolumePromotion[] | null | undefined,
    quantity: number,
  ): ItemPricing {
    let unitPrice = new Decimal(basePrice);

    const promo = this.bestApplicablePromotion(promotions, quantity);
    if (promo) {
      const discountFactor = new Decimal(1).minus(
        new Decimal(promo.discountPercentage).dividedBy(100),
      );
      unitPrice = unitPrice.times(discountFactor);
    }

    // El renglón guarda los dos a 2 decimales: el subtotal sale del precio ya
    // redondeado, así cantidad × precio guardado coincide siempre con el subtotal.
    unitPrice = unitPrice.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const subtotal = unitPrice.times(new Decimal(quantity));
    return { unitPrice, subtotal };
  }

  /**
   * Aplica el recargo del medio de pago sobre el total. El porcentaje lo define
   * cada distribuidora por medio de pago (0 a 30 %, hasta 2 decimales): acá
   * llega ya resuelto. Sin redondear: quien guarda el monto lo redondea.
   */
  applyPaymentSurcharge(total: Decimal, percentage: number | Decimal): Decimal {
    return total.times(new Decimal(1).plus(new Decimal(percentage).div(100)));
  }

  /** La promo de mayor `quantity` que la cantidad pedida alcanza (o null). */
  private bestApplicablePromotion(
    promotions: VolumePromotion[] | null | undefined,
    quantity: number,
  ): VolumePromotion | null {
    if (!promotions || promotions.length === 0) return null;
    return (
      [...promotions]
        .sort((a, b) => b.quantity - a.quantity)
        .find((p) => quantity >= p.quantity) ?? null
    );
  }
}
