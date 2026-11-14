import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SetOwnedByPlatformDto } from './platform-companies.dto';

describe('SetOwnedByPlatformDto', () => {
  async function campos(cuerpo: Record<string, unknown>) {
    const errores = await validate(
      plainToInstance(SetOwnedByPlatformDto, cuerpo),
    );
    return errores.map((e) => e.property);
  }

  it('acepta true y false', async () => {
    expect(await campos({ ownedByPlatform: true })).toEqual([]);
    expect(await campos({ ownedByPlatform: false })).toEqual([]);
  });

  it.each([
    ['falta la marca', {}],
    ['la marca es texto', { ownedByPlatform: 'true' }],
  ])('%s → inválido', async (_caso, cuerpo) => {
    expect(await campos(cuerpo)).toEqual(['ownedByPlatform']);
  });
});
