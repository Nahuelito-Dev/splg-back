import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  PatchRecoverySettingsDto,
  QueryRecoveryCasesDto,
} from './recovery-request.dto';

const parsear = (query: object) => {
  const dto = plainToInstance(QueryRecoveryCasesDto, query);
  return { dto, errores: validateSync(dto) };
};

describe('QueryRecoveryCasesDto', () => {
  it.each(['live', 'pending'] as const)(
    '%s sólo acepta true o false',
    (campo) => {
      expect(parsear({ [campo]: 'true' }).dto[campo]).toBe(true);
      expect(parsear({ [campo]: 'false' }).dto[campo]).toBe(false);
      expect(parsear({ [campo]: true }).dto[campo]).toBe(true);
      expect(parsear({ [campo]: false }).dto[campo]).toBe(false);
      expect(parsear({ [campo]: 'x' }).errores).not.toHaveLength(0);
    },
  );
});

describe('PatchRecoverySettingsDto: parámetros de riesgo y radio (M5)', () => {
  const errores = (cuerpo: object) =>
    validateSync(plainToInstance(PatchRecoverySettingsDto, cuerpo));

  it.each([
    'toleranceLowRiskPercent',
    'toleranceMediumRiskPercent',
    'toleranceHighRiskPercent',
    'stepLowRiskPercent',
    'stepMediumRiskPercent',
    'stepHighRiskPercent',
  ])(
    '%s acepta de 10 a 300 y rechaza fuera de rango o con decimales',
    (campo) => {
      expect(errores({ [campo]: 10 })).toHaveLength(0);
      expect(errores({ [campo]: 300 })).toHaveLength(0);
      expect(errores({ [campo]: 9 })).not.toHaveLength(0);
      expect(errores({ [campo]: 301 })).not.toHaveLength(0);
      expect(errores({ [campo]: 70.5 })).not.toHaveLength(0);
      expect(errores({ [campo]: '70' })).not.toHaveLength(0);
    },
  );

  it('opportunisticPickupRadiusMeters acepta de 50 a 2000 metros', () => {
    const campo = 'opportunisticPickupRadiusMeters';
    expect(errores({ [campo]: 50 })).toHaveLength(0);
    expect(errores({ [campo]: 2000 })).toHaveLength(0);
    expect(errores({ [campo]: 49 })).not.toHaveLength(0);
    expect(errores({ [campo]: 2001 })).not.toHaveLength(0);
    expect(errores({ [campo]: 300.5 })).not.toHaveLength(0);
  });

  it('todos son opcionales', () => {
    expect(errores({})).toHaveLength(0);
  });
});
