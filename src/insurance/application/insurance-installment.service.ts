import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AttachmentService } from '../../attachment/attachment.service';
import type { AttachmentActor } from '../../attachment/attachment.service';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';
import { CashDocumentPaymentService } from '../../cash/application/cash-document-payment.service';
import {
  CashBoxKind,
  CashReferenceType,
  CashSystemCode,
} from '../../cash/domain/cash.enums';
import { traducirErrorDeBase } from '../../common/errors/db-exceptions';
import { errorMessage } from '../../common/errors/error-message';
import { esMimeTypePermitido } from '../../common/utils/attachment-rules';
import { diasEntre, sumarDias } from '../../common/utils/dias-argentina';
import { sinIndefinidos } from '../../common/utils/sin-indefinidos.util';
import {
  PayInsuranceInstallmentDto,
  ReceiptScanDto,
  UpdateInsuranceInstallmentDto,
  UploadedReceiptDto,
} from '../dto/insurance-installment.dto';
import { instanteDelPago } from '../domain/payment-date';
import { InstallmentStatus } from '../domain/insurance.enums';
import { InsuranceInstallment } from '../entities/insurance-installment.entity';
import { InsurancePolicy } from '../entities/insurance-policy.entity';
import { ReceiptReaderPort } from '../../receipt-reader/receipt-reader.port';

/** Margen para el reloj del cliente al registrar «cuándo se pagó» (5 minutos). */
const MARGEN_FECHA_FUTURA_MS = 5 * 60 * 1000;

/** Cuánto se espera al lector antes de dejar la subida sin datos precargados. */
export const TOPE_DEL_ESCANEO_MS = 30_000;

export const ETIQUETA_COMPROBANTE_DE_CUOTA = 'Comprobante de pago del seguro';

/** Las tres clases de caja de las que puede salir el pago de una cuota. */
const CAJAS_DEL_PAGO: readonly CashBoxKind[] = [
  CashBoxKind.CASH,
  CashBoxKind.BANK,
  CashBoxKind.WALLET,
];

/**
 * Cuotas del seguro: corregir fecha o importe mientras estén pendientes, subir
 * el comprobante (que se escanea apenas se sube) y pagar. Pagar es una
 * transacción con la cuota bloqueada: valida el comprobante, saca el egreso de
 * la caja elegida y deja la cuota paga.
 */
@Injectable()
export class InsuranceInstallmentService {
  private readonly logger = new Logger(InsuranceInstallmentService.name);

  constructor(
    @InjectRepository(InsuranceInstallment)
    private readonly installments: Repository<InsuranceInstallment>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly attachments: AttachmentService,
    private readonly pagos: CashDocumentPaymentService,
    private readonly lector: ReceiptReaderPort,
  ) {}

  async findOne(
    id: string,
    distributorId: string,
  ): Promise<InsuranceInstallment> {
    const cuota = await this.installments.findOne({
      where: { installmentId: id, distributorId },
      relations: { policy: { insurer: true, car: true } },
      withDeleted: true, // la aseguradora dada de baja sigue figurando
    });
    if (!cuota) throw new NotFoundException('Cuota no encontrada');
    return cuota;
  }

  /**
   * Corrige vencimiento, gracia o importe de una cuota pendiente. Si sólo se
   * mueve el vencimiento, la gracia se corre con él (conserva sus días); el
   * vencimiento tiene que caer dentro de la vigencia de la póliza.
   */
  async modificar(
    id: string,
    dto: UpdateInsuranceInstallmentDto,
    distributorId: string,
  ): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        const cuota = await this.bloquear(manager, id, distributorId);
        this.assertPendiente(cuota, 'Sólo se corrige una cuota pendiente');
        if (dto.dueDate !== undefined) {
          const poliza = await manager.findOneOrFail(InsurancePolicy, {
            where: { policyId: cuota.policyId, distributorId },
          });
          if (dto.dueDate < poliza.validFrom || dto.dueDate > poliza.validTo) {
            throw new BadRequestException(
              `Fecha de vencimiento: el vencimiento tiene que caer dentro de la vigencia de la póliza (${poliza.validFrom} a ${poliza.validTo})`,
            );
          }
          if (dto.graceUntil === undefined) {
            cuota.graceUntil = sumarDias(
              dto.dueDate,
              diasEntre(cuota.dueDate, cuota.graceUntil),
            );
          }
        }
        Object.assign(cuota, sinIndefinidos({ ...dto }));
        if (cuota.graceUntil < cuota.dueDate) {
          throw new BadRequestException(
            'Gracia hasta: la gracia no puede ser anterior al vencimiento',
          );
        }
        await manager.save(cuota);
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'cuotas de seguro');
    }
  }

  /**
   * Guarda el comprobante como adjunto de la cuota y, en el mismo pedido, lo
   * escanea para precargar el formulario de pago. Sin lector configurado
   * (`available: false`) o si el escaneo falla, la subida igual vale.
   */
  async subirComprobante(
    id: string,
    file: Express.Multer.File | undefined,
    distributorId: string,
    actor: AttachmentActor,
  ): Promise<UploadedReceiptDto> {
    const cuota = await this.findOne(id, distributorId);
    this.assertPendiente(cuota, 'La cuota no admite un comprobante nuevo');
    if (file && !esMimeTypePermitido(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        `El comprobante tiene que ser un PDF o una imagen (JPG, PNG, WEBP) (${file.mimetype})`,
      );
    }
    const adjunto = await this.attachments.upload(
      AttachmentOwnerType.INSURANCE_INSTALLMENT,
      id,
      distributorId,
      file,
      ETIQUETA_COMPROBANTE_DE_CUOTA,
      actor,
    );
    const dto = new UploadedReceiptDto();
    dto.attachmentId = adjunto.attachmentId;
    dto.scan = await this.escanear(file, adjunto.mimeType, cuota);
    return dto;
  }

  /** Egreso en la caja elegida y cuota paga, bajo el lock de la cuota. */
  async pagar(
    id: string,
    dto: PayInsuranceInstallmentDto,
    distributorId: string,
    userId: string,
  ): Promise<void> {
    const pagadoEn = instanteDelPago(dto.paidAt);
    if (Number.isNaN(pagadoEn.getTime())) {
      throw new BadRequestException('Fecha de pago: fecha inválida');
    }
    if (pagadoEn.getTime() > Date.now() + MARGEN_FECHA_FUTURA_MS) {
      throw new BadRequestException(
        'Fecha de pago: no puede ser posterior a hoy',
      );
    }
    try {
      await this.dataSource.transaction(async (manager) => {
        const cuota = await this.bloquear(manager, id, distributorId);
        if (cuota.status === InstallmentStatus.PAID) {
          throw new ConflictException('La cuota ya está paga');
        }
        this.assertPendiente(
          cuota,
          'La cuota está cancelada: no admite el pago',
        );

        const comprobante = await this.attachments.findDelDueno(
          manager,
          dto.attachmentId,
          AttachmentOwnerType.INSURANCE_INSTALLMENT,
          id,
          distributorId,
        );
        if (!comprobante) {
          throw new BadRequestException(
            'Archivo adjunto: el comprobante no existe o no es de esta cuota',
          );
        }

        if (!esMimeTypePermitido(comprobante.mimeType)) {
          throw new BadRequestException(
            'Archivo adjunto: el comprobante tiene que ser un PDF o una imagen (JPG, PNG, WEBP)',
          );
        }

        const poliza = await manager.findOneOrFail(InsurancePolicy, {
          where: { policyId: cuota.policyId, distributorId },
          relations: { insurer: true, car: true },
          withDeleted: true,
        });
        const cajaId = await this.pagos.cajaDelPago(
          manager,
          distributorId,
          dto.cashBoxId,
          CAJAS_DEL_PAGO,
        );
        if (!cajaId) {
          throw new BadRequestException('Caja: indicá la caja del pago');
        }
        const movimiento = await this.pagos.egresar(manager, {
          distributorId,
          cashBoxId: cajaId,
          amount: dto.amount,
          systemCode: CashSystemCode.INSURANCE,
          referenceType: CashReferenceType.INSURANCE_INSTALLMENT,
          referenceId: id,
          description: `Seguro ${poliza.car?.carPatent ?? poliza.carId} — ${poliza.insurer?.name ?? ''}, cuota ${cuota.number}/${cuota.total}`,
          userId,
          method: await this.pagos.medioDeLaCaja(
            manager,
            distributorId,
            cajaId,
          ),
        });

        cuota.status = InstallmentStatus.PAID;
        cuota.paidAt = pagadoEn;
        cuota.paidAmount = dto.amount;
        cuota.operationNumber = dto.operationNumber ?? null;
        cuota.paidByUserId = userId;
        cuota.cashMovementId = movimiento.movementId;
        cuota.receiptAttachmentId = comprobante.attachmentId;
        await manager.save(cuota);
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'cuotas de seguro');
    }
  }

  private async escanear(
    file: Express.Multer.File | undefined,
    mimeType: string,
    cuota: InsuranceInstallment,
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
            expectedAmount: cuota.amount.toFixed(2),
            payee: cuota.policy?.insurer?.name,
          },
        ),
        tope,
      ]);
      if (leido === 'tiempo') {
        escaneo.warning =
          'La lectura del comprobante tardó demasiado: cargá los datos a mano';
        this.logger.warn(
          `El lector tardó más de ${TOPE_DEL_ESCANEO_MS / 1000} s con el comprobante de la cuota ${cuota.installmentId}`,
        );
      } else {
        escaneo.data = leido;
      }
    } catch (error) {
      escaneo.warning =
        'No se pudo leer el comprobante: cargá los datos a mano';
      // Un escaneo que falla nunca rompe la subida: el admin carga los datos a mano.
      this.logger.warn(
        `No se pudo leer el comprobante de la cuota ${cuota.installmentId}: ${errorMessage(error)}`,
      );
    } finally {
      clearTimeout(temporizador);
    }
    return escaneo;
  }

  private async bloquear(
    manager: EntityManager,
    id: string,
    distributorId: string,
  ): Promise<InsuranceInstallment> {
    const cuota = await manager.findOne(InsuranceInstallment, {
      where: { installmentId: id, distributorId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!cuota) throw new NotFoundException('Cuota no encontrada');
    return cuota;
  }

  private assertPendiente(cuota: InsuranceInstallment, mensaje: string): void {
    if (cuota.status !== InstallmentStatus.PENDING) {
      throw new ConflictException(mensaje);
    }
  }
}
