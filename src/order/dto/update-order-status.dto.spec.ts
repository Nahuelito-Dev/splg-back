import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateOrderStatusDto } from './update-order-status.dto';

const errores = async (body: object) =>
  (await validate(plainToInstance(UpdateOrderStatusDto, body))).map(
    (e) => e.property,
  );

describe('UpdateOrderStatusDto.reason', () => {
  it('con delivered, un motivo de más de 500 caracteres es inválido', async () => {
    expect(
      await errores({ status: 'delivered', reason: 'x'.repeat(501) }),
    ).toContain('reason');
  });

  it('con otro estado el motivo se ignora, aunque sea larguísimo', async () => {
    expect(
      await errores({ status: 'accepted', reason: 'x'.repeat(5000) }),
    ).toEqual([]);
  });
});
