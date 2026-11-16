import { plainToInstance } from 'class-transformer';
import { AssignCylindersDto } from './assign-cylinders.dto';
import { TransitionCylinderDto } from './transition-cylinder.dto';

const PEDIDO = 'A1B2C3D4-0000-4000-8000-00000000000E';

describe('orderId de los envases en minúsculas', () => {
  it('la asignación recibe el pedido en minúsculas', () => {
    const dto = plainToInstance(AssignCylindersDto, {
      orderId: PEDIDO,
      serials: ['S-1'],
    });
    expect(dto.orderId).toBe(PEDIDO.toLowerCase());
  });

  it('la transición recibe el pedido en minúsculas', () => {
    const dto = plainToInstance(TransitionCylinderDto, {
      toState: 'with_customer',
      orderId: PEDIDO,
    });
    expect(dto.orderId).toBe(PEDIDO.toLowerCase());
  });
});
