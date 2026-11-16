import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QueryOrdersDto } from './query-orders.dto';
import { OrderStatus, PaymentStatus } from '../entities/order.entity';

const parse = async (query: Record<string, string>) => {
  const dto = plainToInstance(QueryOrdersDto, query);
  return { dto, errors: await validate(dto) };
};

describe('QueryOrdersDto — status', () => {
  it('acepta out_for_delivery, el valor que devuelve la respuesta, y filtra por on_the_way', async () => {
    const { dto, errors } = await parse({ status: 'out_for_delivery' });
    expect(errors).toHaveLength(0);
    expect(dto.status).toBe(OrderStatus.ON_THE_WAY);
  });

  it('sigue aceptando on_the_way', async () => {
    const { dto, errors } = await parse({ status: 'on_the_way' });
    expect(errors).toHaveLength(0);
    expect(dto.status).toBe(OrderStatus.ON_THE_WAY);
  });

  it('rechaza un estado inexistente', async () => {
    const { errors } = await parse({ status: 'en_camino' });
    expect(errors).toHaveLength(1);
  });
});

describe('QueryOrdersDto — paymentStatus', () => {
  it.each(Object.values(PaymentStatus))('acepta %s', async (valor) => {
    const { dto, errors } = await parse({ paymentStatus: valor });
    expect(errors).toHaveLength(0);
    expect(dto.paymentStatus).toBe(valor);
  });

  it('rechaza un estado de pago inexistente', async () => {
    const { errors } = await parse({ paymentStatus: 'debe' });
    expect(errors).toHaveLength(1);
  });
});

describe('QueryOrdersDto — fecha de entrega y orden', () => {
  it('acepta deliveredFrom/deliveredTo, sort y order', async () => {
    const { dto, errors } = await parse({
      deliveredFrom: '2026-09-01',
      deliveredTo: '2026-09-02',
      sort: 'deliveredAt',
      order: 'asc',
    });
    expect(errors).toHaveLength(0);
    expect(dto.sort).toBe('deliveredAt');
    expect(dto.order).toBe('asc');
  });

  it('todo es opcional: sin parámetros no hay errores', async () => {
    const { errors } = await parse({});
    expect(errors).toHaveLength(0);
  });

  it.each([
    ['deliveredFrom', '01/09/2026'],
    ['deliveredTo', '2026-13-40'],
    ['sort', 'total'],
    ['order', 'up'],
  ])('rechaza %s=%s', async (campo, valor) => {
    const { errors } = await parse({ [campo]: valor });
    expect(errors).toHaveLength(1);
  });
});
