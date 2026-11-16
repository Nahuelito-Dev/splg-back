import { PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import { CarFleetController } from './car-fleet.controller';
import { FleetCostV2Controller } from './fleet-cost-v2.controller';

describe('tablero de costos de la flota en la API v2', () => {
  it('vive en `/fleet/costs` versión 2 y la v1 sigue sin versión', () => {
    expect(Reflect.getMetadata(VERSION_METADATA, FleetCostV2Controller)).toBe(
      '2',
    );
    expect(Reflect.getMetadata(PATH_METADATA, FleetCostV2Controller)).toBe(
      'fleet/costs',
    );
    expect(
      Reflect.getMetadata(VERSION_METADATA, CarFleetController),
    ).toBeUndefined();
  });
});
