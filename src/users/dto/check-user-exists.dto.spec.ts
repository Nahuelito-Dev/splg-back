import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CheckUserExistsDto } from './check-user-exists.dto';

async function erroresDe(cuerpo: Record<string, unknown>): Promise<string[]> {
  const errores = await validate(plainToInstance(CheckUserExistsDto, cuerpo));
  return errores.map((e) => e.property).sort();
}

describe('CheckUserExistsDto', () => {
  it.each([
    [{ email: 'a@splg.com' }],
    [{ phoneNumber: '+5491101234567' }],
    [{ email: 'a@splg.com', phoneNumber: '+5491101234567' }],
  ])('acepta %j', async (cuerpo) => {
    expect(await erroresDe(cuerpo)).toEqual([]);
  });

  it.each([
    [{}, ['email', 'phoneNumber']],
    [{ email: 'no', phoneNumber: 'basura' }, ['email', 'phoneNumber']],
    [{ email: 5, phoneNumber: 5 }, ['email', 'phoneNumber']],
    [{ email: 5 }, ['email']],
    [{ phoneNumber: 5 }, ['phoneNumber']],
    [{ email: 'a@splg.com', phoneNumber: 'basura' }, ['phoneNumber']],
    [{ email: 'no', phoneNumber: '+5491101234567' }, ['email']],
  ])('rechaza %j (campos: %j)', async (cuerpo, campos) => {
    expect(await erroresDe(cuerpo)).toEqual(campos);
  });
});
