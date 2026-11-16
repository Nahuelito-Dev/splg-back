import { CashSessionDetailDto } from '../../cash/dto/cash-session.dto';
import { PdfBuilder, Membrete } from '../pdf-builder';
import { estadoDeSesion } from '../pdf-etiquetas';
import { fechaHora, pesos } from '../pdf-formato';
import { CashDirection } from '../../cash/domain/cash.enums';

/** Cierre de caja: apertura, movimientos de la sesión, esperado, contado y diferencia. */
export function renderCierreDeCaja(
  s: CashSessionDetailDto,
  membrete: Membrete,
): Promise<Buffer> {
  const pdf = new PdfBuilder(`Cierre de caja ${s.cashBoxName}`, membrete, {
    tipo: s.closedAt ? 'CIERRE DE CAJA' : 'ARQUEO DE CAJA',
    referencia: s.cashBoxName,
    subtitulo: `Apertura ${fechaHora(s.openedAt)}`,
  });

  pdf.seccion('Sesión').datos([
    ['Caja', s.cashBoxName],
    ['Estado', estadoDeSesion(s.status)],
    ['Abierta', fechaHora(s.openedAt)],
    ['Cerrada', fechaHora(s.closedAt)],
  ]);

  pdf.seccion('Movimientos').tabla(
    [
      { titulo: 'Fecha', peso: 2.5 },
      { titulo: 'Categoría', peso: 3 },
      { titulo: 'Descripción', peso: 4 },
      { titulo: 'Entrada', peso: 2, alinear: 'right' },
      { titulo: 'Salida', peso: 2, alinear: 'right' },
    ],
    s.movements.map((m) => [
      fechaHora(m.occurredAt),
      m.categoryName,
      m.description,
      m.direction === CashDirection.IN ? pesos(m.amount) : '',
      m.direction === CashDirection.OUT ? pesos(m.amount) : '',
    ]),
    'Sin movimientos en la sesión.',
  );

  const arqueo = [
    { etiqueta: 'Apertura', valor: pesos(s.openingAmount) },
    { etiqueta: 'Entradas', valor: pesos(s.totalIn) },
    { etiqueta: 'Salidas', valor: pesos(-s.totalOut) },
    {
      etiqueta: 'Esperado',
      valor: pesos(
        s.expectedAmount ?? s.openingAmount + s.totalIn - s.totalOut,
      ),
    },
  ];
  if (s.countedAmount !== null) {
    arqueo.push({ etiqueta: 'Contado', valor: pesos(s.countedAmount) });
  }
  pdf.totales(
    s.difference !== null
      ? [
          ...arqueo,
          {
            etiqueta: 'DIFERENCIA',
            valor: pesos(s.difference),
            destacada: true,
          },
        ]
      : [
          ...arqueo,
          {
            etiqueta: 'SALDO ACTUAL',
            valor: pesos(s.currentBalance),
            destacada: true,
          },
        ],
  );
  if (s.notes) pdf.texto(`Notas: ${s.notes}`, { apagado: true });
  return pdf.finalizar();
}
