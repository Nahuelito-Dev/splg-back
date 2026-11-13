import { PdfBrandingService } from '../../pdf/pdf-branding.service';
import { MEMBRETE_DE_PRUEBA } from '../../pdf/datos-de-prueba';
import { RouteSheetPdfService } from './route-sheet-pdf.service';
import { RouteSheetQueryService } from './route-sheet-query.service';
import { DIST, hojaDto } from './route-sheet.fixtures';

describe('RouteSheetPdfService', () => {
  const armar = (number: number | null) => {
    const query = { detalle: jest.fn().mockResolvedValue(hojaDto({ number })) };
    const branding = {
      membreteDe: jest.fn().mockResolvedValue(MEMBRETE_DE_PRUEBA),
    };
    return {
      query,
      branding,
      svc: new RouteSheetPdfService(
        query as unknown as RouteSheetQueryService,
        branding as unknown as PdfBrandingService,
      ),
    };
  };

  it('lee la hoja y el membrete de la distribuidora; el nombre lleva el día y el número', async () => {
    const { svc, query, branding } = armar(7);
    const r = await svc.pdf(DIST, 'c0ffee00-aaaa-bbbb-cccc-000000000001');
    expect(query.detalle).toHaveBeenCalledWith(
      DIST,
      'c0ffee00-aaaa-bbbb-cccc-000000000001',
    );
    expect(branding.membreteDe).toHaveBeenCalledWith(DIST);
    expect(r.contenido.subarray(0, 5).toString()).toBe('%PDF-');
    expect(r.nombre).toBe('hoja-de-ruta-2026-11-14-0007.pdf');
  });

  it('un borrador se nombra con el comienzo del id', async () => {
    const { svc } = armar(null);
    const r = await svc.pdf(DIST, 'c0ffee00-aaaa-bbbb-cccc-000000000001');
    expect(r.nombre).toBe('hoja-de-ruta-2026-11-14-borrador-c0ffee00.pdf');
  });
});
