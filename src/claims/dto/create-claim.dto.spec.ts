import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { CreateClaimDto } from './create-claim.dto';

const base = {
  orderId: '2c0f7a9e-6f4f-4f55-9d0e-0a5a4d1b7c11',
  customerId: '8f1a5c3e-1f0b-4c52-8a0c-3f6d2e9b4a77',
  reason: 'Fuga',
  description: 'Huele a gas',
};

// El mismo pipe global de `main.ts`.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const meta: ArgumentMetadata = { type: 'body', metatype: CreateClaimDto };

describe('CreateClaimDto: la foto no viaja como texto', () => {
  it('acepta el alta sin foto', async () => {
    await expect(pipe.transform(base, meta)).resolves.toMatchObject(base);
  });

  it.each([
    'https://externa.example/foto.jpg',
    'javascript:alert(1)',
    'no es una url',
  ])('rechaza photoUrl=%s con 400', async (photoUrl) => {
    await expect(
      pipe.transform({ ...base, photoUrl }, meta),
    ).rejects.toMatchObject({
      status: 400,
      response: { message: ['property photoUrl should not exist'] },
    });
  });
});
