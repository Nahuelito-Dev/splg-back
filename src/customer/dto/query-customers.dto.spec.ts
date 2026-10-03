import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QueryCustomersDto } from './query-customers.dto';

async function erroresDe(query: Record<string, string>): Promise<string[]> {
  const errores = await validate(plainToInstance(QueryCustomersDto, query));
  return errores.map((e) => e.property);
}

describe('QueryCustomersDto', () => {
  it.each(['active', 'blocked'])('acepta status=%s', async (status) => {
    expect(await erroresDe({ status })).toEqual([]);
  });

  it('el status es opcional', async () => {
    expect(await erroresDe({})).toEqual([]);
  });

  it.each(['deleted', 'ACTIVE', ''])('rechaza status=%s', async (status) => {
    expect(await erroresDe({ status })).toEqual(['status']);
  });
});
