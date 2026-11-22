import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { crearValidationPipe } from '../../common/validation/validation-pipe';
import { ConfirmDeliveryV3Dto } from './confirm-delivery-v3.dto';

/**
 * El DTO del v3 NO valida el formato del código: si lo hiciera, el 400 saldría
 * del ValidationPipe sin `code` y la app del chofer no podría distinguir
 * `DELIVERY_CODE_FORMATO`. El formato (y que no cuente como intento) lo prueba
 * `confirm-delivery-v3.use-case.spec.ts`. Sí valida tipos y rangos de la
 * ubicación, y rechaza campos de más.
 */
describe('ConfirmDeliveryV3Dto (ValidationPipe de la API)', () => {
  const pipe = crearValidationPipe();
  const meta: ArgumentMetadata = {
    type: 'body',
    metatype: ConfirmDeliveryV3Dto,
  };
  const validar = (body: unknown) =>
    pipe.transform(body, meta) as Promise<ConfirmDeliveryV3Dto>;

  it.each(['4829', '48291a', '', '1234567'])(
    'el código %p pasa el DTO (el caso de uso responde DELIVERY_CODE_FORMATO)',
    async (code) => {
      await expect(
        validar({ code, latitude: -27.3, longitude: -55.8 }),
      ).resolves.toMatchObject({ code });
    },
  );

  it('null en el código y en la ubicación pasa el DTO (el caso de uso responde VALIDATION)', async () => {
    await expect(
      validar({ code: null, latitude: null, longitude: null }),
    ).resolves.toBeDefined();
  });

  it('la ubicación fuera de rango la frena el DTO', async () => {
    await expect(
      validar({ code: '482913', latitude: 95, longitude: -55.8 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('un campo de más se rechaza', async () => {
    await expect(
      validar({ code: '482913', latitude: -27.3, longitude: -55.8, x: 1 }),
    ).rejects.toThrow(BadRequestException);
  });
});
