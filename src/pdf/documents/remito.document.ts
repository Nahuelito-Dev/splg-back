import { OrderResponseDto } from '../../order/dto/order-response.dto';
import { PdfBuilder, Membrete } from '../pdf-builder';
import { estadoDePago, estadoDePedido, medioDePago } from '../pdf-etiquetas';
import { codigoCorto, fechaHora, numero, pesos } from '../pdf-formato';

/** Lo que el remito necesita además del detalle público del pedido. */
export interface DatosExtraDelPedido {
  /** Sólo para el personal: el cliente no recibe el código que confirma la entrega. */
  deliveryCode: string | null;
  paymentSurchargeAmount: number;
  /** % con que se calculó el recargo; null en los pedidos anteriores a que fuera configurable. */
  paymentSurchargePercentage: number | null;
}

function descripcionDelRenglon(item: OrderResponseDto['items'][number]) {
  const p = item.cylinder;
  if (!p) return 'Producto';
  const base = `Garrafa ${p.type}`;
  return p.description ? `${base} · ${p.description}` : base;
}

function direccion(order: OrderResponseDto): string {
  const a = order.address;
  if (!a) return '-';
  return a.formattedAddress ?? `${a.street}, ${a.city}`;
}

/** Remito del pedido: ítems, recargos, total, entrega y estado del pago. */
export function renderRemito(
  order: OrderResponseDto,
  extra: DatosExtraDelPedido,
  membrete: Membrete,
): Promise<Buffer> {
  const pdf = new PdfBuilder(`Remito ${codigoCorto(order.id)}`, membrete, {
    tipo: 'REMITO',
    referencia: `Pedido ${codigoCorto(order.id)}`,
    subtitulo: `Emitido el ${fechaHora(order.createdAt)}`,
  });

  pdf.seccion('Cliente y entrega').datos([
    ['Cliente', order.customer?.fullName ?? '-'],
    ['Teléfono', order.customer?.phoneNumber ?? '-'],
    ['Dirección de entrega', direccion(order)],
    ['Indicaciones', order.address?.additionalInstructions ?? '-'],
    ['Chofer', order.deliveryName ?? 'Sin asignar'],
    [
      'Vehículo',
      order.vehicle
        ? [order.vehicle.patent, order.vehicle.brand, order.vehicle.model]
            .filter(Boolean)
            .join(' · ')
        : '-',
    ],
    ['Estado del pedido', estadoDePedido(order.status)],
    [
      'Entrega',
      order.actualDeliveryDate
        ? fechaHora(order.actualDeliveryDate)
        : order.requestedDeliveryDate
          ? `Pedida para ${fechaHora(order.requestedDeliveryDate)}`
          : '-',
    ],
  ]);
  if (extra.deliveryCode) {
    pdf.datos([['Código de entrega', extra.deliveryCode]]);
  }

  pdf.seccion('Detalle').tabla(
    [
      { titulo: 'Producto', peso: 5 },
      { titulo: 'Cant.', peso: 1, alinear: 'right' },
      { titulo: 'Precio unit.', peso: 2, alinear: 'right' },
      { titulo: 'Subtotal', peso: 2, alinear: 'right' },
    ],
    order.items.map((i) => [
      descripcionDelRenglon(i),
      numero(i.quantity),
      pesos(i.unitPrice),
      pesos(i.subtotal),
    ]),
  );

  const lineas = [{ etiqueta: 'Subtotal', valor: pesos(order.subtotalItems) }];
  if (order.zoneSurcharge && order.zoneSurcharge.amount > 0) {
    lineas.push({
      etiqueta: `Recargo zona ${order.zoneSurcharge.name}`,
      valor: pesos(order.zoneSurcharge.amount),
    });
  }
  if (order.expressSurchargeAmount > 0) {
    lineas.push({
      etiqueta: 'Recargo envío express',
      valor: pesos(order.expressSurchargeAmount),
    });
  }
  if (extra.paymentSurchargeAmount > 0) {
    lineas.push({
      etiqueta:
        extra.paymentSurchargePercentage === null
          ? 'Recargo por medio de pago'
          : `Recargo por medio de pago (${String(extra.paymentSurchargePercentage).replace('.', ',')} %)`,
      valor: pesos(extra.paymentSurchargeAmount),
    });
  }
  pdf.totales([
    ...lineas,
    { etiqueta: 'TOTAL', valor: pesos(order.total), destacada: true },
  ]);

  pdf.seccion('Pago').datos([
    ['Medio de pago', medioDePago(order.paymentMethodDetail)],
    ['Estado del pago', estadoDePago(order.paymentStatus)],
    ['Cobrado el', fechaHora(order.paymentConfirmedAt)],
    [
      'Seña',
      order.depositAmount && order.depositAmount > 0
        ? `${pesos(order.depositAmount)}${order.depositPaid ? ' (paga)' : ' (pendiente)'}`
        : '-',
    ],
  ]);

  return pdf.finalizar();
}
