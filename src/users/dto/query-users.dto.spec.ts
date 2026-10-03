import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QueryUsersDto } from './query-users.dto';

async function erroresDe(query: Record<string, string>): Promise<string[]> {
  const errores = await validate(plainToInstance(QueryUsersDto, query));
  return errores.map((e) => e.property);
}

describe('QueryUsersDto', () => {
  it.each(['admin', 'super_admin', 'customer', 'delivery'])(
    'acepta role=%s',
    async (role) => {
      expect(await erroresDe({ role })).toEqual([]);
    },
  );

  it('el rol es opcional', async () => {
    expect(await erroresDe({})).toEqual([]);
  });

  it.each(['chofer', 'Admin'])('rechaza role=%s', async (role) => {
    expect(await erroresDe({ role })).toEqual(['role']);
  });
});
