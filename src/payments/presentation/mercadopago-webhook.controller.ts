import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/isPublic.decorator';
import { errorMessage } from '../../common/errors/error-message';
import {
  PaymentsService,
  TIPO_ALERTA_DE_FRAUDE,
} from '../application/payments.service';
import { PaymentNotificationInboxService } from '../application/payment-notification-inbox.service';
import {
  EVENTO_PAGO_NOTIFICADO,
  PagoNotificadoEvent,
} from '../domain/events/pago-notificado.event';

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
 * Vive en `payments`, que es quien conoce MercadoPago. Valida la firma, publica el
 * evento y recién cuando se procesó responde 200. Según la documentación de Mercado
 * Pago (webhooks), espera un 200/201 dentro de 22 segundos y, si no lo recibe,
 * reintenta 8 veces: a los 0, 15 y 30 minutos, a las 6 y 48 horas y tres veces más
 * cada 96 horas (https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks).
 * Las respuestas:
 *  - firma inválida (falta, mal formada, no coincide): 401, como los ejemplos del SDK;
 *  - no se pudo verificar la firma o procesar el aviso (base, credencial, pasarela
 *    caída): 503 para que Mercado Pago reintente;
 *  - procesado: 200.
 * Excepción: la alerta de fraude (`stop_delivery_op_wh`) no se reintenta si no se contesta
 * 200/201, así que se guarda cruda en una bandeja de entrada de la base y se contesta 200
 * siempre (se procesa después, con reintentos propios y aviso al admin si fallan).
 * No hay cola en memoria: un aviso que se perdiera con el proceso dejaría un pago
 * cobrado sin aplicar. El procesamiento es idempotente, así que reintentar es
 * inofensivo y, si los 8 intentos se agotan, la conciliación de pedidos pendientes y
 * la de cancelados lo recuperan. Confirmar el pedido es de `order`, que lo escucha.
 * Así `payments` no depende de `order` (que sí depende de `payments`).
 */
@ApiTags('Webhooks')
@SkipThrottle()
@Controller('webhook')
export class MercadoPagoWebhookController {
  private readonly logger = new Logger(MercadoPagoWebhookController.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly eventos: EventEmitter2,
    private readonly bandeja: PaymentNotificationInboxService,
  ) {}

  @Public()
  @Post('mercadopago')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Webhook de notificaciones de pago de MercadoPago' })
  async handle(
    @Query() query: Record<string, unknown>,
    @Body() cuerpo: Record<string, unknown> | undefined,
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

    // Con cuenta propia, la `notification_url` del checkout trae la credencial
    // (`?account=<id>`): elige el secreto de la firma y el token con que se consulta
    // el pago. Sin ella, la cuenta del entorno.
    const credentialId = idDeCredencial(query['account']);

    const firma = await this.paymentsService.verifyWebhookSignature({
      xSignature,
      xRequestId,
      dataId,
      credentialId,
    });

    if (firma === 'no_verificable') {
      // No es culpa de quien avisó (base o credencial caídas): que reintente.
      this.logger.error(
        `No se pudo verificar la firma del webhook MercadoPago (type=${type}, dataId=${dataId}): se pide reintento`,
      );
      throw new ServiceUnavailableException(
        'No se pudo verificar la notificación',
      );
    }
    if (firma === 'invalida') {
      this.logger.warn(
        `Firma inválida en webhook MercadoPago (type=${type}, dataId=${dataId})`,
      );
      throw new UnauthorizedException('Firma inválida');
    }

    // La alerta de fraude trae el pago en `data.payment_id` del cuerpo; el `data.id`
    // de la URL (el de la firma) es el del aviso.
    const idDelRecurso =
      type === TIPO_ALERTA_DE_FRAUDE
        ? (texto(anidado(cuerpo?.['data'], 'payment_id')) ??
          numero(anidado(cuerpo?.['data'], 'payment_id')) ??
          dataId)
        : dataId;

    // La alerta de fraude NO se reintenta si no se contesta 200/201 (doc, «Fraud
    // alerts»): con la firma válida se guarda cruda en la bandeja de entrada, se
    // contesta 200 siempre y se la procesa después con reintentos propios. Sólo si ni
    // siquiera se puede guardar (base caída) se contesta 503: no hay otra cosa que hacer.
    if (type === TIPO_ALERTA_DE_FRAUDE) {
      try {
        await this.bandeja.guardar({
          type,
          dataId: idDelRecurso ?? '',
          credentialId,
          rawBody: cuerpo ?? null,
        });
      } catch (error) {
        this.logger.error(
          `Alerta ${type}:${idDelRecurso} sin guardar, no se puede contestar 200: ${errorMessage(error)}`,
        );
        throw new ServiceUnavailableException('Notificación sin guardar');
      }
      this.bandeja.procesarEnSegundoPlano();
      return { received: true };
    }

    try {
      await this.eventos.emitAsync(
        EVENTO_PAGO_NOTIFICADO,
        new PagoNotificadoEvent(
          type,
          idDelRecurso,
          xSignature,
          xRequestId,
          credentialId,
        ),
      );
    } catch (error) {
      this.logger.error(
        `Webhook ${type}:${dataId} sin procesar, se pide reintento a Mercado Pago: ${errorMessage(error)}`,
      );
      throw new ServiceUnavailableException('Notificación sin procesar');
    }

    return { received: true };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idDeCredencial(valor: unknown): string | undefined {
  return typeof valor === 'string' && UUID.test(valor) ? valor : undefined;
}

function texto(valor: unknown): string | undefined {
  return typeof valor === 'string' ? valor : undefined;
}

function anidado(valor: unknown, clave: string): unknown {
  return typeof valor === 'object' && valor !== null
    ? (valor as Record<string, unknown>)[clave]
    : undefined;
}

function numero(valor: unknown): string | undefined {
  return typeof valor === 'number' && Number.isFinite(valor)
    ? String(valor)
    : undefined;
}
