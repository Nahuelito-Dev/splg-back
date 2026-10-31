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
import {
  MercadoPagoCredentialsService,
  ResolvedMercadoPagoCredentials,
} from '../../distributor/mercadopago-credentials.service';

/**
 * Adapter del PaymentGatewayPort sobre el SDK oficial `mercadopago` (Checkout
 * Pro). Único lugar del dominio de pagos que conoce el SDK: el resto del
 * módulo (use-cases, controller) habla contra el puerto.
 *
 * La cuenta de Mercado Pago se elige en cada llamada: la propia de la
 * distribuidora si la cargó, y si no la del entorno (`MP_ACCESS_TOKEN`).
 */
@Injectable()
export class MercadoPagoAdapter extends PaymentGatewayPort {
  private readonly logger = new Logger(MercadoPagoAdapter.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly credentials: MercadoPagoCredentialsService,
  ) {
    super();
  }

  private systemAccount(): { accessToken: string; webhookSecret: string } {
    return {
      accessToken: this.configService.get<string>('MP_ACCESS_TOKEN') || '',
      webhookSecret: this.configService.get<string>('MP_WEBHOOK_SECRET') || '',
    };
  }

  /** La cuenta vigente de la distribuidora (para armar un checkout nuevo). */
  private resolveCredentials(
    distributorId?: string | null,
  ): Promise<ResolvedMercadoPagoCredentials> {
    return this.credentials.resolve(distributorId, this.systemAccount());
  }

  /** La cuenta con la que ya se cobró un pago, aunque después se la haya desactivado. */
  private resolveAccount(
    credentialId?: string | null,
  ): Promise<ResolvedMercadoPagoCredentials> {
    return this.credentials.resolveById(credentialId, this.systemAccount());
  }

  private clientFor(accessToken: string): MercadoPagoConfig {
    return new MercadoPagoConfig({
      accessToken,
      // Timeout explícito para que una demora de MP no cuelgue el webhook
      // (getPayment) reteniendo conexiones.
      options: { timeout: 5000 },
    });
  }

  async createCheckout(
    input: CreateCheckoutInput,
  ): Promise<CreateCheckoutResult> {
    const cuenta = await this.resolveCredentials(input.distributorId);
    const preference = await new Preference(
      this.clientFor(cuenta.accessToken),
    ).create({
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
        notification_url: this.notificationUrl(cuenta.credentialId),
        back_urls: {
          success: this.configService.get<string>('MP_SUCCESS_URL'),
          failure: this.configService.get<string>('MP_FAILURE_URL'),
          pending: this.configService.get<string>('MP_PENDING_URL'),
        },
        auto_return: 'approved',
        ...(input.expiresAt && {
          expires: true,
          expiration_date_from: fechaDeMercadoPago(new Date()),
          expiration_date_to: fechaDeMercadoPago(input.expiresAt),
        }),
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
      credentialId: cuenta.credentialId,
    };
  }

  async getPayment(
    paymentId: string,
    credentialId?: string | null,
  ): Promise<GatewayPayment> {
    const cuenta = await this.resolveAccount(credentialId);
    const payment = await new Payment(this.clientFor(cuenta.accessToken)).get({
      id: paymentId,
    });
    return {
      id: String(payment.id),
      status: payment.status || 'unknown',
      externalReference: payment.external_reference || null,
      amount: payment.transaction_amount ?? null,
      refundedAmount: payment.transaction_amount_refunded ?? null,
      feeAmount: comisionDelCobro(payment),
      accountDistributorId: cuenta.distributorId,
    };
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    const cuenta = await this.resolveAccount(input.credentialId);
    const refund = await new PaymentRefund(
      this.clientFor(cuenta.accessToken),
    ).create({
      payment_id: input.gatewayPaymentId,
      body: { amount: input.amount },
      requestOptions: { idempotencyKey: input.idempotencyKey },
    });
    if (refund.id === undefined || refund.id === null) {
      throw new Error('MercadoPago no devolvió el id de la devolución');
    }
    return { refundId: String(refund.id) };
  }

  async verifyWebhookSignature(
    input: VerifyWebhookSignatureInput,
  ): Promise<boolean> {
    let secret: string;
    try {
      secret = (await this.resolveAccount(input.credentialId)).webhookSecret;
    } catch (error) {
      this.logger.warn(
        `No se pudo resolver el secreto del webhook: ${errorMessage(error)}`,
      );
      return false;
    }
    if (!secret) {
      this.logger.warn(
        'Secreto de webhook de MercadoPago no configurado: se rechaza la validación de firma',
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

  /**
   * URL a la que Mercado Pago avisa los pagos. Con cuenta propia lleva
   * `?account=<id de la credencial>`: el webhook lo usa para elegir el secreto
   * con el que valida la firma y el token con el que consulta el pago. Sin
   * cuenta propia es la URL del entorno, como siempre.
   */
  private notificationUrl(credentialId: string | null): string | undefined {
    const base = this.configService.get<string>('MP_NOTIFICATION_URL');
    if (!base || !credentialId) return base;
    const url = new URL(base);
    url.searchParams.set('account', credentialId);
    return url.toString();
  }
}

/** Fecha en el formato que pide Mercado Pago, con el huso de Argentina (UTC-3 todo el año). */
export function fechaDeMercadoPago(fecha: Date): string {
  const local = new Date(fecha.getTime() - 3 * 3600 * 1000);
  return local.toISOString().replace('Z', '-03:00');
}

/** Lo que el comercio no llega a recibir de un pago: el bruto menos el neto que informa la pasarela, o los cargos que absorbe él. */
function comisionDelCobro(payment: {
  transaction_amount?: number;
  transaction_details?: { net_received_amount?: number };
  fee_details?: Array<{ amount?: number; fee_payer?: string }>;
}): number | null {
  const bruto = payment.transaction_amount;
  const neto = payment.transaction_details?.net_received_amount;
  if (bruto != null && neto != null && neto > 0) {
    return Math.max(0, Math.round((bruto - neto) * 100) / 100);
  }
  const cargos = payment.fee_details?.filter((f) => f.fee_payer !== 'payer');
  if (!cargos?.length) return null;
  return (
    Math.round(cargos.reduce((a, f) => a + (f.amount ?? 0), 0) * 100) / 100
  );
}
