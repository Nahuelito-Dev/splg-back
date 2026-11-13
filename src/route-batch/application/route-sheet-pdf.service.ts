import { Injectable } from '@nestjs/common';
import { PdfBrandingService } from '../../pdf/pdf-branding.service';
import { renderHojaDeRuta } from '../presentation/hoja-de-ruta.document';
import { RouteSheetQueryService } from './route-sheet-query.service';

/** La hoja de ruta en PDF, con la marca de la distribuidora (§7.5). */
@Injectable()
export class RouteSheetPdfService {
  constructor(
    private readonly query: RouteSheetQueryService,
    private readonly branding: PdfBrandingService,
  ) {}

  async pdf(
    distributorId: string,
    id: string,
  ): Promise<{ contenido: Buffer; nombre: string }> {
    const hoja = await this.query.detalle(distributorId, id);
    const contenido = await renderHojaDeRuta(
      hoja,
      await this.branding.membreteDe(distributorId),
    );
    const sufijo = hoja.number
      ? String(hoja.number).padStart(4, '0')
      : `borrador-${id.slice(0, 8)}`;
    return { contenido, nombre: `hoja-de-ruta-${hoja.planDate}-${sufijo}.pdf` };
  }
}
