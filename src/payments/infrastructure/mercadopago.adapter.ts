import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MercadoPagoConfig,
  Preference,
  Payment,
  PaymentRefund,
} from 'mercadopago';
import { WebhookSignatureValidator } from 'mercadopago';

import {
  CreateCheckoutInput,
  CreateCheckoutResult,
  GatewayPayment,
  PaymentGatewayPort,
  RefundPaymentInput,
  RefundPaymentResult,
  VerifyWebhookSignatureInput,
} from '../domain/ports/payment-gateway.port';
import { errorMessage } from '../../common/errors/error-message';

/**
 * Adapter del PaymentGatewayPort sobre el SDK oficial `mercadopago` (Checkout
 * Pro). Único lugar del dominio de pagos que conoce el SDK: el resto del
 * módulo (use-cases, controller) habla contra el puerto.
 */
@Injectable()
export class MercadoPagoAdapter extends PaymentGatewayPort {
  private readonly logger = new Logger(MercadoPagoAdapter.name);
  private readonly client: MercadoPagoConfig;

  constructor(private readonly configService: ConfigService) {
    super();
    this.client = new MercadoPagoConfig({
      accessToken: this.configService.get<string>('MP_ACCESS_TOKEN') || '',
      // Timeout explícito para que una demora de MP no cuelgue el webhook
      // (getPayment) reteniendo conexiones.
      options: { timeout: 5000 },
    });
  }

  async createCheckout(
    input: CreateCheckoutInput,
  ): Promise<CreateCheckoutResult> {
    const preference = await new Preference(this.client).create({
      body: {
        items: input.items.map((item) => ({
          id: item.id,
          title: item.title,
          quantity: item.quantity,
          unit_price: item.unitPrice,
          currency_id: 'ARS',
        })),
        payer: { email: input.payerEmail },
        external_reference: input.orderId,
        notification_url: this.configService.get<string>('MP_NOTIFICATION_URL'),
        back_urls: {
          success: this.configService.get<string>('MP_SUCCESS_URL'),
          failure: this.configService.get<string>('MP_FAILURE_URL'),
          pending: this.configService.get<string>('MP_PENDING_URL'),
        },
        auto_return: 'approved',
      },
    });

    if (!preference.init_point || !preference.id) {
      // No debería ocurrir con un access token válido; lo tratamos como error
      // de infraestructura (el use-case lo deja burbujear como 500).
      throw new Error(
        'MercadoPago no devolvió init_point/id de la preferencia',
      );
    }

    return {
      initPoint: preference.init_point,
      preferenceId: preference.id,
    };
  }

  async getPayment(paymentId: string): Promise<GatewayPayment> {
    const payment = await new Payment(this.client).get({ id: paymentId });
    return {
      id: String(payment.id),
      status: payment.status || 'unknown',
      externalReference: payment.external_reference || null,
      amount: payment.transaction_amount ?? null,
      refundedAmount: payment.transaction_amount_refunded ?? null,
    };
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    const refund = await new PaymentRefund(this.client).create({
      payment_id: input.gatewayPaymentId,
      body: { amount: input.amount },
      requestOptions: { idempotencyKey: input.idempotencyKey },
    });
    if (refund.id === undefined || refund.id === null) {
      throw new Error('MercadoPago no devolvió el id de la devolución');
    }
    return { refundId: String(refund.id) };
  }

  verifyWebhookSignature(input: VerifyWebhookSignatureInput): boolean {
    const secret = this.configService.get<string>('MP_WEBHOOK_SECRET');
    if (!secret) {
      this.logger.warn(
        'MP_WEBHOOK_SECRET no configurado: se rechaza la validación de firma',
      );
      return false;
    }

    try {
      WebhookSignatureValidator.validate({
        xSignature: input.xSignature,
        xRequestId: input.xRequestId,
        dataId: input.dataId,
        secret,
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `Firma de webhook MercadoPago inválida: ${errorMessage(error)}`,
      );
      return false;
    }
  }
}
