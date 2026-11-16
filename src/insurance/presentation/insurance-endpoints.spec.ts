import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { IDEMPOTENT_KEY } from '../../common/decorators/idempotent.decorator';
import { InsuranceInstallmentController } from './insurance-installment.controller';
import { InsurancePolicyController } from './insurance-policy.controller';
import { InsurerController } from './insurer.controller';

interface ArgCustom {
  data?: { required?: boolean | 'staff' };
}
type Clase = { name: string; prototype: object };

const ENDPOINTS: Array<[Clase, string[]]> = [
  [InsurerController, ['findAll', 'findOne', 'create', 'update', 'remove']],
  [
    InsurancePolicyController,
    ['ofCar', 'create', 'findOne', 'update', 'cancel'],
  ],
  [
    InsuranceInstallmentController,
    ['findAll', 'findOne', 'update', 'uploadReceipt', 'pay'],
  ],
];

describe('endpoints de seguros', () => {
  it.each(
    ENDPOINTS.flatMap(([clase, metodos]) =>
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

  it.each([
    [InsurerController, 'create'],
    [InsurancePolicyController, 'create'],
    [InsurancePolicyController, 'cancel'],
    [InsuranceInstallmentController, 'uploadReceipt'],
    [InsuranceInstallmentController, 'pay'],
  ] as Array<[Clase, string]>)(
    '%s.%s acepta Idempotency-Key',
    (clase, metodo) => {
      const handler = (clase.prototype as Record<string, object>)[metodo];
      expect(Reflect.getMetadata(IDEMPOTENT_KEY, handler)).toBe(true);
    },
  );
});
