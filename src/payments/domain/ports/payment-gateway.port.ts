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
  /** Lo que la pasarela efectivamente cobró (null si no lo informa). */
  amount?: number | null;
  /** Lo que la pasarela ya devolvió de ese pago (null si no lo informa). */
  refundedAmount?: number | null;
  /**
   * Lo que la pasarela retuvo de ese cobro como comisión (cargos que absorbe el
   * comercio, retenciones incluidas). `null` si no lo informa: sin dato no se
   * asienta comisión.
   */
  feeAmount?: number | null;
}

export interface RefundPaymentInput {
  /** Id del pago en la pasarela. */
  gatewayPaymentId: string;
  /** Importe a devolver (parcial o lo que falte del total). */
  amount: number;
  /**
   * Clave de idempotencia de la solicitud: la misma clave nunca devuelve el
   * dinero dos veces, aunque se repita la llamada.
   */
  idempotencyKey: string;
}

export interface RefundPaymentResult {
  /** Id de la devolución en la pasarela. */
  refundId: string;
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
   * Pide a la pasarela que devuelva `amount` de un pago aprobado. Lanza si la
   * pasarela la rechaza o no responde: el caller registra el error y deja el
   * reintento al administrador.
   */
  abstract refundPayment(
    input: RefundPaymentInput,
  ): Promise<RefundPaymentResult>;

  /**
   * Valida la firma `x-signature` de una notificación de webhook. Devuelve
   * `false` (nunca lanza) ante cualquier problema: firma ausente, malformada
   * o que no coincide — el caller decide qué hacer (loguear y no procesar).
   */
  abstract verifyWebhookSignature(input: VerifyWebhookSignatureInput): boolean;
}
