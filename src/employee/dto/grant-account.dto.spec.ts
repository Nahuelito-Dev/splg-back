import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GrantEmployeeAccountDto } from './grant-account.dto';

const invalidas = async (cuerpo: object): Promise<string[]> =>
  (
    await validate(
      plainToInstance(GrantEmployeeAccountDto, {
        email: 'ana@correo.com',
        password: 'Ejemplo2026x',
        ...cuerpo,
      }),
    )
  ).map((e) => e.property);

describe('GrantEmployeeAccountDto: password (política)', () => {
  it('una clave que cumple pasa', async () => {
    expect(await invalidas({})).toEqual([]);
  });

  it.each(['Abcde12', 'abcdef12', 'Abcdefgh', 'ABCDEF12', 'Test1234'])(
    '%s es 400',
    async (password) => {
      expect(await invalidas({ password })).toEqual(['password']);
    },
  );
});
