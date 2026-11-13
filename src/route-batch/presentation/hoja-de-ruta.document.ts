import { Membrete, PdfBuilder } from '../../pdf/pdf-builder';
import {
  diaCalendario,
  fechaHora,
  numero,
  numeroDeDocumento,
} from '../../pdf/pdf-formato';
import { RouteSheetDto } from './dto/route-sheet-response.dto';

const ESTADOS: Record<string, string> = {
  draft: 'Borrador',
  confirmed: 'Confirmada',
  assigned: 'En curso',
  completed: 'Cerrada',
  dissolved: 'Cancelada',
};

const hora = (iso: string | null): string =>
  iso
    ? new Intl.DateTimeFormat('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(iso))
    : '-';

/**
 * Hoja de ruta impresa (§7.5): número, fecha, chofer, patente, salida, las
 * paradas en orden (cliente, dirección, teléfono, franja, ETA, garrafas),
 * totales y espacio para firma. El croquis del recorrido queda para después.
 */
export function renderHojaDeRuta(
  hoja: RouteSheetDto,
  membrete: Membrete,
): Promise<Buffer> {
  const pdf = new PdfBuilder(
    `Hoja de ruta ${hoja.number ?? 'borrador'}`,
    membrete,
    {
      tipo: 'HOJA DE RUTA',
      referencia: hoja.number ? numeroDeDocumento(hoja.number) : 'Borrador',
      subtitulo: `Reparto del ${diaCalendario(hoja.planDate)}`,
    },
  );

  pdf.seccion('Recorrido').datos([
    ['Chofer', hoja.driverName ?? 'Sin asignar'],
    ['Vehículo', hoja.carPatent ?? 'Sin asignar'],
    ['Salida prevista', fechaHora(hoja.plannedStartAt)],
    ['Estado', ESTADOS[hoja.status] ?? hoja.status],
    ['Confirmada', fechaHora(hoja.confirmedAt)],
    [
      'Tiempos',
      hoja.matrixSource === 'haversine'
        ? 'Estimados en línea recta'
        : 'Por calle',
    ],
  ]);

  pdf.seccion('Paradas').tabla(
    [
      { titulo: '#', peso: 1, alinear: 'right' },
      { titulo: 'Cliente', peso: 4 },
      { titulo: 'Dirección', peso: 6 },
      { titulo: 'Teléfono', peso: 3 },
      { titulo: 'Franja', peso: 3 },
      { titulo: 'Llega', peso: 2, alinear: 'right' },
      { titulo: 'Garrafas', peso: 2, alinear: 'right' },
    ],
    hoja.stops.map((s) => [
      String(s.sequence),
      s.customerName ?? '-',
      s.address ?? '-',
      s.customerPhone ?? '-',
      s.slotStart && s.slotEnd
        ? `${hora(s.slotStart)} a ${hora(s.slotEnd)}`
        : (s.slotName ?? '-'),
      `${hora(s.plannedEtaAt ?? s.etaAt)}${s.late ? ' (tarde)' : ''}`,
      numero(s.units),
    ]),
    'La hoja no tiene paradas.',
  );

  pdf.totales([
    { etiqueta: 'Paradas', valor: numero(hoja.stops.length) },
    { etiqueta: 'Garrafas a cargar', valor: numero(hoja.totals.units) },
    { etiqueta: 'Kilos de gas', valor: numero(hoja.totals.weightKg) },
    {
      etiqueta: 'Recorrido',
      valor: `${numero(hoja.totals.distanceKm)} km · ${numero(hoja.totals.durationMin)} min`,
      destacada: true,
    },
  ]);

  pdf
    .seccion('Observaciones')
    .texto(
      '\n\n\nFirma del chofer: ______________________________     Aclaración: ______________________________',
      { apagado: true },
    );

  return pdf.finalizar();
}
