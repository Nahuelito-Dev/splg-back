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
  // Contador de numeración con bloqueo de fila: una escritura por documento
  // emitido, sin valor de negocio propio (el documento ya se audita).
  'document_sequence',
  // Cola técnica de archivos a limpiar en el storage.
  'storage_orphan',
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
  // Marca interna del cron de avisos de vencimientos.
  MaintenanceTask: ['alertedAt'],
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
  ]);
