import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { PaymentMethod } from '../entities/order.entity';

/** Promoción por volumen tal como se guarda en GasCylinder.promotions (JSONB). */
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
 *  - Recargo 10% si el método de pago es TRANSFER.
 *  - Todo en Decimal.js (nunca float) — requisito de confiabilidad NFR-08.
 */
@Injectable()
export class OrderPricingService {
  /** Recargo multiplicativo para pagos por transferencia (+10%). */
  /** Recargo +10% para pagos online (MercadoPago y Transferencia). Efectivo 0%. */
  private static readonly ONLINE_SURCHARGE_FACTOR = new Decimal('1.1');

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

    const subtotal = unitPrice.times(new Decimal(quantity));
    return { unitPrice, subtotal };
  }

  /**
   * Aplica el recargo del método de pago sobre el total. MercadoPago y
   * Transferencia = +10% (pagos online); Efectivo = sin recargo.
   */
  applyPaymentSurcharge(total: Decimal, method: PaymentMethod): Decimal {
    if (
      method === PaymentMethod.MERCADOPAGO ||
      method === PaymentMethod.TRANSFER
    ) {
      return total.times(OrderPricingService.ONLINE_SURCHARGE_FACTOR);
    }
    return total;
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
