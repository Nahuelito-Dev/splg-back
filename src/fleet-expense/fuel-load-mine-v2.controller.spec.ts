import { BadRequestException } from '@nestjs/common';
import { PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import { FuelLoadMineV2Controller } from './fuel-load-mine-v2.controller';

describe('importe de la carga del chofer en la API v2', () => {
  const controller = new FuelLoadMineV2Controller();

  it('vive en `/fleet/fuel-loads/mine` versión 2', () => {
    expect(
      Reflect.getMetadata(VERSION_METADATA, FuelLoadMineV2Controller),
    ).toBe('2');
    expect(Reflect.getMetadata(PATH_METADATA, FuelLoadMineV2Controller)).toBe(
      'fleet/fuel-loads/mine',
    );
  });

  it('el importe es litros × precio a 2 decimales', () => {
    expect(controller.quote({ liters: 40.5, unitPrice: 1050.555 })).toEqual({
      liters: 40.5,
      unitPrice: 1050.555,
      totalAmount: 42547.48,
    });
  });

  it('un importe por encima del máximo se rechaza', () => {
    expect(() =>
      controller.quote({ liters: 9_000_000_000, unitPrice: 9_000_000_000 }),
    ).toThrow(BadRequestException);
  });
});
