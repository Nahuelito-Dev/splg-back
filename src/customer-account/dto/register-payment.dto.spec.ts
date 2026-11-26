import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { RegisterPaymentDto } from './customer-account.dto';

describe('RegisterPaymentDto: medio con que paga el cliente', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true });
  const validar = (method: string) =>
    pipe.transform(
      { amount: 100, method },
      { type: 'body', metatype: RegisterPaymentDto },
    );

  it.each(['cash', 'card', 'mercadopago', 'check'])(
    'acepta %s',
    async (method) => {
      await expect(validar(method)).resolves.toMatchObject({ method });
    },
  );

  it('la transferencia ya no se acepta: 400 PAYMENT_METHOD_NOT_ACCEPTED', async () => {
    const error: unknown = await validar('transfer').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      statusCode: 400,
      code: 'PAYMENT_METHOD_NOT_ACCEPTED',
    });
  });
});
