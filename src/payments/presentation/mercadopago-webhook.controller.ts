import {
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/isPublic.decorator';
import { PaymentsService } from '../application/payments.service';
import {
  EVENTO_PAGO_NOTIFICADO,
  PagoNotificadoEvent,
} from '../domain/events/pago-notificado.event';
import { errorMessage } from '../../common/errors/error-message';

/**
 * Endpoint receptor REAL de notificaciones de MercadoPago (Checkout Pro).
 * Lo llama MercadoPago, no un usuario autenticado: por eso es `@Public()` y
 * NO se protege por rol.
 *
 * `@SkipThrottle()`: MP puede reintentar notificaciones en ráfaga (varios
 * pedidos pagándose a la vez) y NO es tráfico de un usuario final — no debe
 * competir con el rate limit global ni el de login.
 *
 * Base path `webhook` para coincidir con `MP_NOTIFICATION_URL` (ej.
 * `.../api/webhook/mercadopago`).
 *
 * Vive en `payments`, que es quien conoce MercadoPago. Valida la firma y
 * publica el evento; confirmar el pedido es de `order`, que lo escucha. Así
 * `payments` no depende de `order` (que sí depende de `payments`).
 */
@ApiTags('Webhooks')
@SkipThrottle()
@Controller('webhook')
export class MercadoPagoWebhookController {
  private readonly logger = new Logger(MercadoPagoWebhookController.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly eventos: EventEmitter2,
  ) {}

  @Public()
  @Post('mercadopago')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Webhook de notificaciones de pago de MercadoPago' })
  async handle(
    @Query() query: Record<string, unknown>,
    @Headers('x-signature') xSignature?: string,
    @Headers('x-request-id') xRequestId?: string,
  ): Promise<{ received: true }> {
    // MercadoPago manda `data.id` como query param plano (no anidado); algunas
    // integraciones viejas mandan `id`/`topic`. Cubrimos ambos formatos.
    const dataId =
      texto(query['data.id']) ??
      texto(anidado(query['data'], 'id')) ??
      texto(query['id']);
    const type = texto(query['type']) ?? texto(query['topic']);

    const isValidSignature = this.paymentsService.verifyWebhookSignature({
      xSignature,
      xRequestId,
      dataId,
    });

    if (!isValidSignature) {
      // Respondemos 200 igual (no revelamos si el pedido/pago existe), pero
      // NO procesamos la notificación.
      this.logger.warn(
        `Firma inválida en webhook MercadoPago (type=${type}, dataId=${dataId})`,
      );
      return { received: true };
    }

    try {
      // emitAsync espera a quien escucha: el webhook responde recién cuando el
      // pago quedó procesado, igual que cuando llamaba al caso de uso directo.
      await this.eventos.emitAsync(
        EVENTO_PAGO_NOTIFICADO,
        new PagoNotificadoEvent(type, dataId, xSignature, xRequestId),
      );
    } catch (error) {
      // Nunca dejamos que un error interno haga que MP reintente en loop con
      // un 5xx: logueamos y respondemos 200 de todas formas.
      this.logger.error(
        `Error procesando webhook MercadoPago: ${errorMessage(error)}`,
      );
    }

    return { received: true };
  }
}

function texto(valor: unknown): string | undefined {
  return typeof valor === 'string' ? valor : undefined;
}

function anidado(valor: unknown, clave: string): unknown {
  return typeof valor === 'object' && valor !== null
    ? (valor as Record<string, unknown>)[clave]
    : undefined;
}
