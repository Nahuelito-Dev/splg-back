import {
  Inject,
  Injectable,
  Logger,
  Optional,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AttachmentMapper } from '../attachment/attachment.mapper';
import { AttachmentService } from '../attachment/attachment.service';
import type {
  AttachmentActor,
  DuenoDelAdjunto,
} from '../attachment/attachment.service';
import { AttachmentResponseDto } from '../attachment/dto/attachment-response.dto';
import type { SignedDownload } from '../s3/s3.service';
import type { Disposicion } from '../s3/content-disposition';
import {
  Attachment,
  AttachmentOwnerType,
} from '../attachment/entities/attachment.entity';
import { errorMessage } from '../common/errors/error-message';
import {
  EVENTO_NOTIFICAR_ADMIN,
  NotificarAdminEvent,
} from '../common/events/notificar-admin.event';
import { esMimeTypePermitido } from '../common/utils/attachment-rules';
import { CarService } from '../car/car.service';
import { normalizarPatente } from '../car/patente.util';
import { DocumentReadingService } from '../document-reading/document-reading.service';
import { CampoLeido } from '../document-reader/document-reader.port';
import { TipoDeDocumento } from '../document-reader/tipos-de-documento';
import {
  CarDocumentScanDataDto,
  CarDocumentScanDto,
  TipoDeDocumentoDeVehiculo,
  UploadedCarDocumentDto,
  UploadedPatentPhotoDto,
} from './dto/car-document.dto';

/** Cuánto se espera al lector antes de dejar la subida sin datos precargados. */
export const TOPE_DEL_ESCANEO_MS = 30_000;
/** Token del tope (las pruebas lo achican para no esperar 30 s). */
export const TOPE_DEL_ESCANEO = 'CAR_DOCUMENT_SCAN_TIMEOUT_MS';

const SIN_LECTURA = 'No se pudo escanear el documento: cargá los datos a mano';
const ETIQUETA_FOTO_DE_PATENTE = 'Foto de patente';
const MIME_DE_FOTO: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];

const ETIQUETAS: Record<TipoDeDocumentoDeVehiculo, string> = {
  [TipoDeDocumentoDeVehiculo.SEGURO]: 'Documento de seguro del vehículo',
  [TipoDeDocumentoDeVehiculo.VTV]: 'VTV del vehículo',
  [TipoDeDocumentoDeVehiculo.CEDULA]: 'Cédula del vehículo',
  [TipoDeDocumentoDeVehiculo.OTRO]: 'Documento del vehículo',
};

const TIPOS_ESPERADOS: Record<
  TipoDeDocumentoDeVehiculo,
  TipoDeDocumento | undefined
> = {
  [TipoDeDocumentoDeVehiculo.SEGURO]: TipoDeDocumento.POLIZA,
  [TipoDeDocumentoDeVehiculo.VTV]: TipoDeDocumento.REVISION_TECNICA,
  [TipoDeDocumentoDeVehiculo.CEDULA]: TipoDeDocumento.CEDULA_DEL_VEHICULO,
  [TipoDeDocumentoDeVehiculo.OTRO]: undefined,
};

@Injectable()
export class CarDocumentsService {
  private readonly logger = new Logger(CarDocumentsService.name);

  constructor(
    private readonly attachments: AttachmentService,
    private readonly readings: DocumentReadingService,
    private readonly cars: CarService,
    private readonly events: EventEmitter2,
    @Optional()
    @Inject(TOPE_DEL_ESCANEO)
    private readonly topeDelEscaneoMs: number = TOPE_DEL_ESCANEO_MS,
  ) {}

  /** Documentos y fotos de patente del vehículo, los más nuevos primero. */
  async list(
    carId: string,
    distributorId: string,
    actor: AttachmentActor,
  ): Promise<AttachmentResponseDto[]> {
    // El resolver del dueño da el 404 «Vehículo no encontrado» (tenant).
    const adjuntos = await this.attachments.list(
      AttachmentOwnerType.CAR_DOCUMENT,
      carId,
      distributorId,
      actor,
      true,
    );
    return adjuntos.map((a) => AttachmentMapper.toDto(a));
  }

  /** URL firmada de un documento del vehículo (404 si no es de ese vehículo). */
  async downloadLink(
    carId: string,
    attachmentId: string,
    distributorId: string,
    actor: AttachmentActor,
    disposition?: Disposicion,
  ): Promise<SignedDownload> {
    await this.cars.findOne(carId, distributorId);
    return this.attachments.getSignedDownload(
      attachmentId,
      distributorId,
      actor,
      disposition,
      this.duenoDe(carId),
    );
  }

  /** URL firmada para redirigir (302). */
  async downloadUrl(
    carId: string,
    attachmentId: string,
    distributorId: string,
    actor: AttachmentActor,
    disposition?: Disposicion,
  ): Promise<string> {
    await this.cars.findOne(carId, distributorId);
    return this.attachments.getDownload(
      attachmentId,
      distributorId,
      actor,
      disposition,
      this.duenoDe(carId),
    );
  }

  /** Baja lógica de un documento del vehículo (el archivo queda de respaldo). */
  async remove(
    carId: string,
    attachmentId: string,
    distributorId: string,
    actor: AttachmentActor,
  ): Promise<void> {
    await this.cars.findOne(carId, distributorId);
    await this.attachments.removeDelDueno(
      attachmentId,
      this.duenoDe(carId),
      distributorId,
      actor,
    );
  }

  private duenoDe(carId: string): DuenoDelAdjunto {
    return { ownerType: AttachmentOwnerType.CAR_DOCUMENT, ownerId: carId };
  }

  async uploadDocument(
    carId: string,
    documentType: TipoDeDocumentoDeVehiculo,
    file: Express.Multer.File | undefined,
    distributorId: string,
    actor: AttachmentActor,
  ): Promise<UploadedCarDocumentDto> {
    await this.cars.findOne(carId, distributorId);
    if (file && !esMimeTypePermitido(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        'El documento tiene que ser un PDF o una imagen (JPG, PNG o WEBP)',
      );
    }
    const attachment = await this.attachments.upload(
      AttachmentOwnerType.CAR_DOCUMENT,
      carId,
      distributorId,
      file,
      ETIQUETAS[documentType],
      actor,
    );
    const scan = await this.scan(
      attachment,
      distributorId,
      file,
      TIPOS_ESPERADOS[documentType],
    );
    return { attachment: AttachmentMapper.toDto(attachment), scan };
  }

  async uploadPatentPhoto(
    carId: string,
    file: Express.Multer.File | undefined,
    distributorId: string,
    actor: AttachmentActor,
  ): Promise<UploadedPatentPhotoDto> {
    const car = await this.cars.findOne(carId, distributorId);
    if (file && !MIME_DE_FOTO.includes(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        'La foto de la patente tiene que ser una imagen JPG, PNG o WEBP',
      );
    }
    const attachment = await this.attachments.upload(
      AttachmentOwnerType.CAR_DOCUMENT,
      carId,
      distributorId,
      file,
      ETIQUETA_FOTO_DE_PATENTE,
      actor,
    );
    const scan = await this.scan(
      attachment,
      distributorId,
      file,
      TipoDeDocumento.FOTO_DE_PATENTE,
    );
    const leida = scan.data?.patent;
    const readPatent = leida ? normalizarPatente(leida) : null;
    const expectedPatent = car.carPatent;
    const mismatch = Boolean(
      expectedPatent &&
        readPatent &&
        normalizarPatente(expectedPatent) !== readPatent,
    );
    let warning: string | null = null;
    if (mismatch) {
      warning = `La patente de la foto (${readPatent}) no coincide con la del vehículo (${expectedPatent}): revisá la foto o corregí la patente`;
      this.events.emit(
        EVENTO_NOTIFICAR_ADMIN,
        new NotificarAdminEvent(
          distributorId,
          'car_patent_mismatch',
          'La patente de la foto no coincide con el vehículo',
          `Se subió una foto de patente del vehículo ${expectedPatent} en la que se lee ${readPatent}. Revisá la foto o corregí la patente cargada.`,
          { entity: 'car', id: carId },
          false,
          // Un aviso por hecho (vehículo, patente cargada, patente leída), no
          // por foto: subir otra foto con la misma patente equivocada no
          // repite el aviso; corregir la patente o leer otra, sí.
          `car-patent-mismatch:${carId}:${normalizarPatente(expectedPatent ?? '')}:${readPatent}`,
        ),
      );
    }
    return {
      attachment: AttachmentMapper.toDto(attachment),
      scan,
      mismatch,
      expectedPatent,
      readPatent,
      warning,
    };
  }

  /**
   * Escanea en el mismo pedido, como el comprobante de una cuota de seguro: sin
   * lector no se intenta, y un lector que falla o se cuelga nunca rompe la
   * subida (el archivo ya quedó guardado y los datos se cargan a mano).
   */
  private async scan(
    attachment: Attachment,
    distributorId: string,
    file: Express.Multer.File | undefined,
    tipoEsperado: TipoDeDocumento | undefined,
  ): Promise<CarDocumentScanDto> {
    const scan: CarDocumentScanDto = {
      available: this.readings.disponible,
      data: null,
    };
    if (!this.readings.disponible || !file) return scan;
    let temporizador: NodeJS.Timeout | undefined;
    try {
      const tope = new Promise<'tiempo'>((resolver) => {
        temporizador = setTimeout(
          () => resolver('tiempo'),
          this.topeDelEscaneoMs,
        );
      });
      const result = await Promise.race([
        this.readings.leerAdjunto({
          attachmentId: attachment.attachmentId,
          distributorId,
          archivo: { buffer: file.buffer, mimeType: attachment.mimeType },
          opciones: tipoEsperado ? { tipoEsperado } : undefined,
        }),
        tope,
      ]);
      if (result === 'tiempo') {
        scan.warning =
          'El escaneo del documento tardó demasiado: cargá los datos a mano';
        this.logger.warn(
          `El lector tardó más de ${this.topeDelEscaneoMs / 1000} s con el adjunto ${attachment.attachmentId}`,
        );
      } else if (result.lectura) {
        scan.data = this.scanData(
          result.lectura.tipo,
          result.lectura.campos,
          result.lectura.avisos,
        );
      } else {
        scan.warning = SIN_LECTURA;
      }
    } catch (error) {
      scan.warning = SIN_LECTURA;
      this.logger.warn(
        `No se pudo leer el adjunto ${attachment.attachmentId}: ${errorMessage(error)}`,
      );
    } finally {
      clearTimeout(temporizador);
    }
    return scan;
  }

  private scanData(
    detectedType: TipoDeDocumento,
    fields: CampoLeido[],
    warnings: string[],
  ): CarDocumentScanDataDto {
    const value = (name: string): string | null =>
      fields.find((field) => field.nombre === name)?.valor ?? null;
    return {
      detectedType,
      expirationDate: value('vencimiento') ?? value('vigencia_hasta'),
      issueDate: value('fecha_de_revision') ?? value('vigencia_desde'),
      insurer: value('aseguradora'),
      policyNumber: value('numero_de_poliza'),
      patent: value('patente'),
      warnings,
    };
  }
}
