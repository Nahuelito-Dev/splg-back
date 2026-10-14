import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateOrderDto } from './update-order.dto';

describe('UpdateOrderDto', () => {
  const garrafa = '10e14b11-96b4-4f07-9842-be866d77af56';

  it('rechaza la misma garrafa en dos renglones', async () => {
    const dto = plainToInstance(UpdateOrderDto, {
      items: [
        { gasCylinderId: garrafa, quantity: 1 },
        { gasCylinderId: garrafa, quantity: 2 },
      ],
    });
    const errores = await validate(dto);
    expect(JSON.stringify(errores)).toContain(
      'items no puede repetir la misma garrafa',
    );
  });

  it('acepta renglones distintos', async () => {
    const dto = plainToInstance(UpdateOrderDto, {
      items: [{ gasCylinderId: garrafa, quantity: 1 }],
    });
    expect(await validate(dto)).toHaveLength(0);
  });
});
