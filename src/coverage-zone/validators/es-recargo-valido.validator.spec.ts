import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCoverageZoneDto } from '../dto/create-coverage-zone.dto';
import { UpdateCoverageZoneDto } from '../dto/update-coverage-zone.dto';

async function erroresDeRecargo(
  clase: typeof CreateCoverageZoneDto | typeof UpdateCoverageZoneDto,
  body: object,
): Promise<string[]> {
  const errores = await validate(plainToInstance(clase, body));
  return errores
    .filter((e) => e.property === 'surchargeValue')
    .flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('EsRecargoValido', () => {
  it('editar sólo el monto de una zona fija no se valida como porcentaje', async () => {
    expect(
      await erroresDeRecargo(UpdateCoverageZoneDto, { surchargeValue: 700 }),
    ).toEqual([]);
  });

  it('un porcentaje mayor a 100 se rechaza si el tipo viene en el body', async () => {
    expect(
      await erroresDeRecargo(UpdateCoverageZoneDto, {
        surchargeType: 'percentage',
        surchargeValue: 700,
      }),
    ).toEqual([
      'surchargeValue: un recargo porcentual tiene que estar entre 0 y 100',
    ]);
  });

  it('un monto fijo alto es válido', async () => {
    expect(
      await erroresDeRecargo(UpdateCoverageZoneDto, {
        surchargeType: 'fixed',
        surchargeValue: 700,
      }),
    ).toEqual([]);
  });

  it('un recargo negativo se rechaza aunque no venga el tipo', async () => {
    expect(
      await erroresDeRecargo(UpdateCoverageZoneDto, { surchargeValue: -1 }),
    ).toEqual(['surchargeValue: un recargo no puede ser negativo']);
  });
});
