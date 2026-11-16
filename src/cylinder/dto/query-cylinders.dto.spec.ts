import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QueryCylindersDto } from './query-cylinders.dto';

async function erroresDe(query: Record<string, string>): Promise<string[]> {
  const errores = await validate(plainToInstance(QueryCylindersDto, query));
  return errores.map((e) => e.property);
}

describe('QueryCylindersDto', () => {
  const uuid = '9ae32154-0ee4-4310-869f-6a9a29000331';

  it('acepta sin parámetros y con todos', async () => {
    expect(await erroresDe({})).toEqual([]);
    expect(
      await erroresDe({
        state: 'with_customer',
        orderId: uuid,
        customerUserId: uuid,
        limit: '10',
        offset: '0',
      }),
    ).toEqual([]);
  });

  it.each([
    ['state', 'roto'],
    ['orderId', 'abc'],
    ['customerUserId', 'abc'],
    ['limit', '0'],
    ['limit', '101'],
    ['offset', '-1'],
  ])('rechaza %s=%s', async (campo, valor) => {
    expect(await erroresDe({ [campo]: valor })).toEqual([campo]);
  });
});
