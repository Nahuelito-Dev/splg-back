import { PaymentSurchargeConfigController } from './payment-surcharge-config.controller';

describe('PaymentSurchargeConfigController', () => {
  let recargos: { vigentes: jest.Mock; guardar: jest.Mock };
  let controller: PaymentSurchargeConfigController;

  beforeEach(() => {
    recargos = {
      vigentes: jest.fn().mockResolvedValue({ mercadoPagoPercentage: 10 }),
      guardar: jest.fn().mockResolvedValue({ mercadoPagoPercentage: 7.5 }),
    };
    controller = new PaymentSurchargeConfigController(recargos as never);
  });

  it('GET lee los recargos de la distribuidora en contexto', async () => {
    await controller.get('dist-1');
    expect(recargos.vigentes).toHaveBeenCalledWith('dist-1');
  });

  it('PUT guarda con la distribuidora del contexto y el usuario del token', async () => {
    await controller.put(
      { mercadoPagoPercentage: 10, cashPercentage: 0 },
      'dist-1',
      'adm-1',
    );
    expect(recargos.guardar).toHaveBeenCalledWith(
      'dist-1',
      { mercadoPagoPercentage: 10, cashPercentage: 0 },
      'adm-1',
    );
  });
});
