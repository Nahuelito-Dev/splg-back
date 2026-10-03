import Decimal from 'decimal.js';
import { OrderPricingService, VolumePromotion } from './order-pricing.service';
import { PaymentMethod } from '../entities/order.entity';

/**
 * Dominio PURO de precios: sin I/O ni mocks. Cubre las reglas del SRS:
 *  - descuento por volumen (mejor tramo aplicable),
 *  - recargo +10% por transferencia,
 *  - precisión Decimal (NFR-08, nunca float).
 */
describe('OrderPricingService', () => {
  let pricing: OrderPricingService;

  beforeEach(() => {
    pricing = new OrderPricingService();
  });

  describe('priceItem — sin promociones', () => {
    it('usa el precio de lista tal cual (unit = base, subtotal = base × qty)', () => {
      const { unitPrice, subtotal } = pricing.priceItem(1000, null, 3);
      expect(unitPrice.toNumber()).toBe(1000);
      expect(subtotal.toNumber()).toBe(3000);
    });

    it('acepta el precio base como string (viene de la DB en NUMERIC)', () => {
      const { unitPrice, subtotal } = pricing.priceItem('9500.00', [], 2);
      expect(unitPrice.toNumber()).toBe(9500);
      expect(subtotal.toNumber()).toBe(19000);
    });

    it('trata undefined/[] de promociones como sin descuento', () => {
      expect(pricing.priceItem(500, undefined, 1).subtotal.toNumber()).toBe(
        500,
      );
      expect(pricing.priceItem(500, [], 1).subtotal.toNumber()).toBe(500);
    });
  });

  describe('priceItem — con promociones por volumen', () => {
    const promos: VolumePromotion[] = [
      { quantity: 3, discountPercentage: 10 },
      { quantity: 5, discountPercentage: 20 },
    ];

    it('NO aplica descuento si la cantidad no alcanza ningún umbral', () => {
      const { unitPrice, subtotal } = pricing.priceItem(1000, promos, 2);
      expect(unitPrice.toNumber()).toBe(1000);
      expect(subtotal.toNumber()).toBe(2000);
    });

    it('aplica la promo justo al alcanzar el umbral (qty === umbral)', () => {
      const { unitPrice, subtotal } = pricing.priceItem(1000, promos, 3);
      expect(unitPrice.toNumber()).toBe(900); // -10%
      expect(subtotal.toNumber()).toBe(2700);
    });

    it('elige el MEJOR tramo aplicable (mayor umbral alcanzado), no el primero', () => {
      // qty 6 alcanza ambos (3 y 5) → debe usar el de 5 (20%), no el de 3.
      const { unitPrice, subtotal } = pricing.priceItem(1000, promos, 6);
      expect(unitPrice.toNumber()).toBe(800); // -20%
      expect(subtotal.toNumber()).toBe(4800);
    });

    it('funciona con las promos en orden arbitrario (las ordena internamente)', () => {
      const desordenadas: VolumePromotion[] = [
        { quantity: 5, discountPercentage: 20 },
        { quantity: 3, discountPercentage: 10 },
      ];
      const { unitPrice } = pricing.priceItem(1000, desordenadas, 5);
      expect(unitPrice.toNumber()).toBe(800);
    });
  });

  describe('applyPaymentSurcharge', () => {
    it('suma +10% cuando el método es TRANSFER', () => {
      const total = pricing.applyPaymentSurcharge(
        new Decimal(1000),
        PaymentMethod.TRANSFER,
      );
      expect(total.toNumber()).toBe(1100);
    });

    it('no toca el total en CASH', () => {
      const total = pricing.applyPaymentSurcharge(
        new Decimal(1000),
        PaymentMethod.CASH,
      );
      expect(total.toNumber()).toBe(1000);
    });

    it('suma +10% cuando el método es MERCADOPAGO (pago online)', () => {
      const total = pricing.applyPaymentSurcharge(
        new Decimal(1000),
        PaymentMethod.MERCADOPAGO,
      );
      expect(total.toNumber()).toBe(1100);
    });
  });

  describe('flujo combinado (como en CreateOrderUseCase) y precisión Decimal', () => {
    it('reproduce el pedido verificado: 1000 base, promo 3u→10%, qty 3, transfer → 2970', () => {
      const { subtotal } = pricing.priceItem(
        1000,
        [{ quantity: 2, discountPercentage: 10 }],
        3,
      );
      const total = pricing.applyPaymentSurcharge(
        subtotal,
        PaymentMethod.TRANSFER,
      );
      // unit 900 × 3 = 2700 ; ×1.1 = 2970
      expect(total.toNumber()).toBe(2970);
    });

    it('mantiene precisión sin errores de float (0.1 + 0.2 clásico)', () => {
      // precio que en float daría 0.30000000000000004
      const { subtotal } = pricing.priceItem('0.1', null, 3);
      expect(subtotal.toString()).toBe('0.3');
    });
  });

  describe('priceItem — centavos', () => {
    it('el subtotal es cantidad × precio unitario ya redondeado a centavos', () => {
      // 10,53 con 5% de descuento = 10,0035 → 10,00; 3 × 10,00 = 30,00 (no 30,01).
      const { unitPrice, subtotal } = pricing.priceItem(
        '10.53',
        [{ quantity: 1, discountPercentage: 5 }],
        3,
      );
      expect(unitPrice.toNumber()).toBe(10);
      expect(subtotal.toNumber()).toBe(30);
    });
  });
});
