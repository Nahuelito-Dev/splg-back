import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { CoverageZoneSurchargeType } from './entities/coverage-zone.entity';

/** Lo mínimo de una zona que hace falta para calcular su recargo. */
export interface ZonaParaRecargo {
  type: CoverageZoneSurchargeType;
  value: number;
}

/**
 * Cálculo del recargo por zona de cobertura. Lógica de dominio PURA (sin I/O):
 * recibe el subtotal de los ítems (YA con promociones aplicadas) y la zona
 * ganadora, y devuelve el monto a sumar al total del pedido.
 *
 *  - `fixed`: el recargo es el valor tal cual (un monto).
 *  - `percentage`: el recargo es ese % del subtotal de los ítems.
 *
 * Todo en Decimal.js (nunca float) y redondeado a 2 decimales HALF_UP, como el
 * resto de los montos del pedido (ver OrderPricingService).
 */
@Injectable()
export class CoverageZonePricingService {
  zoneSurcharge(
    subtotalItems: Decimal.Value,
    zone: ZonaParaRecargo | null | undefined,
  ): Decimal {
    if (!zone) return new Decimal(0);

    const valor = new Decimal(zone.value);
    const monto =
      zone.type === CoverageZoneSurchargeType.PERCENTAGE
        ? new Decimal(subtotalItems).times(valor).dividedBy(100)
        : valor;

    return monto.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }
}
