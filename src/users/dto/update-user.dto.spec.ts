import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateUserDto } from './update-user.dto';

const invalidas = async (cuerpo: object): Promise<string[]> =>
  (await validate(plainToInstance(UpdateUserDto, cuerpo))).map(
    (e) => e.property,
  );

describe('UpdateUserDto: phone_number', () => {
  it.each(['+5493764000000', '+12025550123'])(
    '%s (E.164) pasa',
    async (tel) => {
      expect(await invalidas({ phone_number: tel })).toEqual([]);
    },
  );

  it.each(['3764000000', '+0123456789', '+54 9 376 4000000', '+54', 'abc'])(
    '%s no es E.164 (400)',
    async (tel) => {
      expect(await invalidas({ phone_number: tel })).toContain('phone_number');
    },
  );

  it('sin teléfono es válido', async () => {
    expect(await invalidas({ full_name: 'Ana Pérez' })).toEqual([]);
  });
});
