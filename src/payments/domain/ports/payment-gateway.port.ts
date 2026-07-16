/**
 * PUERTO de pasarela de pago. El dominio/casos de uso hablan con ESTA
 * interfaz, no con el SDK de MercadoPago: "creá un checkout" / "consultá un
 * pago" / "validá la firma de un webhook" se expresan acá, y un adapter de
 * infraestructura (MercadoPagoAdapter) implementa el cómo.
 *
 * Se declara como clase abstracta porque en NestJS es el token de inyección
 * idiomático para puertos (las interfaces no existen en runtime). Ver
 * MercadoPagoAdapter (infrastructure) para la implementación concreta.
 */

/** Ítem de un pedido tal como lo necesita el checkout (precio de SERVIDOR, no del cliente). */
export interface PaymentCheckoutItem {
  id: string;
  title: string;
  quantity: number;
  unitPrice: number;
}

export interface CreateCheckoutInput {
  orderId: string;
  items: PaymentCheckoutItem[];
  payerEmail: string;
}

export interface CreateCheckoutResult {
  /** URL de Checkout Pro a la que se redirige al cliente para pagar. */
  initPoint: string;
  preferenceId: string;
}

/** Resultado normalizado de consultar un pago en la pasarela. */
export interface GatewayPayment {
  id: string;
  status: string;
  externalReference: string | null;
}

/** Datos crudos (headers + query) necesarios para validar la firma del webhook. */
export interface VerifyWebhookSignatureInput {
  xSignature?: string;
  xRequestId?: string;
  dataId?: string;
}

export abstract class PaymentGatewayPort {
  /** Crea una preferencia de Checkout Pro y devuelve la URL de pago. */
  abstract createCheckout(
    input: CreateCheckoutInput,
  ): Promise<CreateCheckoutResult>;

  /** Consulta un pago por id (lo llama el webhook para confirmar el estado real). */
  abstract getPayment(paymentId: string): Promise<GatewayPayment>;

  /**
   * Valida la firma `x-signature` de una notificación de webhook. Devuelve
   * `false` (nunca lanza) ante cualquier problema: firma ausente, malformada
   * o que no coincide — el caller decide qué hacer (loguear y no procesar).
   */
  abstract verifyWebhookSignature(input: VerifyWebhookSignatureInput): boolean;
}
