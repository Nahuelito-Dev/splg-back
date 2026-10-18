import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { IDEMPOTENT_KEY } from '../common/decorators/idempotent.decorator';
import { FuelLoadController } from './fuel-load.controller';
import { TireController } from './tire.controller';
import { TrafficFineController } from './traffic-fine.controller';
import { VehicleAccidentController } from './vehicle-accident.controller';

interface ArgCustom {
  index: number;
  data?: { required?: boolean | 'staff' };
}
type Clase = { name: string; prototype: object };

const LECTURAS_Y_ESCRITURAS: Array<[Clase, string[]]> = [
  [
    FuelLoadController,
    ['create', 'createMine', 'findAll', 'findOne', 'update', 'anular'],
  ],
  [
    TrafficFineController,
    [
      'create',
      'findAll',
      'findOne',
      'update',
      'pay',
      'chargeToEmployee',
      'void',
    ],
  ],
  [
    VehicleAccidentController,
    ['create', 'createMine', 'findAll', 'findOne', 'update', 'close'],
  ],
  [TireController, ['create', 'findAll', 'findOne', 'registerEvent']],
];

const CREACIONES: Array<[Clase, string[]]> = [
  [FuelLoadController, ['create', 'createMine']],
  [TrafficFineController, ['create']],
  [VehicleAccidentController, ['create', 'createMine']],
  [TireController, ['create', 'registerEvent']],
];

describe('endpoints de la flota ampliada', () => {
  it.each(
    LECTURAS_Y_ESCRITURAS.flatMap(([clase, metodos]) =>
      metodos.map((m) => [`${clase.name}.${m}`, clase, m] as const),
    ),
  )(
    '%s acota por distribuidora (X-Distributor obligatorio)',
    (_n, clase, metodo) => {
      const args = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        clase,
        metodo,
      ) as Record<string, ArgCustom>;
      expect(Object.values(args).some((a) => Boolean(a.data?.required))).toBe(
        true,
      );
    },
  );

  it.each(
    CREACIONES.flatMap(([clase, metodos]) =>
      metodos.map((m) => [`${clase.name}.${m}`, clase, m] as const),
    ),
  )('%s acepta Idempotency-Key', (_n, clase, metodo) => {
    const handler = (clase.prototype as Record<string, object>)[metodo];
    expect(Reflect.getMetadata(IDEMPOTENT_KEY, handler)).toBe(true);
  });
});
