import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateContainerAdjustmentDto } from './create-container-adjustment.dto';

describe('CreateContainerAdjustmentDto', () => {
  const valido = {
    gasCylinderId: '11111111-1111-4111-8111-111111111111',
    quantity: 1,
    note: 'Ajuste manual válido',
  };

  it('recorta la nota antes de validar su largo', async () => {
    const dto = plainToInstance(CreateContainerAdjustmentDto, {
      ...valido,
      note: '  Ajuste manual válido  ',
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.note).toBe('Ajuste manual válido');
  });

  it('rechaza una nota que queda corta al quitar espacios de los extremos', async () => {
    const dto = plainToInstance(CreateContainerAdjustmentDto, {
      ...valido,
      note: '  corta  ',
    });

    await expect(validate(dto)).resolves.not.toEqual([]);
  });
});
