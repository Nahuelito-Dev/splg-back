import Decimal from 'decimal.js';
import { CoverageZonePricingService } from './coverage-zone-pricing.service';
import { CoverageZoneSurchargeType } from './entities/coverage-zone.entity';

describe('CoverageZonePricingService', () => {
  const service = new CoverageZonePricingService();

  it('sin zona, el recargo es 0', () => {
    expect(service.zoneSurcharge(10000, null).toNumber()).toBe(0);
  });

  it('fixed: el recargo es el valor tal cual, sin importar el subtotal', () => {
    const zone = {
      type: CoverageZoneSurchargeType.FIXED,
      value: 500,
    };
    expect(service.zoneSurcharge(10000, zone).toNumber()).toBe(500);
    expect(service.zoneSurcharge(0, zone).toNumber()).toBe(500);
  });

  it('percentage: el recargo es ese % del subtotal de los ítems', () => {
    const zone = {
      type: CoverageZoneSurchargeType.PERCENTAGE,
      value: 10,
    };
    expect(service.zoneSurcharge(10000, zone).toNumber()).toBe(1000);
    expect(service.zoneSurcharge(3333, zone).toNumber()).toBe(333.3);
  });

  it('percentage 0, el recargo es 0', () => {
    const zone = {
      type: CoverageZoneSurchargeType.PERCENTAGE,
      value: 0,
    };
    expect(service.zoneSurcharge(10000, zone).toNumber()).toBe(0);
  });

  it('redondea a 2 decimales con HALF_UP', () => {
    const zone = {
      type: CoverageZoneSurchargeType.PERCENTAGE,
      value: 10,
    };
    // 333.335 → 333.34 (HALF_UP), no 333.33 (lo que daría un truncado/banker's)
    expect(service.zoneSurcharge(3333.35, zone).toNumber()).toBe(333.34);
    expect(new Decimal(service.zoneSurcharge(3333.35, zone)).toFixed(2)).toBe(
      '333.34',
    );
  });

  it('acepta el subtotal como Decimal además de number', () => {
    const zone = {
      type: CoverageZoneSurchargeType.FIXED,
      value: 250,
    };
    expect(service.zoneSurcharge(new Decimal(10000), zone).toNumber()).toBe(
      250,
    );
  });
});
