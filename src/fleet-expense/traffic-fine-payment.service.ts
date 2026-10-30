import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource } from 'typeorm';
import { AttachmentService } from '../attachment/attachment.service';
import type { AttachmentActor } from '../attachment/attachment.service';
import { AttachmentOwnerType } from '../attachment/entities/attachment.entity';
import { CashDocumentPaymentService } from '../cash/application/cash-document-payment.service';
import {
  CashBoxKind,
  CashReferenceType,
  CashSystemCode,
} from '../cash/domain/cash.enums';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { errorMessage } from '../common/errors/error-message';
import { esMimeTypePermitido } from '../common/utils/attachment-rules';
import { diaArgentino } from '../common/utils/dias-argentina';
import {
  ReceiptScanDto,
  UploadedReceiptDto,
} from '../insurance/dto/insurance-installment.dto';
import { instanteDelPago } from '../insurance/domain/payment-date';
import { ReceiptReaderPort } from '../receipt-reader/receipt-reader.port';
import { PayTrafficFineV2Dto } from './dto/traffic-fine-v2.dto';
import { multaAbierta } from './domain/estados';
import { TrafficFineService } from './traffic-fine.service';
import { TrafficFine, TrafficFineStatus } from './entities/traffic-fine.entity';

/** Margen para el reloj del cliente al registrar «cuándo se pagó» (5 minutos). */
const MARGEN_FECHA_FUTURA_MS = 5 * 60 * 1000;

/** Cuánto se espera al lector antes de dejar la subida sin datos precargados. */
export const TOPE_DEL_ESCANEO_MS = 30_000;

export const ETIQUETA_COMPROBANTE_DE_MULTA = 'Comprobante de pago de la multa';

/** Las tres clases de caja de las que puede salir el pago de una multa. */
const CAJAS_DEL_PAGO: readonly CashBoxKind[] = [
  CashBoxKind.CASH,
  CashBoxKind.BANK,
  CashBoxKind.WALLET,
];

/**
 * Pago de multas con comprobante (F15, API v2): el comprobante se sube y se
 * escanea en el mismo pedido, y pagar es una transacción con la multa
 * bloqueada que saca el egreso de la caja elegida y la deja paga.
 */
@Injectable()
export class TrafficFinePaymentService {
  private readonly logger = new Logger(TrafficFinePaymentService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly multas: TrafficFineService,
    private readonly attachments: AttachmentService,
    private readonly pagos: CashDocumentPaymentService,
    private readonly lector: ReceiptReaderPort,
  ) {}

  /**
   * Guarda el comprobante como adjunto de la multa y, en el mismo pedido, lo
   * escanea para precargar el formulario. Sin lector (`available: false`) o si
   * el escaneo falla, la subida igual vale.
   */
  async subirComprobante(
    id: string,
    file: Express.Multer.File | undefined,
    distributorId: string,
    actor: AttachmentActor,
  ): Promise<UploadedReceiptDto> {
    const multa = await this.multas.findOne(id, distributorId);
    if (!multaAbierta(multa.status)) {
      throw new ConflictException('La multa no admite un comprobante nuevo');
    }
    if (file && !esMimeTypePermitido(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        `El comprobante tiene que ser un PDF o una imagen (JPG, PNG, WEBP) (${file.mimetype})`,
      );
    }
    const adjunto = await this.attachments.upload(
      AttachmentOwnerType.TRAFFIC_FINE_PAYMENT,
      id,
      distributorId,
      file,
      ETIQUETA_COMPROBANTE_DE_MULTA,
      actor,
    );
    const dto = new UploadedReceiptDto();
    dto.attachmentId = adjunto.attachmentId;
    dto.scan = await this.escanear(file, adjunto.mimeType, multa);
    return dto;
  }

  /** Egreso en la caja elegida y multa paga, bajo el lock de la multa. */
  async pagar(
    id: string,
    dto: PayTrafficFineV2Dto,
    distributorId: string,
    userId: string,
  ): Promise<void> {
    const pagadoEn = instanteDelPago(dto.paidAt);
    if (Number.isNaN(pagadoEn.getTime())) {
      throw new BadRequestException('paidAt: fecha inválida');
    }
    if (pagadoEn.getTime() > Date.now() + MARGEN_FECHA_FUTURA_MS) {
      throw new BadRequestException('paidAt: no puede ser posterior a hoy');
    }
    try {
      await this.dataSource.transaction(async (manager) => {
        const multa = await manager.findOne(TrafficFine, {
          where: { fineId: id, distributorId },
          relations: { car: true },
          lock: { mode: 'pessimistic_write', tables: ['traffic_fine'] },
        });
        if (!multa) throw new NotFoundException(`Multa ${id} no encontrada`);
        if (multa.status === TrafficFineStatus.PAID) {
          throw new ConflictException('La multa ya está paga');
        }
        if (!multaAbierta(multa.status)) {
          throw new ConflictException('La multa anulada no admite el pago');
        }
        if (new Decimal(dto.amount).gt(multa.amount)) {
          throw new BadRequestException(
            'amount: no puede superar el importe de la multa',
          );
        }
        if (diaArgentino(pagadoEn) < diaArgentino(multa.occurredAt)) {
          throw new BadRequestException(
            'paidAt: no puede ser anterior a la fecha de la infracción',
          );
        }
        const comprobante = await this.attachments.findDelDueno(
          manager,
          dto.attachmentId,
          AttachmentOwnerType.TRAFFIC_FINE_PAYMENT,
          id,
          distributorId,
        );
        if (!comprobante) {
          throw new BadRequestException(
            'attachmentId: el comprobante no existe o no es de esta multa',
          );
        }
        if (!esMimeTypePermitido(comprobante.mimeType)) {
          throw new BadRequestException(
            'attachmentId: el comprobante tiene que ser un PDF o una imagen (JPG, PNG, WEBP)',
          );
        }
        const cajaId = await this.pagos.cajaDelPago(
          manager,
          distributorId,
          dto.cashBoxId,
          CAJAS_DEL_PAGO,
        );
        if (!cajaId) {
          throw new BadRequestException('cashBoxId: indicá la caja del pago');
        }
        const movimiento = await this.pagos.egresar(manager, {
          distributorId,
          cashBoxId: cajaId,
          amount: dto.amount,
          systemCode: CashSystemCode.TRAFFIC_FINE,
          referenceType: CashReferenceType.TRAFFIC_FINE,
          referenceId: id,
          description: `Multa ${multa.actNumber} — ${multa.jurisdiction} (${multa.car?.carPatent ?? multa.carId})`,
          userId,
          method: await this.pagos.medioDeLaCaja(
            manager,
            distributorId,
            cajaId,
          ),
        });

        multa.status = TrafficFineStatus.PAID;
        multa.paidAt = pagadoEn;
        multa.paidAmount = dto.amount;
        multa.operationNumber = dto.operationNumber ?? null;
        multa.cashMovementId = movimiento.movementId;
        multa.receiptAttachmentId = comprobante.attachmentId;
        await manager.save(multa);
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'multas');
    }
  }

  /** El voluntario si todavía vale (sin vencimiento o no vencido); si no, el importe de la multa. */
  private importeEsperado(multa: TrafficFine): string {
    const vigente =
      multa.voluntaryPaymentAmount !== null &&
      (multa.dueDate === null || multa.dueDate >= diaArgentino());
    return new Decimal(
      vigente ? (multa.voluntaryPaymentAmount ?? multa.amount) : multa.amount,
    ).toFixed(2);
  }

  private async escanear(
    file: Express.Multer.File | undefined,
    mimeType: string,
    multa: TrafficFine,
  ): Promise<ReceiptScanDto> {
    const escaneo = new ReceiptScanDto();
    escaneo.available = this.lector.disponible;
    escaneo.data = null;
    if (!this.lector.disponible || !file) return escaneo;
    let temporizador: NodeJS.Timeout | undefined;
    try {
      const tope = new Promise<'tiempo'>((resolver) => {
        temporizador = setTimeout(
          () => resolver('tiempo'),
          TOPE_DEL_ESCANEO_MS,
        );
      });
      const leido = await Promise.race([
        this.lector.leer(
          { buffer: file.buffer, mimeType },
          {
            expectedAmount: this.importeEsperado(multa),
            payee: multa.jurisdiction,
          },
        ),
        tope,
      ]);
      if (leido === 'tiempo') {
        escaneo.warning =
          'La lectura del comprobante tardó demasiado: cargá los datos a mano';
        this.logger.warn(
          `El lector tardó más de ${TOPE_DEL_ESCANEO_MS / 1000} s con el comprobante de la multa ${multa.fineId}`,
        );
      } else {
        escaneo.data = leido;
      }
    } catch (error) {
      escaneo.warning =
        'No se pudo leer el comprobante: cargá los datos a mano';
      // Un escaneo que falla nunca rompe la subida: el admin carga los datos a mano.
      this.logger.warn(
        `No se pudo leer el comprobante de la multa ${multa.fineId}: ${errorMessage(error)}`,
      );
    } finally {
      clearTimeout(temporizador);
    }
    return escaneo;
  }
}
