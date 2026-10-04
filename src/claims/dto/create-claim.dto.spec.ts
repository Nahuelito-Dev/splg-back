import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateClaimDto } from './create-claim.dto';

async function erroresDe(photoUrl?: string): Promise<string[]> {
  const dto = plainToInstance(CreateClaimDto, {
    orderId: '2c0f7a9e-6f4f-4f55-9d0e-0a5a4d1b7c11',
    customerId: '8f1a5c3e-1f0b-4c52-8a0c-3f6d2e9b4a77',
    reason: 'Fuga',
    description: 'Huele a gas',
    photoUrl,
  });
  return (await validate(dto)).map((e) => e.property);
}

describe('CreateClaimDto.photoUrl', () => {
  it.each([undefined, 'https://externa.example/foto.jpg', 'http://a.io/x.png'])(
    'acepta %s',
    async (url) => {
      expect(await erroresDe(url)).toEqual([]);
    },
  );

  it.each(['javascript:alert(1)', 'no es una url', 'ftp://x.io/f.jpg'])(
    'rechaza %s',
    async (url) => {
      expect(await erroresDe(url)).toEqual(['photoUrl']);
    },
  );
});
