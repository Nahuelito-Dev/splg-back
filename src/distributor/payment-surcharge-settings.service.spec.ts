import { BadRequestException } from '@nestjs/common';
import { ConfigurableProcess } from './entities/module-config.entity';
import { ModuleConfigService } from './module-config.service';
import { PaymentSurchargeSettingsService } from './payment-surcharge-settings.service';
import { PaymentMethod } from '../order/entities/order.entity';

describe('PaymentSurchargeSettingsService', () => {
  let configs: { parametros: jest.Mock; fila: jest.Mock; guardar: jest.Mock };
  let service: PaymentSurchargeSettingsService;

  beforeEach(() => {
    configs = {
      parametros: jest.fn().mockResolvedValue(null),
      fila: jest.fn().mockResolvedValue(null),
      guardar: jest.fn().mockResolvedValue(undefined),
    };
    service = new PaymentSurchargeSettingsService(
      configs as unknown as ModuleConfigService,
    );
  });

  it('sin distribuidora o sin configuración rigen los de omisión', async () => {
    expect((await service.obtener(null)).transferPercentage).toBe(10);
    expect(configs.parametros).not.toHaveBeenCalled();
    expect(await service.porcentaje('d1', PaymentMethod.CASH)).toBe(0);
    expect(await service.porcentaje('d1', PaymentMethod.MERCADOPAGO)).toBe(10);
  });

  it('lee siempre de la base: un cambio rige en el acto, sin copia en memoria', async () => {
    configs.parametros.mockResolvedValue({ transferPercentage: 7.5 });
    expect(await service.porcentaje('d1', PaymentMethod.TRANSFER)).toBe(7.5);
    configs.parametros.mockResolvedValue({ transferPercentage: 3 });
    expect(await service.porcentaje('d1', PaymentMethod.TRANSFER)).toBe(3);
    expect(configs.parametros).toHaveBeenCalledWith(
      'd1',
      ConfigurableProcess.PAYMENT_SURCHARGES,
    );
  });

  it('el efectivo puede tener recargo propio', async () => {
    configs.parametros.mockResolvedValue({ cashPercentage: 4.25 });
    expect(await service.porcentaje('d1', PaymentMethod.CASH)).toBe(4.25);
  });

  it('vigentes informa isDefault y quién lo tocó', async () => {
    expect((await service.vigentes('d1')).isDefault).toBe(true);
    const fecha = new Date('2026-10-31T10:00:00Z');
    configs.fila.mockResolvedValue({
      params: { mercadoPagoPercentage: 5 },
      updatedAt: fecha,
      updatedByUserId: 'u1',
    });
    const v = await service.vigentes('d1');
    expect(v).toMatchObject({
      transferPercentage: 10,
      mercadoPagoPercentage: 5,
      cashPercentage: 0,
      isDefault: false,
      updatedAt: fecha,
      updatedByUserId: 'u1',
    });
  });

  it('una configuración vieja con recargo de transferencia se sigue leyendo, y sólo eso no la saca de los valores por omisión', async () => {
    configs.fila.mockResolvedValue({
      params: { transferPercentage: 5 },
      updatedAt: null,
      updatedByUserId: null,
    });
    const v = await service.vigentes('d1');
    expect(v.transferPercentage).toBe(5);
    expect(v.isDefault).toBe(true);
  });

  it('guardar reemplaza Mercado Pago y efectivo; el recargo de transferencia que llega se ignora y queda el guardado', async () => {
    configs.parametros.mockResolvedValue({ transferPercentage: 3 });
    await service.guardar(
      'd1',
      { transferPercentage: 7.5, mercadoPagoPercentage: 10, cashPercentage: 2 },
      'u1',
    );
    expect(configs.guardar).toHaveBeenCalledWith(
      'd1',
      ConfigurableProcess.PAYMENT_SURCHARGES,
      { transferPercentage: 3, mercadoPagoPercentage: 10, cashPercentage: 2 },
      'u1',
    );
  });

  it('guardar sin recargo de transferencia en el cuerpo es válido', async () => {
    await service.guardar(
      'd1',
      { mercadoPagoPercentage: 8, cashPercentage: 1 },
      'u1',
    );
    expect(configs.guardar).toHaveBeenCalledWith(
      'd1',
      ConfigurableProcess.PAYMENT_SURCHARGES,
      { transferPercentage: 10, mercadoPagoPercentage: 8, cashPercentage: 1 },
      'u1',
    );
  });

  it.each([
    [
      {
        transferPercentage: 10,
        mercadoPagoPercentage: null,
        cashPercentage: 0,
      },
    ],
    [{ transferPercentage: 10, cashPercentage: 0 }],
    [{ mercadoPagoPercentage: 31, cashPercentage: 0 }],
  ])('guardar rechaza un cuerpo incompleto o inválido %j', async (cuerpo) => {
    await expect(
      service.guardar('d1', cuerpo as never, 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(configs.guardar).not.toHaveBeenCalled();
  });
});
