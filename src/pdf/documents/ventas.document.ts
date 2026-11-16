import {
  CobrosDeEfectivoDto,
  EvolucionDeVentasDto,
  VentasPorChoferDto,
  VentasPorMedioDePagoDto,
  VentasPorProductoDto,
} from '../../reports/dto/report-response.dto';
import { PdfBuilder, Membrete } from '../pdf-builder';
import { medioDePago } from '../pdf-etiquetas';
import { diaCalendario, fecha, numero, pesos } from '../pdf-formato';

/** Las mismas cifras que los reportes del panel, ya consultadas. */
export interface DatosDelReporteDeVentas {
  desde: string;
  hasta: string;
  porMedioDePago: VentasPorMedioDePagoDto[];
  porProducto: VentasPorProductoDto[];
  porChofer: VentasPorChoferDto[];
  evolucion: EvolucionDeVentasDto[];
  cobros: CobrosDeEfectivoDto;
}

/** Reporte de ventas del período (pedidos entregados y cobrados). */
export function renderReporteDeVentas(
  d: DatosDelReporteDeVentas,
  membrete: Membrete,
): Promise<Buffer> {
  const periodo =
    d.desde === d.hasta
      ? diaCalendario(d.desde)
      : `${diaCalendario(d.desde)} al ${diaCalendario(d.hasta)}`;
  const pdf = new PdfBuilder(`Reporte de ventas ${periodo}`, membrete, {
    tipo: 'REPORTE DE VENTAS',
    referencia: periodo,
    subtitulo: 'Pedidos entregados y cobrados',
  });

  const totalPedidos = d.porMedioDePago.reduce((a, m) => a + m.totalOrders, 0);
  const totalVentas = d.porMedioDePago.reduce((a, m) => a + m.totalSales, 0);
  pdf.seccion('Resumen').totales([
    { etiqueta: 'Pedidos cobrados', valor: numero(totalPedidos) },
    { etiqueta: 'VENTAS', valor: pesos(totalVentas), destacada: true },
  ]);

  pdf.seccion('Por medio de pago').tabla(
    [
      { titulo: 'Medio de pago', peso: 5 },
      { titulo: 'Pedidos', peso: 2, alinear: 'right' },
      { titulo: 'Ventas', peso: 3, alinear: 'right' },
    ],
    d.porMedioDePago.map((m) => [
      medioDePago(m.method),
      numero(m.totalOrders),
      pesos(m.totalSales),
    ]),
    'Sin ventas en el período.',
  );

  pdf.seccion('Por producto').tabla(
    [
      { titulo: 'Producto', peso: 5 },
      { titulo: 'Unidades', peso: 2, alinear: 'right' },
      { titulo: 'Ventas', peso: 3, alinear: 'right' },
    ],
    d.porProducto.map((p) => [
      p.description ? `${p.productType} · ${p.description}` : p.productType,
      numero(p.totalQuantity),
      pesos(p.totalSales),
    ]),
    'Sin ventas en el período.',
  );

  pdf.seccion('Por chofer').tabla(
    [
      { titulo: 'Chofer', peso: 5 },
      { titulo: 'Pedidos', peso: 2, alinear: 'right' },
      { titulo: 'Ventas', peso: 3, alinear: 'right' },
    ],
    d.porChofer.map((c) => [
      c.driverName ?? 'Sin nombre',
      numero(c.totalOrders),
      pesos(c.totalSales),
    ]),
    'Sin ventas en el período.',
  );

  pdf.seccion('Evolución diaria').tabla(
    [
      { titulo: 'Día', peso: 4 },
      { titulo: 'Pedidos', peso: 2, alinear: 'right' },
      { titulo: 'Ventas', peso: 3, alinear: 'right' },
    ],
    d.evolucion.map((e) => [
      fecha(e.period),
      numero(e.totalOrders),
      pesos(e.totalSales),
    ]),
    'Sin ventas en el período.',
  );

  const filaDeCobro = (
    nombre: string,
    c: CobrosDeEfectivoDto[keyof CobrosDeEfectivoDto],
  ) => [nombre, numero(c.totalOrders), pesos(c.totalAmount)];
  pdf.seccion('Cobros que no suman a las ventas').tabla(
    [
      { titulo: 'Concepto', peso: 5 },
      { titulo: 'Pedidos', peso: 2, alinear: 'right' },
      { titulo: 'Importe', peso: 3, alinear: 'right' },
    ],
    [
      filaDeCobro('Efectivo sin confirmar', d.cobros.pendingCash),
      filaDeCobro('Impagos', d.cobros.unpaid),
      filaDeCobro('Dados por perdidos', d.cobros.writtenOff),
      filaDeCobro('Transferencias sin confirmar', d.cobros.pendingTransfer),
      filaDeCobro('Transferencias no recibidas', d.cobros.notReceivedTransfer),
      filaDeCobro('Cobrados y luego cancelados', d.cobros.pendingRefund),
    ],
  );
  return pdf.finalizar();
}
