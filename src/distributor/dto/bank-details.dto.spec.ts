import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BankDetailsDto } from './bank-details.dto';

async function errores(plano: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(BankDetailsDto, plano);
  const res = await validate(dto);
  return res.map((e) => e.property).sort();
}

describe('BankDetailsDto', () => {
  it('acepta CBU válido, alias y titular', async () => {
    await expect(
      errores({
        cbu: '0170099220000067797370',
        alias: 'garrafas.splg',
        holder: 'Distribuidora Demo',
      }),
    ).resolves.toEqual([]);
  });

  it('todo es opcional: vacío, null o espacios equivalen a "sin dato"', async () => {
    await expect(errores({})).resolves.toEqual([]);
    await expect(
      errores({ cbu: null, alias: '', holder: '   ' }),
    ).resolves.toEqual([]);
    const dto = plainToInstance(BankDetailsDto, { alias: '', holder: '  ' });
    expect(dto.alias).toBeNull();
    expect(dto.holder).toBeNull();
  });

  it.each([
    ['CBU con verificador malo', { cbu: '0170099220000067797371' }, 'cbu'],
    ['CBU corto', { cbu: '017009922000006779737' }, 'cbu'],
    ['CBU con letras', { cbu: '01700992200000677973ab' }, 'cbu'],
    ['CBU numérico', { cbu: 1700992200000 }, 'cbu'],
    ['alias corto', { alias: 'corto' }, 'alias'],
    ['alias largo', { alias: 'a'.repeat(21) }, 'alias'],
    ['alias con espacio', { alias: 'mi alias' }, 'alias'],
    ['titular de 1 letra', { holder: 'A' }, 'holder'],
    ['titular de 121 letras', { holder: 'A'.repeat(121) }, 'holder'],
  ])('rechaza %s', async (_caso, plano, campo) => {
    await expect(errores(plano)).resolves.toEqual([campo]);
  });

  it('el CBU se valida tal cual vino (sin guiones ni espacios, 22 dígitos)', async () => {
    await expect(errores({ cbu: '01700992 20000067797370' })).resolves.toEqual([
      'cbu',
    ]);
  });
});
