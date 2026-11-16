import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import { errorMessage } from '../common/errors/error-message';
import { DistributorService } from '../distributor/distributor.service';
import { S3Service } from '../s3/s3.service';
import { Membrete } from './pdf-builder';

/** Alto máximo del logo en el documento, en píxeles (se imprime a ~56 pt). */
const ALTO_MAXIMO_LOGO = 160;

/** Arma el membrete de una distribuidora: sus datos y su logo desde S3. */
@Injectable()
export class PdfBrandingService {
  private readonly logger = new Logger(PdfBrandingService.name);

  constructor(
    private readonly distribuidoras: DistributorService,
    private readonly almacenamiento: S3Service,
  ) {}

  async membreteDe(distributorId: string): Promise<Membrete> {
    const d = await this.distribuidoras.findOne(distributorId);
    return {
      nombre: d.name,
      razonSocial: d.legalName && d.legalName !== d.name ? d.legalName : null,
      cuit: d.taxId,
      contacto: [d.phone, d.email].filter(Boolean).join(' · ') || null,
      logo: d.logoKey ? await this.logo(d.logoKey) : null,
    };
  }

  /**
   * El logo se lleva a PNG: pdfkit sólo incrusta PNG y JPEG y el logo puede
   * ser WEBP. Un logo ilegible no impide emitir el documento.
   */
  private async logo(key: string): Promise<Buffer | null> {
    try {
      const original = await this.almacenamiento.get(key);
      return await sharp(original)
        .resize({ height: ALTO_MAXIMO_LOGO, withoutEnlargement: true })
        .png()
        .toBuffer();
    } catch (error) {
      this.logger.warn(
        `No se pudo leer el logo ${key}: ${errorMessage(error)}`,
      );
      return null;
    }
  }
}
