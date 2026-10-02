import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCarDto } from './create-car.dto';
import { UpdateCarDto } from './update-car.dto';

const UID = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';

async function validar<T extends object>(
  clase: new () => T,
  datos: object,
): Promise<{ errores: string[]; dto: T }> {
  const dto = plainToInstance(clase, datos);
  const errores = (await validate(dto)).map((e) => e.property);
  return { errores, dto };
}

describe('car_patent en los DTO de vehículo', () => {
  it('se normaliza ANTES de validar: "ab 12-3" son 5 caracteres válidos', async () => {
    const { errores, dto } = await validar(CreateCarDto, {
      user_id: UID,
      car_patent: 'ab 12-3',
    });
    expect(errores).toEqual([]);
    expect(dto.car_patent).toBe('AB123');
  });

  it.each(['----', 'a - b', '   ', '', 'ab1', 'ab 1', 'ab$123'])(
    'rechaza %p (menos de 4 alfanuméricos al normalizar, o con símbolos)',
    async (patente) => {
      const { errores } = await validar(CreateCarDto, {
        user_id: UID,
        car_patent: patente,
      });
      expect(errores).toContain('car_patent');
    },
  );

  it('al editar, null es válido (borra la patente) y se conserva como null', async () => {
    const { errores, dto } = await validar(UpdateCarDto, { car_patent: null });
    expect(errores).toEqual([]);
    expect(dto.car_patent).toBeNull();
  });

  it('al editar, no mandarla es válido', async () => {
    const { errores } = await validar(UpdateCarDto, {});
    expect(errores).toEqual([]);
  });
});
