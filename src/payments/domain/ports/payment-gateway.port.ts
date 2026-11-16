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
  /** Detalle del renglón para el antifraude de la pasarela; sin él se usa el título. */
  description?: string;
}

/** Dirección tal como la guarda el sistema: la calle viene en un solo texto, con la altura al final. */
export interface CheckoutAddress {
  street: string;
  zipCode?: string | null;
  floor?: string | null;
  apartment?: string | null;
  city?: string | null;
}

/** Quien paga, con lo que el sistema sabe de él. Todo es opcional: lo que falta no se manda. */
export interface CheckoutPayer {
  email?: string | null;
  fullName?: string | null;
  /** Teléfono en formato internacional (`+549...`). */
  phone?: string | null;
  document?: { type: string; number: string } | null;
  address?: CheckoutAddress | null;
}

export interface CreateCheckoutInput {
  orderId: string;
  items: PaymentCheckoutItem[];
  payer: CheckoutPayer;
  /** Dónde se entrega el pedido. */
  receiverAddress?: CheckoutAddress | null;
  /** Nombre que el comprador ve en el resumen de su tarjeta. */
  statementDescriptor?: string;
  /** Distribuidora que cobra: define con qué cuenta de la pasarela se hace el checkout. */
  distributorId?: string | null;
  /** Hasta cuándo se puede pagar el checkout: pasado ese instante el enlace deja de cobrar. */
  expiresAt?: Date;
}

export interface CreateCheckoutResult {
  /** URL de Checkout Pro a la que se redirige al cliente para pagar. */
  initPoint: string;
  preferenceId: string;
  /** Cuenta con la que se armó el checkout: id de la credencial propia, o `null` si fue la del sistema. */
  credentialId: string | null;
}

/** Contracargo informado por la pasarela. */
export interface GatewayChargeback {
  id: string;
  /** Ids de los pagos de la pasarela alcanzados por el contracargo. */
  paymentIds: string[];
  amount: number | null;
  /** Si hay que presentar documentación para disputarlo. */
  documentationRequired: boolean;
  /** Fecha límite para presentarla, si la informa. */
  documentationDeadline: string | null;
  /**
   * Resolución del caso (`coverage_applied`): `true` = a favor del vendedor, el dinero se
   * le reintegra; `false` = en su contra, se le descuenta; `null` = todavía sin resolver.
   * https://www.mercadopago.com.ar/developers/en/docs/checkout-pro-preferences/chargebacks/manage
   */
  coverageApplied: boolean | null;
}

/** Resultado normalizado de consultar un pago en la pasarela. */
export interface GatewayPayment {
  id: string;
  status: string;
  /** Motivo del estado (`status_detail`: `accredited`, `cc_rejected_insufficient_amount`...); `null` si no lo informa. */
  statusDetail?: string | null;
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
  /**
   * Distribuidora dueña de la cuenta con la que se consultó el pago (`null` si
   * fue la del sistema): el caller la compara con la del pedido.
   */
  accountDistributorId?: string | null;
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
  /** Cuenta con la que se cobró el pago (`Payment.credentialId`; `null` = la del sistema). */
  credentialId?: string | null;
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
  /** Cuenta a la que pertenece la notificación (la identifica la `notification_url` del checkout; `null` = la del sistema). */
  credentialId?: string | null;
}

/**
 * Resultado de validar la firma de un aviso:
 *  - `valida`: la firma coincide;
 *  - `invalida`: la firma falta, está mal formada o no coincide (el aviso no viene de la pasarela);
 *  - `no_verificable`: no se pudo comprobar (no se pudo leer la cuenta o el secreto, falla de base o de
 *    credencial): no es culpa de quien avisó, la pasarela tiene que reintentar.
 */
export type ResultadoDeFirma = 'valida' | 'invalida' | 'no_verificable';

export abstract class PaymentGatewayPort {
  /** Crea una preferencia de Checkout Pro y devuelve la URL de pago. */
  abstract createCheckout(
    input: CreateCheckoutInput,
  ): Promise<CreateCheckoutResult>;

  /**
   * Consulta un pago por id (lo llama el webhook para confirmar el estado real),
   * con la cuenta con la que se cobró (`credentialId`; `null` = la del sistema).
   */
  abstract getPayment(
    paymentId: string,
    credentialId?: string | null,
  ): Promise<GatewayPayment>;

  /**
   * Todos los pagos que la pasarela tiene de un pedido (por `external_reference`),
   * con la cuenta con la que se armó su checkout (`null` = la del sistema). Lanza si
   * la pasarela no responde: quien llama no debe tomar el silencio por «sin pagos».
   */
  abstract findPaymentsByReference(
    reference: string,
    credentialId?: string | null,
  ): Promise<GatewayPayment[]>;

  /** Consulta un contracargo por id, con la cuenta de la notificación (`null` = la del sistema). */
  abstract getChargeback(
    chargebackId: string,
    credentialId?: string | null,
  ): Promise<GatewayChargeback>;

  /**
   * Pide a la pasarela que devuelva `amount` de un pago aprobado. Lanza si la
   * pasarela la rechaza o no responde: el caller registra el error y deja el
   * reintento al administrador.
   */
  abstract refundPayment(
    input: RefundPaymentInput,
  ): Promise<RefundPaymentResult>;

  /**
   * Cierra el checkout (la preferencia) para que su enlace deje de cobrar: se usa al
   * cancelar un pedido con el pago pendiente. Lanza si la pasarela no responde o lo
   * rechaza; quien llama lo trata como mejor esfuerzo.
   */
  abstract expireCheckout(
    preferenceId: string,
    credentialId?: string | null,
  ): Promise<void>;

  /**
   * Valida la firma `x-signature` de una notificación de webhook (nunca lanza).
   * Distingue la firma inválida de la que no se pudo comprobar: ver `ResultadoDeFirma`.
   * Usa el secreto de la cuenta de la notificación; sin cuenta, el del entorno.
   */
  abstract verifyWebhookSignature(
    input: VerifyWebhookSignatureInput,
  ): Promise<ResultadoDeFirma>;
}
