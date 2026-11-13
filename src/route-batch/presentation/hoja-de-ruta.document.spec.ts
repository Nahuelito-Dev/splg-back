import { MEMBRETE_DE_PRUEBA } from '../../pdf/datos-de-prueba';
import { textoDePdf } from '../../pdf/texto-de-pdf-de-prueba';
import { RouteMatrixSource } from '../../order/entities/route-batch.entity';
import { hojaDto } from '../application/route-sheet.fixtures';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import { renderHojaDeRuta } from './hoja-de-ruta.document';

const esPdf = (b: Buffer) => b.subarray(0, 5).toString() === '%PDF-';

describe('hoja de ruta en PDF', () => {
  it('lleva número, chofer, patente, la parada con su franja y llegada, totales y la firma', async () => {
    const pdf = await renderHojaDeRuta(hojaDto(), MEMBRETE_DE_PRUEBA);
    expect(esPdf(pdf)).toBe(true);
    const texto = textoDePdf(pdf);
    expect(texto).toContain('HOJA DE RUTA');
    expect(texto).toContain('Juan Chofer');
    expect(texto).toContain('AB123CD');
    expect(texto).toContain('Ana Gómez');
    expect(texto).toContain('08:00 a 12:00');
    expect(texto).toContain('08:20');
    expect(texto).toContain('Confirmada');
    expect(texto).toContain('Por calle');
    expect(texto).toContain('Firma del chofer');
  });

  it('un borrador sin chofer ni vehículo, en línea recta, con una parada tarde y otra sin franja', async () => {
    const base = hojaDto();
    const texto = textoDePdf(
      await renderHojaDeRuta(
        hojaDto({
          number: null,
          status: RouteBatchStatus.DRAFT,
          driverName: null,
          carPatent: null,
          matrixSource: RouteMatrixSource.HAVERSINE,
          stops: [
            { ...base.stops[0], late: true, plannedEtaAt: null },
            {
              ...base.stops[0],
              orderId: 'o2',
              sequence: 2,
              customerName: null,
              address: null,
              customerPhone: null,
              slotStart: null,
              slotEnd: null,
              slotName: null,
              etaAt: null,
              plannedEtaAt: null,
            },
          ],
        }),
        MEMBRETE_DE_PRUEBA,
      ),
    );
    expect(texto).toContain('Borrador');
    expect(texto).toContain('Sin asignar');
    expect(texto).toContain('Estimados en línea recta');
    expect(texto).toContain('(tarde)');
  });

  it('una hoja sin paradas y con un estado desconocido no rompe', async () => {
    const texto = textoDePdf(
      await renderHojaDeRuta(
        hojaDto({ stops: [], status: 'otro' as RouteBatchStatus }),
        MEMBRETE_DE_PRUEBA,
      ),
    );
    expect(texto).toContain('La hoja no tiene paradas.');
    expect(texto).toContain('otro');
  });
});
