import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AcceptInvitationDto } from '../../repurchase-forecast/dto/accept-invitation.dto';
import { CreateOrderDto } from './create-order.dto';
import { ExpressPurchaseDto } from './express.dto';
import { UpdateOrderDto } from './update-order.dto';

const pipe = new ValidationPipe({ transform: true, whitelist: true });

const validar = (
  metatype: new () => object,
  paymentMethod: string,
): Promise<{ paymentMethod?: string }> =>
  pipe.transform({ paymentMethod }, { type: 'body', metatype }) as Promise<{
    paymentMethod?: string;
  }>;

const DTOS = [
  ['alta de pedido (y reserva con seña)', CreateOrderDto],
  ['compra express', ExpressPurchaseDto],
  ['edición / cambio de medio de pago', UpdateOrderDto],
  ['aceptar recompra', AcceptInvitationDto],
] as const;

describe('Medio de pago en los DTO de entrada', () => {
  it.each(DTOS)(
    '%s: transfer es 400 PAYMENT_METHOD_NOT_ACCEPTED',
    async (_nombre, metatype) => {
      const error: unknown = await validar(metatype, 'transfer').catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        statusCode: 400,
        code: 'PAYMENT_METHOD_NOT_ACCEPTED',
        message:
          'La distribuidora ya no acepta transferencias. Elegí efectivo o Mercado Pago.',
      });
    },
  );

  it.each(
    DTOS.filter(([, m]) => m === UpdateOrderDto || m === AcceptInvitationDto),
  )(
    '%s: cash y mercadopago pasan la validación del medio',
    async (_nombre, metatype) => {
      for (const medio of ['cash', 'mercadopago']) {
        const r = await validar(metatype, medio);
        expect(r.paymentMethod).toBe(medio);
      }
    },
  );
});
