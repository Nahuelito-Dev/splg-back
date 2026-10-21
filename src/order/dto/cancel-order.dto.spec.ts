import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CancelOrderDto } from './cancel-order.dto';

const errores = async (cuerpo: object) =>
  (await validate(plainToInstance(CancelOrderDto, cuerpo))).map(
    (e) => e.property,
  );

describe('CancelOrderDto', () => {
  it('sin motivo pasa el DTO (el chofer, que libera el pedido, no lo necesita; el resto lo exige el caso de uso)', async () => {
    expect(await errores({})).toEqual([]);
  });

  it('un motivo en blanco se rechaza', async () => {
    expect(await errores({ reason: '   ' })).toContain('reason');
    expect(await errores({ reason: '' })).toContain('reason');
  });

  it('el motivo se recorta', () => {
    const dto = plainToInstance(CancelOrderDto, {
      reason: '  Cambió de idea ',
    });
    expect(dto.reason).toBe('Cambió de idea');
  });

  it('el motivo no pasa de 500 caracteres', async () => {
    expect(await errores({ reason: 'a'.repeat(501) })).toContain('reason');
    expect(await errores({ reason: 'a'.repeat(500) })).toEqual([]);
  });
});
