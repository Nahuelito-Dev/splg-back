import { DriverLiquidationDetailDto } from '../../commission/dto/driver-liquidation.dto';
import { PdfBuilder, Membrete } from '../pdf-builder';
import { estadoDeLiquidacion, tipoDeAsiento } from '../pdf-etiquetas';
import {
  diaCalendario,
  fechaHora,
  numeroDeDocumento,
  pesos,
} from '../pdf-formato';

/** Liquidación de comisiones de un chofer: asientos, bruto, deducciones y neto. */
export function renderLiquidacion(
  l: DriverLiquidationDetailDto,
  membrete: Membrete,
): Promise<Buffer> {
  const pdf = new PdfBuilder(`Liquidación ${l.number}`, membrete, {
    tipo: 'LIQUIDACIÓN',
    referencia: numeroDeDocumento(l.number),
    subtitulo: `Período ${diaCalendario(l.periodFrom)} al ${diaCalendario(l.periodTo)}`,
  });

  pdf.seccion('Liquidación').datos([
    ['Chofer', l.employeeName],
    ['Estado', estadoDeLiquidacion(l.status)],
    ['Aprobada', fechaHora(l.approvedAt)],
    ['Pagada', fechaHora(l.paidAt)],
  ]);

  pdf.seccion('Detalle de asientos').tabla(
    [
      { titulo: 'Fecha', peso: 2.5 },
      { titulo: 'Concepto', peso: 3 },
      { titulo: 'Descripción', peso: 4 },
      { titulo: 'Importe', peso: 2, alinear: 'right' },
    ],
    l.entries.map((e) => [
      fechaHora(e.occurredAt),
      tipoDeAsiento(e.type),
      e.description,
      pesos(e.amount),
    ]),
    'Sin asientos.',
  );

  pdf.totales([
    { etiqueta: 'Bruto', valor: pesos(l.gross) },
    { etiqueta: 'Deducciones', valor: pesos(-l.deductions) },
    { etiqueta: 'NETO A PAGAR', valor: pesos(l.net), destacada: true },
  ]);
  return pdf.finalizar();
}
