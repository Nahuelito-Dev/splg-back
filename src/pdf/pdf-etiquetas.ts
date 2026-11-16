/** Textos en castellano de los estados y medios que salen en los documentos. */
const MEDIO_DE_PAGO: Record<string, string> = {
  cash: 'Efectivo',
  mercadopago: 'Mercado Pago',
  transfer: 'Transferencia',
  account: 'Cuenta corriente',
  online: 'Online',
};

const ESTADO_DE_PAGO: Record<string, string> = {
  pending: 'Pendiente',
  paid: 'Pagado',
  failed: 'Fallido',
  unpaid: 'Impago',
  written_off: 'Dado por perdido',
};

const ESTADO_DE_PEDIDO: Record<string, string> = {
  reserved: 'Reservado',
  pending: 'Pendiente',
  accepted: 'Aceptado',
  on_the_way: 'En camino',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
};

const ESTADO_DE_RENDICION: Record<string, string> = {
  open: 'Abierta',
  submitted: 'Presentada',
  approved: 'Aprobada',
};

const RESOLUCION_DE_DIFERENCIA: Record<string, string> = {
  none: 'Sin diferencia',
  absorbed: 'Absorbida por la empresa',
  charged_to_driver: 'A cargo del chofer',
};

const ESTADO_DE_LIQUIDACION: Record<string, string> = {
  draft: 'Borrador',
  approved: 'Aprobada',
  paid: 'Pagada',
  voided: 'Anulada',
};

const TIPO_DE_ASIENTO: Record<string, string> = {
  delivery_commission: 'Comisión por entrega',
  settlement_shortage: 'Faltante de rendición',
  traffic_fine: 'Multa de tránsito',
  adjustment: 'Ajuste',
  legacy_balance: 'Saldo anterior',
};

const ESTADO_DE_SESION: Record<string, string> = {
  open: 'Abierta',
  closed: 'Cerrada',
};

function traducir(tabla: Record<string, string>, clave: string): string {
  return tabla[clave] ?? clave;
}

export const medioDePago = (c: string) => traducir(MEDIO_DE_PAGO, c);
export const estadoDePago = (c: string) => traducir(ESTADO_DE_PAGO, c);
export const estadoDePedido = (c: string) => traducir(ESTADO_DE_PEDIDO, c);
export const estadoDeRendicion = (c: string) =>
  traducir(ESTADO_DE_RENDICION, c);
export const resolucionDeDiferencia = (c: string) =>
  traducir(RESOLUCION_DE_DIFERENCIA, c);
export const estadoDeLiquidacion = (c: string) =>
  traducir(ESTADO_DE_LIQUIDACION, c);
export const tipoDeAsiento = (c: string) => traducir(TIPO_DE_ASIENTO, c);
export const estadoDeSesion = (c: string) => traducir(ESTADO_DE_SESION, c);
