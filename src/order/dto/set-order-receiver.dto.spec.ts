import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SetOrderReceiverDto } from './set-order-receiver.dto';

describe('SetOrderReceiverDto (CU-128)', () => {
  const armar = (over: Record<string, unknown> = {}) =>
    plainToInstance(SetOrderReceiverDto, {
      receiverName: 'María Gómez',
      receiverDocument: '30123456',
      receiverRelationship: 'vecina',
      ...over,
    });

  it('acepta un DNI y lo guarda sin puntos ni espacios', async () => {
    const dto = armar({ receiverDocument: ' 30.123.456 ' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.receiverDocument).toBe('30123456');
  });

  it('acepta CUIT con guiones y pasaporte alfanumérico en mayúsculas', async () => {
    const cuit = armar({ receiverDocument: '20-30123456-7' });
    expect(await validate(cuit)).toHaveLength(0);
    expect(cuit.receiverDocument).toBe('20301234567');
    const pasaporte = armar({ receiverDocument: 'aab123456' });
    expect(await validate(pasaporte)).toHaveLength(0);
    expect(pasaporte.receiverDocument).toBe('AAB123456');
  });

  it.each(['', '123', 'ABCDEFG', '1234 5678 9012 3456 78', '30123456!'])(
    'rechaza el documento %p',
    async (documento) => {
      const errores = await validate(armar({ receiverDocument: documento }));
      expect(JSON.stringify(errores)).toContain('receiverDocument');
    },
  );

  it('rechaza nombre o relación vacíos y demasiado largos', async () => {
    expect(await validate(armar({ receiverName: '   ' }))).not.toHaveLength(0);
    expect(
      await validate(armar({ receiverName: 'x'.repeat(121) })),
    ).not.toHaveLength(0);
    expect(
      await validate(armar({ receiverRelationship: '' })),
    ).not.toHaveLength(0);
    expect(
      await validate(armar({ receiverRelationship: 'x'.repeat(41) })),
    ).not.toHaveLength(0);
  });
});
