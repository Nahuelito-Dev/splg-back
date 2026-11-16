/** Nombre del evento que emite `payments` al recibir un webhook con firma válida. */
export const EVENTO_PAGO_NOTIFICADO = 'pago.notificado';

/**
 * La pasarela avisó un cambio en un pago y la firma es válida. `payments` no
 * sabe de pedidos: lo publica y quien tenga algo que hacer con ese pago (hoy
 * `order`, que confirma el pedido) lo escucha.
 */
export class PagoNotificadoEvent {
  constructor(
    readonly type: string | undefined,
    readonly dataId: string | undefined,
    readonly xSignature: string | undefined,
    readonly xRequestId: string | undefined,
    /** Cuenta propia de Mercado Pago de la notificación (id de la credencial); ausente = la del sistema. */
    readonly credentialId?: string,
  ) {}
}
