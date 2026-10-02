import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaginationDto } from './pagination.dto';

async function erroresDe(query: Record<string, string>): Promise<string[]> {
  const errores = await validate(plainToInstance(PaginationDto, query));
  return errores.map((e) => e.property);
}

describe('PaginationDto', () => {
  it('acepta limit y offset enteros', async () => {
    expect(await erroresDe({ limit: '10', offset: '0' })).toEqual([]);
    expect(await erroresDe({})).toEqual([]);
  });

  it.each(['abc', '-1', '1.5'])('rechaza offset=%s', async (offset) => {
    expect(await erroresDe({ offset })).toEqual(['offset']);
  });

  it.each(['abc', '0', '-3', '2.5', '101'])(
    'rechaza limit=%s',
    async (limit) => {
      expect(await erroresDe({ limit })).toEqual(['limit']);
    },
  );
});
