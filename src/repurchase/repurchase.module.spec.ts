import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConsumptionController } from './consumption.controller';
import { ConsumptionDeliveredListener } from './consumption-delivered.listener';
import { ConsumptionService } from './consumption.service';
import { RepurchaseModule } from './repurchase.module';

describe('RepurchaseModule', () => {
  const meta = (clave: string): unknown[] =>
    Reflect.getMetadata(clave, RepurchaseModule) as unknown[];

  it('expone el consumo declarado y recalcula la estimación al entregarse un pedido', () => {
    expect(meta(MODULE_METADATA.CONTROLLERS)).toEqual([ConsumptionController]);
    expect(meta(MODULE_METADATA.PROVIDERS)).toEqual([
      ConsumptionService,
      ConsumptionDeliveredListener,
    ]);
  });

  it('exporta el servicio de consumo para el registro (CU-143)', () => {
    expect(meta(MODULE_METADATA.EXPORTS)).toEqual([ConsumptionService]);
  });
});
