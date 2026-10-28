import { DriverSettlementDetailDto } from '../../driver-settlement/dto/driver-settlement.dto';
import { PdfBuilder, Membrete } from '../pdf-builder';
import { estadoDeRendicion, resolucionDeDiferencia } from '../pdf-etiquetas';
import {
  diaCalendario,
  fechaHora,
  numeroDeDocumento,
  pesos,
} from '../pdf-formato';

/** Rendición diaria del chofer: pedidos en efectivo, cobros, gastos y diferencia. */
export function renderRendicion(
  r: DriverSettlementDetailDto,
  membrete: Membrete,
): Promise<Buffer> {
  const pdf = new PdfBuilder(`Rendición ${r.number}`, membrete, {
    tipo: 'RENDICIÓN DE CHOFER',
    referencia: numeroDeDocumento(r.number),
    subtitulo: `Día ${diaCalendario(r.businessDate)}`,
  });

  pdf.seccion('Rendición').datos([
    ['Chofer', r.driverName],
    ['Estado', estadoDeRendicion(r.status)],
    ['Presentada', fechaHora(r.submittedAt)],
    ['Aprobada', fechaHora(r.approvedAt)],
  ]);

  pdf.seccion('Pedidos en efectivo').tabla(
    [
      { titulo: 'Cliente', peso: 3 },
      { titulo: 'Dirección', peso: 4 },
      { titulo: 'Entregado', peso: 2.5 },
      { titulo: 'A cobrar', peso: 2, alinear: 'right' },
    ],
    r.orders.map((o) => [
      o.customerName ?? '-',
      o.deliveryAddress ?? '-',
      fechaHora(o.deliveredAt),
      pesos(o.amountToCollect),
    ]),
    'Sin pedidos en efectivo.',
  );

  pdf.seccion('Cobros de cuenta corriente').tabla(
    [
      { titulo: 'Cliente', peso: 5 },
      { titulo: 'Cobrado', peso: 3 },
      { titulo: 'Importe', peso: 2, alinear: 'right' },
    ],
    r.collections.map((c) => [
      c.businessName,
      fechaHora(c.collectedAt),
      pesos(c.amount),
    ]),
    'Sin cobros de cuenta corriente.',
  );

  pdf.seccion('Gastos pagados con la cobranza').tabla(
    [
      { titulo: 'Categoría', peso: 3 },
      { titulo: 'Detalle', peso: 5 },
      { titulo: 'Importe', peso: 2, alinear: 'right' },
    ],
    r.expenses.map((e) => [
      e.categoryName,
      e.description ?? '-',
      pesos(e.amount),
    ]),
    'Sin gastos.',
  );

  const lineas = [
    { etiqueta: 'Efectivo de pedidos', valor: pesos(r.cashFromOrders) },
    { etiqueta: 'Cobros de cuenta cte.', valor: pesos(r.cashFromCollections) },
    { etiqueta: 'Esperado', valor: pesos(r.expectedCash) },
    {
      etiqueta: 'Declarado',
      valor: r.declaredCash === null ? '-' : pesos(r.declaredCash),
    },
    { etiqueta: 'Gastos', valor: pesos(r.driverExpenses) },
  ];
  pdf.totales([
    ...lineas,
    {
      etiqueta: 'DIFERENCIA',
      valor: r.difference === null ? '-' : pesos(r.difference),
      destacada: true,
    },
  ]);
  if (r.difference !== null && r.difference !== 0) {
    pdf.texto(
      `${r.difference < 0 ? 'Faltante' : 'Sobrante'}: ${
        r.differenceResolution
          ? resolucionDeDiferencia(r.differenceResolution)
          : 'sin resolver'
      }.`,
    );
  }
  if (r.notes) pdf.texto(`Notas: ${r.notes}`, { apagado: true });
  return pdf.finalizar();
}
