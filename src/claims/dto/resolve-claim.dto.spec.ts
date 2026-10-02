import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ResolveClaimDto } from './resolve-claim.dto';

async function erroresDe(status: string): Promise<string[]> {
  const dto = plainToInstance(ResolveClaimDto, { resolution: 'ok', status });
  const errores = await validate(dto);
  return errores.map((e) => e.property);
}

describe('ResolveClaimDto', () => {
  it.each(['resolved', 'rejected'])('acepta el destino final %s', async (s) => {
    expect(await erroresDe(s)).toEqual([]);
  });

  it.each(['in_process', 'pending', 'otro'])(
    'rechaza %s: tomar un reclamo es PATCH /claims/:id/take',
    async (s) => {
      expect(await erroresDe(s)).toEqual(['status']);
    },
  );
});
