/**
 * Qué NO entra en la auditoría de datos. Un solo lugar, con el porqué.
 */

/** Tablas que no se auditan, por nombre de tabla. */
export const TABLAS_EXCLUIDAS: ReadonlySet<string> = new Set([
  // Las propias tablas de auditoría: auditarlas sería recursivo.
  'audit',
  'audit_detail',
  'audit_action_type',
  // Bitácora de requests (CU-153): otra cosa, ya inmutable.
  'audit_log',
  // Registro de lo que miró el soporte (modo soporte): ya es un registro de sólo
  // agregar, como `audit_log`; auditarlo sería auditar la auditoría.
  'support_access',
  // Contador de numeración con bloqueo de fila: una escritura por documento
  // emitido, sin valor de negocio propio (el documento ya se audita).
  'document_sequence',
  // Telemetría de los procesos automáticos (F31): una fila por corrida, cientos por día y
  // con retención; lo que cada proceso hace sobre el negocio se audita en sus propias tablas.
  // Es telemetría del sistema y la excepción a la auditoría por triggers está aprobada.
  'process_run',
  // Cola técnica de archivos a limpiar en el storage.
  'storage_orphan',
  // Bandeja de entrada de los avisos de Mercado Pago que no se reintentan (alerta de
  // fraude): cola técnica sin distribuidora al guardarse; lo que se hace con el aviso
  // (retener el pedido, avisar al admin) sí queda en la auditoría del pedido.
  'payment_notification_inbox',
  // Una fila por intento de oferta a un chofer (cientos por día): es el
  // registro durable del despacho y de alto volumen.
  'order_dispatch_offer',
  // Ofrecimiento de un lote a un chofer, con vigencia: igual que la oferta de
  // un pedido, es un intento operativo del despacho y no un dato del negocio.
  'route_batch_offer',
  // Historiales que sólo se agregan: ya son el registro de cada cambio.
  'order_status_history',
  'cylinder_movement',
  'vehicle_usage_log',
  // Stock físico: el libro de movimientos ya es el registro de cada cambio, el
  // saldo es su suma materializada y el renglón de un ajuste lo cubre la
  // cabecera del ajuste.
  'stock_movement',
  'stock_balance',
  'stock_adjustment_item',
  // Firma del último aviso de conciliación: estado operativo del cron.
  'stock_reconciliation_alert',
  // Vista previa de una importación masiva: hasta 5.000 filas en jsonb que
  // vencen a las 24 h. Lo que vale es lo que se aplica al confirmar, y eso sale
  // por los servicios de cada recurso (que sí se auditan).
  'import_job',
  // Estado transitorio de compra: cada alta y baja de renglón es ruido; lo
  // que vale es el pedido que sale de ahí.
  'cart',
  'cart_item',
]);

/**
 * Propiedades que no se auditan aunque la entidad sí, por entidad (nombre de
 * clase). Si el único cambio de un guardado son estas propiedades, no se
 * escribe nada.
 */
export const PROPIEDADES_EXCLUIDAS: Readonly<
  Record<string, readonly string[]>
> = {
  // Posición del chofer: se actualiza varias veces por minuto en ruta
  // (1468 de los 1727 asientos de audit_log eran `PATCH /delivery/:id/location`).
  Delivery: ['location', 'actualLocation'],
  // Datos de quien recibe el pedido (CU-128): datos personales de un tercero que
  // se anulan al vencer el plazo de reclamo; la auditoría es inmutable, así que
  // ni el documento ni el nombre ni la relación pueden entrar.
  Order: ['receiverName', 'receiverDocument', 'receiverRelationship'],
  MercadoPagoCredentials: [
    'accessTokenEncrypted',
    'publicKeyEncrypted',
    'webhookSecretEncrypted',
  ],
  // `alertedAt`: marca interna del cron de avisos de vencimientos. `details`:
  // datos personales de la documentación del personal (psicofísico, ART).
  MaintenanceTask: ['alertedAt', 'details'],
};

/** Campos que se guardan como `[oculto]`: credenciales y claves de acceso. */
const PATRON_SECRETO =
  /password|passwd|contrase|hash|secret|token|api_?key|private_?key|^deliveryCode$/i;

export const VALOR_OCULTO = '[oculto]';

export function esSecreto(propiedad: string): boolean {
  return PATRON_SECRETO.test(propiedad);
}

/**
 * Entidades sin columna de distribuidora que son de una distribuidora (el
 * renglón de un pedido, la promoción de un producto...): se registran con la
 * del request, que sale del perfil del admin o del chofer. Las demás sin
 * columna propia (User, Customer, UserAddress, Role) son de la persona o
 * globales y se comparten entre distribuidoras: quedan sin distribuidora, para
 * que una no vea los datos que la otra edita.
 */
export const ENTIDADES_DE_LA_DISTRIBUIDORA_DEL_REQUEST: ReadonlySet<string> =
  new Set([
    'OrderItem',
    'OrderAddressChange',
    'RouteBatchStop',
    'GasCylinderPromotion',
    'CylinderRecoveryNotice',
    'MaintenanceWindowProposal',
    // La lectura de un aviso de la bandeja (F10): es del admin que la hizo.
    'AdminNotificationRead',
  ]);

/**
 * Entidades hijas de un pedido y la propiedad que lo nombra. Todo asiento de
 * ellas (alta, modificación, baja) lleva un detalle con ese campo aunque no
 * haya cambiado, para encontrarlas en el historial del pedido
 * (`GET /audit/entries?orderId=`).
 */
export const CONTEXTO_DE_PEDIDO: Readonly<Record<string, string>> = {
  OrderItem: 'orderId',
  Payment: 'orderId',
};
