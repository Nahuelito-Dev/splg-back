import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MercadoPagoConfig,
  Preference,
  Payment,
  PaymentRefund,
} from 'mercadopago';
import { WebhookSignatureValidator } from 'mercadopago';
import type { PreferenceRequest } from 'mercadopago/dist/clients/preference/commonTypes';

import {
  CheckoutAddress,
  CheckoutPayer,
  CreateCheckoutInput,
  CreateCheckoutResult,
  GatewayChargeback,
  GatewayPayment,
  PaymentGatewayPort,
  RefundPaymentInput,
  ResultadoDeFirma,
  RefundPaymentResult,
  VerifyWebhookSignatureInput,
} from '../domain/ports/payment-gateway.port';
import { normalizarDetalleDelEstado } from '../domain/payment-status.machine';
import { errorMessage } from '../../common/errors/error-message';
import {
  MercadoPagoCredentialsService,
  ResolvedMercadoPagoCredentials,
} from '../../distributor/mercadopago-credentials.service';

/**
 * Categoría de los renglones: la de MP que mejor describe el gas envasado entre las
 * de `GET /item_categories` (no hay una de combustibles ni gas; `home` es «Hogar»).
 */
export const CATEGORIA_DE_ITEMS = 'home';

/**
 * Medios de pago que no se ofrecen: `ticket` (Rapipago, Pago Fácil) y `atm` son pagos
 * offline que el comprador puede hacer horas o días después, cuando el pedido ya venció
 * y se canceló (queda un pago «zombi» que hay que reintegrar). Excluirlos es más firme
 * que fijar `date_of_expiration`, que sólo acota esos medios.
 */
export const TIPOS_DE_PAGO_EXCLUIDOS = ['ticket', 'atm'] as const;

/** Cuotas máximas que se ofrecen: una sola. Las cuotas sin interés las absorbe el vendedor con más comisión. */
export const CUOTAS_MAXIMAS = 1;

/**
 * Pagos sólo aprobados o rechazados, sin `in_process` ni pendientes largos: el pedido
 * de una garrafa se despacha en el momento y vence en minutos. A cambio de una
 * aprobación algo menor (los pagos que irían a revisión manual se rechazan).
 */
export const MODO_BINARIO = true;

/** Enlaces profundos de la app a los que vuelve el comprador (contrato con la app del cliente). */
export const RETORNO_A_LA_APP = {
  exito: 'splg://pago/exito',
  pendiente: 'splg://pago/pendiente',
  error: 'splg://pago/error',
} as const;

/**
 * Minutos que se adelanta el inicio de la vigencia del checkout: Mercado Pago lo
 * compara con su propio reloj y un `expiration_date_from` apenas futuro por desfase
 * de relojes haría rechazar la preferencia o dejar el enlace inactivo al abrirlo.
 */
export const ADELANTO_DE_VIGENCIA_MINUTOS = 5;

/** Error de la pasarela con el código HTTP que respondió (para distinguir un 404 de una caída). */
export class ErrorDeLaPasarela extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const URL_CONTRACARGOS = 'https://api.mercadopago.com/v1/chargebacks';
const TIMEOUT_CONSULTA_MS = 5000;

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
          description: item.description ?? item.title,
          category_id: CATEGORIA_DE_ITEMS,
          quantity: item.quantity,
          unit_price: item.unitPrice,
          currency_id: 'ARS',
        })),
        payer: payerDeMercadoPago(input.payer),
        ...(input.receiverAddress && {
          shipments: {
            receiver_address: direccionDeEntrega(input.receiverAddress),
          },
        }),
        ...(input.statementDescriptor && {
          statement_descriptor: input.statementDescriptor,
        }),
        payment_methods: {
          excluded_payment_types: TIPOS_DE_PAGO_EXCLUIDOS.map((id) => ({ id })),
          installments: CUOTAS_MAXIMAS,
        },
        binary_mode: MODO_BINARIO,
        external_reference: input.orderId,
        notification_url: this.notificationUrl(cuenta.credentialId),
        back_urls: this.backUrls(),
        auto_return: 'approved',
        ...(input.expiresAt && {
          expires: true,
          expiration_date_from: fechaDeMercadoPago(
            new Date(Date.now() - ADELANTO_DE_VIGENCIA_MINUTOS * 60 * 1000),
          ),
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
    return aPagoDeLaPasarela(payment, cuenta.distributorId);
  }

  async findPaymentsByReference(
    reference: string,
    credentialId?: string | null,
  ): Promise<GatewayPayment[]> {
    const cuenta = await this.resolveAccount(credentialId);
    const respuesta = await new Payment(
      this.clientFor(cuenta.accessToken),
    ).search({
      options: {
        external_reference: reference,
        sort: 'date_created',
        criteria: 'desc',
        limit: 30,
      },
    });
    return (respuesta.results ?? []).map((pago) =>
      aPagoDeLaPasarela(pago, cuenta.distributorId),
    );
  }

  async getChargeback(
    chargebackId: string,
    credentialId?: string | null,
  ): Promise<GatewayChargeback> {
    const cuenta = await this.resolveAccount(credentialId);
    const respuesta = await fetch(
      `${URL_CONTRACARGOS}/${encodeURIComponent(chargebackId)}`,
      {
        headers: { Authorization: `Bearer ${cuenta.accessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_CONSULTA_MS),
      },
    );
    if (!respuesta.ok) {
      throw new ErrorDeLaPasarela(
        `MercadoPago respondió ${respuesta.status} al consultar el contracargo ${chargebackId}`,
        respuesta.status,
      );
    }
    const cuerpo = (await respuesta.json()) as {
      payments?: Array<string | number>;
      amount?: number;
      documentation_required?: boolean;
      date_documentation_deadline?: string | null;
      coverage_applied?: boolean | null;
    };
    return {
      // El id sale del aviso (texto): el de la respuesta puede pasar de 2^53 y
      // `JSON.parse` lo redondea.
      id: chargebackId,
      paymentIds: (cuerpo.payments ?? []).map(String),
      amount: cuerpo.amount ?? null,
      documentationRequired: cuerpo.documentation_required === true,
      documentationDeadline: cuerpo.date_documentation_deadline ?? null,
      coverageApplied:
        typeof cuerpo.coverage_applied === 'boolean'
          ? cuerpo.coverage_applied
          : null,
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

  async expireCheckout(
    preferenceId: string,
    credentialId?: string | null,
  ): Promise<void> {
    const cuenta = await this.resolveAccount(credentialId);
    const ahora = new Date();
    // El PUT de Mercado Pago acepta cambios parciales de la preferencia; el tipo del
    // SDK exige `items`, que acá no se toca.
    const cambios = {
      expires: true,
      expiration_date_from: fechaDeMercadoPago(
        new Date(ahora.getTime() - ADELANTO_DE_VIGENCIA_MINUTOS * 60 * 1000),
      ),
      expiration_date_to: fechaDeMercadoPago(ahora),
    } as PreferenceRequest;
    await new Preference(this.clientFor(cuenta.accessToken)).update({
      id: preferenceId,
      updatePreferenceRequest: cambios,
    });
  }

  async verifyWebhookSignature(
    input: VerifyWebhookSignatureInput,
  ): Promise<ResultadoDeFirma> {
    let secret: string;
    try {
      secret = (await this.resolveAccount(input.credentialId)).webhookSecret;
    } catch (error) {
      // Una cuenta que no existe no puede haber firmado nada; cualquier otra falla
      // (base, descifrado) es nuestra: no se sabe si la firma es buena.
      if (error instanceof NotFoundException) {
        this.logger.warn(
          `Webhook de una cuenta de Mercado Pago que no existe: ${errorMessage(error)}`,
        );
        return 'invalida';
      }
      this.logger.error(
        `No se pudo resolver el secreto del webhook: ${errorMessage(error)}`,
      );
      return 'no_verificable';
    }
    if (!secret) {
      this.logger.error(
        'Secreto de webhook de MercadoPago no configurado: no se puede validar la firma',
      );
      return 'no_verificable';
    }

    try {
      // Sin tolerancia de `ts` a propósito. La doc dice que el `ts` del `x-signature` va
      // en milisegundos (https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks;
      // su ejemplo de 10 dígitos parece de segundos) pero no dice si los reintentos, que
      // siguen durante horas y días, se vuelven a firmar con un `ts` nuevo. Rechazar por
      // antigüedad podría tirar avisos legítimos. Se valida sólo el HMAC; el pago
      // siempre se re-consulta a MP, así que un aviso repetido no puede falsear nada.
      WebhookSignatureValidator.validate({
        xSignature: input.xSignature,
        xRequestId: input.xRequestId,
        dataId: input.dataId,
        secret,
      });
      return 'valida';
    } catch (error) {
      this.logger.warn(
        `Firma de webhook MercadoPago inválida: ${errorMessage(error)}`,
      );
      return 'invalida';
    }
  }

  /**
   * A dónde vuelve el comprador al terminar de pagar: por defecto el enlace profundo de
   * la app (`splg://pago/exito|pendiente|error`); `MP_SUCCESS_URL`, `MP_PENDING_URL` y
   * `MP_FAILURE_URL` lo pisan (p. ej. con una URL https del back que redirige a la app).
   */
  private backUrls(): { success: string; pending: string; failure: string } {
    return {
      success:
        this.configService.get<string>('MP_SUCCESS_URL') ||
        RETORNO_A_LA_APP.exito,
      pending:
        this.configService.get<string>('MP_PENDING_URL') ||
        RETORNO_A_LA_APP.pendiente,
      failure:
        this.configService.get<string>('MP_FAILURE_URL') ||
        RETORNO_A_LA_APP.error,
    };
  }

  /**
   * URL a la que Mercado Pago avisa los pagos. Con cuenta propia lleva
   * `?account=<id de la credencial>`: el webhook lo usa para elegir el secreto
   * con el que valida la firma y el token con el que consulta el pago. Sin
   * cuenta propia es la URL del entorno, como siempre.
   */
  private notificationUrl(credentialId: string | null): string | undefined {
    const base = this.configService.get<string>('MP_NOTIFICATION_URL');
    if (!base) return base;
    const url = new URL(base);
    // Sólo webhooks: sin esto Mercado Pago manda además el aviso IPN al mismo
    // endpoint, que no trae firma verificable (ver `ipn.md` de la documentación).
    url.searchParams.set('source_news', 'webhooks');
    if (credentialId) url.searchParams.set('account', credentialId);
    return url.toString();
  }
}

/** Separa «Nombre Apellido» en lo que pide MP: el último término es el apellido. */
export function partirNombre(completo?: string | null): {
  name?: string;
  surname?: string;
} {
  const palabras = (completo ?? '').trim().split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return {};
  if (palabras.length === 1) return { name: palabras[0] };
  return {
    name: palabras.slice(0, -1).join(' '),
    surname: palabras[palabras.length - 1],
  };
}

/**
 * Códigos de área argentinos de 3 dígitos (capitales y ciudades grandes). Los demás
 * se toman de 4 dígitos (Oberá es 3755, Eldorado 3751), salvo el 11 que es de 2: el
 * número nacional siempre suma 10 dígitos, así que el largo del área define el resto.
 * Si falta un código en la lista sólo cambia cómo se parten los dígitos que se le
 * muestran a Mercado Pago; el número completo llega igual.
 */
const AREAS_DE_TRES_DIGITOS = new Set([
  '220',
  '221',
  '223',
  '230',
  '236',
  '237',
  '249',
  '260',
  '261',
  '263',
  '264',
  '266',
  '280',
  '291',
  '294',
  '297',
  '298',
  '299',
  '336',
  '341',
  '342',
  '343',
  '345',
  '348',
  '351',
  '353',
  '358',
  '362',
  '364',
  '370',
  '376',
  '379',
  '380',
  '381',
  '383',
  '385',
  '387',
  '388',
]);

/**
 * Teléfono internacional → código de área y número. Sólo se parte el argentino
 * (`+54 9 <área> <número>`, 10 dígitos nacionales: área de 2 (11), 3 o 4 dígitos).
 * Otro país va entero en `number`.
 */
export function partirTelefono(
  telefono?: string | null,
): { area_code?: string; number: string } | undefined {
  const digitos = (telefono ?? '').replace(/\D/g, '');
  if (!digitos) return undefined;
  if (!digitos.startsWith('54')) return { number: digitos };
  let nacional = digitos.slice(2);
  if (nacional.startsWith('9') && nacional.length === 11) {
    nacional = nacional.slice(1);
  }
  if (nacional.length !== 10) return { number: digitos };
  const largoDeArea = nacional.startsWith('11')
    ? 2
    : AREAS_DE_TRES_DIGITOS.has(nacional.slice(0, 3))
      ? 3
      : 4;
  return {
    area_code: nacional.slice(0, largoDeArea),
    number: nacional.slice(largoDeArea),
  };
}

/** «Av. Colón 1234» → calle y altura; sin altura al final, toda la calle va como nombre. */
export function partirCalle(calle: string): {
  street_name: string;
  street_number?: string;
} {
  const partes = /^(.*\S)\s+(\d+[A-Za-z]?)$/.exec(calle.trim());
  return partes
    ? { street_name: partes[1], street_number: partes[2] }
    : { street_name: calle.trim() };
}

function direccionDeEntrega(direccion: CheckoutAddress) {
  return {
    ...partirCalle(direccion.street),
    ...(direccion.zipCode && { zip_code: direccion.zipCode }),
    ...(direccion.floor && { floor: direccion.floor }),
    ...(direccion.apartment && { apartment: direccion.apartment }),
    ...(direccion.city && { city_name: direccion.city }),
    country_name: 'Argentina',
  };
}

/** El comprador con todo lo que se conoce de él; lo vacío no se manda (un email `''` hace rechazar la preferencia). */
function payerDeMercadoPago(payer: CheckoutPayer) {
  const telefono = partirTelefono(payer.phone);
  return {
    ...(payer.email && { email: payer.email }),
    ...partirNombre(payer.fullName),
    ...(telefono && { phone: telefono }),
    ...(payer.document && {
      identification: {
        type: payer.document.type,
        number: payer.document.number,
      },
    }),
    ...(payer.address && {
      address: {
        ...partirCalle(payer.address.street),
        ...(payer.address.zipCode && { zip_code: payer.address.zipCode }),
      },
    }),
  };
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

function aPagoDeLaPasarela(
  payment: {
    id?: number | string;
    status?: string;
    status_detail?: string;
    external_reference?: string;
    transaction_amount?: number;
    transaction_amount_refunded?: number;
    transaction_details?: { net_received_amount?: number };
    fee_details?: Array<{ amount?: number; fee_payer?: string }>;
  },
  accountDistributorId: string | null,
): GatewayPayment {
  return {
    id: String(payment.id),
    status: payment.status || 'unknown',
    statusDetail: normalizarDetalleDelEstado(payment.status_detail),
    externalReference: payment.external_reference || null,
    amount: payment.transaction_amount ?? null,
    refundedAmount: payment.transaction_amount_refunded ?? null,
    feeAmount: comisionDelCobro(payment),
    accountDistributorId,
  };
}
