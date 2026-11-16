import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateDistributorDto } from './create-distributor.dto';

const base = { name: 'Distribuidora Demo', slug: 'demo' };

const invalidas = async (cuerpo: object): Promise<string[]> =>
  (await validate(plainToInstance(CreateDistributorDto, cuerpo))).map(
    (e) => e.property,
  );

describe('CreateDistributorDto: tax_id', () => {
  it('sin CUIT es válido', async () => {
    expect(await invalidas(base)).toEqual([]);
  });

  it.each(['30-12345678-9', '30 12345678 9', '30123456789'])(
    '%s se acepta y se guarda sólo con los 11 dígitos',
    async (cuit) => {
      const dto = plainToInstance(CreateDistributorDto, {
        ...base,
        tax_id: cuit,
      });
      expect(await validate(dto)).toEqual([]);
      expect(dto.tax_id).toBe('30123456789');
    },
  );

  it.each(['3012345678', '301234567890', '30-1234567A-9', 'abc'])(
    '%s es 400 (no son 11 dígitos)',
    async (cuit) => {
      expect(await invalidas({ ...base, tax_id: cuit })).toContain('tax_id');
    },
  );
});
