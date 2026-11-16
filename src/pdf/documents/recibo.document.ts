import { OrderResponseDto } from '../../order/dto/order-response.dto';
import { PdfBuilder, Membrete } from '../pdf-builder';
import { medioDePago } from '../pdf-etiquetas';
import { codigoCorto, fechaHora, pesos } from '../pdf-formato';

/** Los precios que cobra el sistema son finales: el IVA ya está incluido. */
export const PRECIOS_CON_IVA = 'Precios finales con IVA incluido.';

/** El recibo acredita el pago, pero no reemplaza a la factura. */
export const NO_ES_FACTURA =
  'Este recibo no es una factura: no es válido como comprobante fiscal.';

/** Recibo de pago de un pedido cobrado. */
export function renderRecibo(
  order: OrderResponseDto,
  membrete: Membrete,
): Promise<Buffer> {
  const pdf = new PdfBuilder(`Recibo ${codigoCorto(order.id)}`, membrete, {
    tipo: 'RECIBO DE PAGO',
    referencia: `Pedido ${codigoCorto(order.id)}`,
    subtitulo: `Cobrado el ${fechaHora(order.paymentConfirmedAt)}`,
  });

  pdf.seccion('Recibimos de').datos([
    ['Cliente', order.customer?.fullName ?? '-'],
    ['Email', order.customer?.email ?? '-'],
  ]);

  pdf.seccion('Concepto').tabla(
    [
      { titulo: 'Concepto', peso: 6 },
      { titulo: 'Medio de pago', peso: 3 },
      { titulo: 'Importe', peso: 2, alinear: 'right' },
    ],
    [
      [
        `Pago del pedido ${codigoCorto(order.id)} (${order.items.length} ${order.items.length === 1 ? 'ítem' : 'ítems'})`,
        medioDePago(order.paymentMethodDetail),
        pesos(order.total),
      ],
    ],
  );

  pdf.totales([
    { etiqueta: 'TOTAL PAGADO', valor: pesos(order.total), destacada: true },
  ]);
  pdf.texto(PRECIOS_CON_IVA, { apagado: true });
  pdf.texto(
    'Este recibo acredita el pago del pedido indicado. Conservalo como comprobante.',
    { apagado: true },
  );
  pdf.texto(NO_ES_FACTURA, { apagado: true });
  return pdf.finalizar();
}
