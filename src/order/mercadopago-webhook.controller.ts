import { Controller, Post, Query, Headers, HttpCode, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiExcludeEndpoint } from '@nestjs/swagger';
import { Public } from '../common/decorators/isPublic.decorator';
import { PaymentsService } from '../payments/application/payments.service';
import { ConfirmPaymentUseCase } from './application/confirm-payment.use-case';

/**
 * Endpoint receptor REAL de notificaciones de MercadoPago (Checkout Pro).
 * Lo llama MercadoPago, no un usuario autenticado: por eso es `@Public()` y
 * NO se protege por rol (ver nota en webhook/webhook.controller.ts).
 *
 * Base path `webhook` para coincidir con `MP_NOTIFICATION_URL` (ej.
 * `.../api/webhook/mercadopago`). Vive en el módulo `order` (no en el CRUD
 * administrativo `WebhookModule`) porque su única responsabilidad es
 * confirmar pagos de pedidos.
 */
@ApiTags('Webhooks')
@Controller('webhook')
export class MercadoPagoWebhookController {
  private readonly logger = new Logger(MercadoPagoWebhookController.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly confirmPayment: ConfirmPaymentUseCase,
  ) {}

  @Public()
  @Post('mercadopago')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Webhook de notificaciones de pago de MercadoPago' })
  async handle(
    @Query() query: Record<string, string>,
    @Headers('x-signature') xSignature?: string,
    @Headers('x-request-id') xRequestId?: string,
  ): Promise<{ received: true }> {
    // MercadoPago manda `data.id` como query param plano (no anidado); algunas
    // integraciones viejas mandan `id`/`topic`. Cubrimos ambos formatos.
    const dataId = query['data.id'] ?? (query as any).data?.id ?? query.id;
    const type = query.type ?? query.topic;

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
      await this.confirmPayment.execute({
        type,
        dataId,
        xSignature,
        xRequestId,
      });
    } catch (error: any) {
      // Nunca dejamos que un error interno haga que MP reintente en loop con
      // un 5xx: logueamos y respondemos 200 de todas formas.
      this.logger.error(`Error procesando webhook MercadoPago: ${error?.message}`);
    }

    return { received: true };
  }
}
