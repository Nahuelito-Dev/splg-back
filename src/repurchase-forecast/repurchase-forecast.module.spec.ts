import { MODULE_METADATA } from '@nestjs/common/constants';
import { RepurchaseAdminController } from './repurchase-admin.controller';
import { RepurchaseCustomerController } from './repurchase-customer.controller';
import { RepurchaseForecastModule } from './repurchase-forecast.module';
import { RepurchaseCron } from './repurchase.cron';

describe('RepurchaseForecastModule', () => {
  const meta = (clave: string): unknown[] =>
    Reflect.getMetadata(clave, RepurchaseForecastModule) as unknown[];

  it('expone los dos controladores y el proceso diario', () => {
    expect(meta(MODULE_METADATA.CONTROLLERS)).toEqual([
      RepurchaseAdminController,
      RepurchaseCustomerController,
    ]);
    expect(meta(MODULE_METADATA.PROVIDERS)).toContain(RepurchaseCron);
  });

  it('no exporta nada: nadie depende de él (el pedido no se entera de la recompra)', () => {
    expect(meta(MODULE_METADATA.EXPORTS)).toBeUndefined();
  });
});
