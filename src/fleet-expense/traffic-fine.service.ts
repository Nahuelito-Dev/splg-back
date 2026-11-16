import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import {
  DataSource,
  EntityManager,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { CashDocumentPaymentService } from '../cash/application/cash-document-payment.service';
import { CashReferenceType, CashSystemCode } from '../cash/domain/cash.enums';
import { CarService } from '../car/car.service';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import {
  diaArgentino,
  inicioDelDiaArgentino,
} from '../common/utils/dias-argentina';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';
import {
  ChargeTrafficFineDto,
  PayTrafficFineDto,
  QueryTrafficFineDto,
  VoidTrafficFineDto,
} from './dto/traffic-fine.dto';
import {
  CreateTrafficFineV2Dto,
  UpdateTrafficFineV2Dto,
} from './dto/traffic-fine-v2.dto';
import { multaAbierta } from './domain/estados';
import { rangoDeFiltros } from './domain/rango';
import { DriverContextService } from './driver-context.service';
import { TrafficFine, TrafficFineStatus } from './entities/traffic-fine.entity';

const ACTA_REPETIDA = 'La multa ya está registrada';

/**
 * Multas de tránsito (CU-198 a CU-200, CU-323 a CU-325). El ciclo es
 * pendiente, apelada, pagada o anulada: una multa pagada o anulada no vuelve
 * atrás. Toda transición toma el lock de la fila, así dos pagos simultáneos
 * no se pisan.
 */
/** Margen para el reloj del cliente al registrar fechas «de hoy» (5 minutos). */
const MARGEN_FECHA_FUTURA_MS = 5 * 60 * 1000;

@Injectable()
export class TrafficFineService {
  private readonly logger = new Logger(TrafficFineService.name);

  constructor(
    @InjectRepository(TrafficFine)
    private readonly fines: Repository<TrafficFine>,
    private readonly dataSource: DataSource,
    private readonly cars: CarService,
    private readonly driver: DriverContextService,
    private readonly pagos: CashDocumentPaymentService,
  ) {}

  /** CU-198: nace pendiente; el responsable se deduce de quién tenía el vehículo en uso en la infracción. */
  async registrar(
    dto: CreateTrafficFineV2Dto,
    distributorId: string,
  ): Promise<TrafficFine> {
    await this.cars.findOne(dto.carId, distributorId); // 404 «Vehículo … no encontrado»
    this.assertImportes(dto.amount, dto.voluntaryPaymentAmount ?? null);
    await this.assertActaLibre(
      dto.jurisdiction,
      dto.actNumber,
      distributorId,
      null,
    );

    const occurredAt = new Date(dto.occurredAt);
    this.assertFechas(occurredAt, dto.dueDate ?? null);
    let employeeId = dto.employeeId ?? null;
    if (employeeId) {
      await this.driver.assertLegajoDeLaDistribuidora(
        employeeId,
        distributorId,
      );
    } else {
      employeeId = await this.driver.legajoDelVehiculoEn(
        dto.carId,
        distributorId,
        occurredAt,
      );
    }

    try {
      const multa = await this.fines.save(
        this.fines.create({
          distributorId,
          carId: dto.carId,
          employeeId,
          occurredAt,
          jurisdiction: dto.jurisdiction,
          actNumber: dto.actNumber,
          infraction: dto.infraction,
          amount: dto.amount,
          voluntaryPaymentAmount: dto.voluntaryPaymentAmount ?? null,
          dueDate: dto.dueDate ?? null,
          paymentUrl: dto.paymentUrl ?? null,
          paymentCode: dto.paymentCode ?? null,
          status: TrafficFineStatus.PENDING,
        }),
      );
      return await this.findOne(multa.fineId, distributorId);
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'multas');
    }
  }

  /** CU-323: corrige los datos o la pasa a apelada. */
  async modificar(
    id: string,
    dto: UpdateTrafficFineV2Dto,
    distributorId: string,
  ): Promise<TrafficFine> {
    return this.mutar(id, distributorId, async (manager, multa) => {
      this.assertAbierta(multa, 'La multa pagada o anulada no se modifica');

      const jurisdiction = dto.jurisdiction ?? multa.jurisdiction;
      const actNumber = dto.actNumber ?? multa.actNumber;
      if (
        jurisdiction !== multa.jurisdiction ||
        actNumber !== multa.actNumber
      ) {
        await this.assertActaLibre(
          jurisdiction,
          actNumber,
          distributorId,
          multa.fineId,
          manager,
        );
      }
      const amount = dto.amount ?? multa.amount;
      const voluntario =
        dto.voluntaryPaymentAmount === undefined
          ? multa.voluntaryPaymentAmount
          : dto.voluntaryPaymentAmount;
      this.assertImportes(amount, voluntario);
      this.assertFechas(
        dto.occurredAt ? new Date(dto.occurredAt) : multa.occurredAt,
        dto.dueDate === undefined ? multa.dueDate : dto.dueDate,
      );

      if (dto.appeal === true) {
        if (multa.status === TrafficFineStatus.APPEALED) {
          throw new ConflictException('La multa ya está apelada');
        }
        multa.status = TrafficFineStatus.APPEALED;
      }
      const venceOtroDia =
        dto.dueDate !== undefined && dto.dueDate !== multa.dueDate;
      Object.assign(
        multa,
        sinIndefinidos({
          occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : undefined,
          jurisdiction: dto.jurisdiction,
          actNumber: dto.actNumber,
          infraction: dto.infraction,
          amount: dto.amount,
          voluntaryPaymentAmount: dto.voluntaryPaymentAmount,
          dueDate: dto.dueDate,
          paymentUrl: dto.paymentUrl,
          paymentCode: dto.paymentCode,
        }),
      );
      // Un vencimiento nuevo vuelve a entrar en los avisos.
      if (venceOtroDia) multa.alertedAt = null;
    });
  }

  /** CU-199: la multa pendiente o apelada pasa a pagada, con lo efectivamente pagado. */
  async pagar(
    id: string,
    dto: PayTrafficFineDto,
    distributorId: string,
    userId: string,
  ): Promise<TrafficFine> {
    if (dto.paidAt > diaArgentino()) {
      throw new BadRequestException(
        'Fecha de pago: no puede ser posterior a hoy',
      );
    }
    if (dto.cashBoxId && !dto.paidInCash) {
      throw new BadRequestException(
        'Caja: sólo se indica cuando el pago es en efectivo',
      );
    }
    return this.mutar(id, distributorId, async (manager, multa) => {
      this.assertAbierta(multa, 'La multa no admite el pago');
      if (new Decimal(dto.paidAmount).gt(multa.amount)) {
        throw new BadRequestException(
          'Importe pagado: no puede superar el importe de la multa',
        );
      }
      if (dto.paidAt < diaArgentino(multa.occurredAt)) {
        throw new BadRequestException(
          'Fecha de pago: no puede ser anterior a la fecha de la infracción',
        );
      }
      multa.status = TrafficFineStatus.PAID;
      multa.paidAt = inicioDelDiaArgentino(dto.paidAt);
      multa.paidAmount = dto.paidAmount;
      if (!dto.paidInCash) return;
      const cajaId = await this.pagos.cajaDelPago(
        manager,
        distributorId,
        dto.cashBoxId,
      );
      if (!cajaId) return;
      const movimiento = await this.pagos.egresar(manager, {
        distributorId,
        cashBoxId: cajaId,
        amount: dto.paidAmount,
        systemCode: CashSystemCode.TRAFFIC_FINE,
        referenceType: CashReferenceType.TRAFFIC_FINE,
        referenceId: multa.fineId,
        description: `Pago en efectivo de la multa ${multa.actNumber} (${multa.jurisdiction})`,
        userId,
      });
      multa.cashMovementId = movimiento.movementId;
    });
  }

  /** CU-200: la asume el empleado; una multa pagada también se imputa, una anulada no. */
  async imputar(
    id: string,
    dto: ChargeTrafficFineDto,
    distributorId: string,
  ): Promise<TrafficFine> {
    if (dto.employeeId) {
      await this.driver.assertLegajoDeLaDistribuidora(
        dto.employeeId,
        distributorId,
      );
    }
    return this.mutar(id, distributorId, (_manager, multa) => {
      if (multa.status === TrafficFineStatus.VOIDED) {
        throw new ConflictException('La multa anulada no se puede imputar');
      }
      const employeeId = dto.employeeId ?? multa.employeeId;
      if (!employeeId) {
        throw new BadRequestException(
          'Empleado: indicá el empleado responsable (la multa no tiene uno)',
        );
      }
      multa.employeeId = employeeId;
      multa.chargedToEmployee = true;
    });
  }

  /** CU-324: baja lógica con motivo; la multa se conserva. */
  async anular(
    id: string,
    dto: VoidTrafficFineDto,
    distributorId: string,
  ): Promise<TrafficFine> {
    return this.mutar(id, distributorId, (_manager, multa) => {
      this.assertAbierta(multa, 'La multa pagada o anulada no se anula');
      multa.status = TrafficFineStatus.VOIDED;
      multa.voidReason = dto.reason;
      multa.voidedAt = new Date();
    });
  }

  async findOne(id: string, distributorId: string): Promise<TrafficFine> {
    const multa = await this.fines.findOne({
      where: { fineId: id, distributorId },
      relations: { car: true, employee: true },
    });
    if (!multa) {
      throw new NotFoundException('Multa no encontrada');
    }
    return multa;
  }

  /** CU-325 */
  async findAll(
    distributorId: string,
    query: QueryTrafficFineDto,
  ): Promise<{ data: TrafficFine[]; total: number }> {
    const qb: SelectQueryBuilder<TrafficFine> = this.fines
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.car', 'car')
      .leftJoinAndSelect('m.employee', 'employee')
      .where('m.distributor_id = :distributorId', { distributorId });
    if (query.carId) qb.andWhere('m.car_id = :carId', { carId: query.carId });
    if (query.employeeId) {
      qb.andWhere('m.employee_id = :employeeId', {
        employeeId: query.employeeId,
      });
    }
    if (query.status)
      qb.andWhere('m.status = :status', { status: query.status });
    const { desde, hasta } = rangoDeFiltros(query.from, query.to);
    if (desde) qb.andWhere('m.occurred_at >= :desde', { desde });
    if (hasta) qb.andWhere('m.occurred_at < :hasta', { hasta });

    const total = await qb.getCount();
    const data = await qb
      .orderBy('m.occurred_at', 'DESC')
      .addOrderBy('m.fine_id', 'ASC')
      .limit(query.limit ?? 10)
      .offset(query.offset ?? 0)
      .getMany();
    return { data, total };
  }

  /** Transición bajo el lock de la fila: 404 si no es de la distribuidora, y la devuelve ya guardada y completa. */
  private async mutar(
    id: string,
    distributorId: string,
    cambio: (
      manager: EntityManager,
      multa: TrafficFine,
    ) => void | Promise<void>,
  ): Promise<TrafficFine> {
    try {
      await this.dataSource.transaction(async (manager) => {
        const multa = await manager.getRepository(TrafficFine).findOne({
          where: { fineId: id, distributorId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!multa) {
          throw new NotFoundException('Multa no encontrada');
        }
        await cambio(manager, multa);
        await manager.getRepository(TrafficFine).save(multa);
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'multas');
    }
    return this.findOne(id, distributorId);
  }

  private assertAbierta(multa: TrafficFine, mensaje: string): void {
    if (!multaAbierta(multa.status)) {
      throw new ConflictException(mensaje);
    }
  }

  /**
   * La infracción no puede ser futura y el vencimiento no puede ser anterior al
   * día en que ocurrió (día argentino).
   */
  private assertFechas(occurredAt: Date, dueDate: string | null): void {
    if (occurredAt.getTime() > Date.now() + MARGEN_FECHA_FUTURA_MS) {
      throw new BadRequestException(
        'Fecha del hecho: la infracción no puede ser futura',
      );
    }
    if (dueDate !== null && dueDate < diaArgentino(occurredAt)) {
      throw new BadRequestException(
        'Fecha de vencimiento: el vencimiento no puede ser anterior a la fecha de la infracción',
      );
    }
  }

  private assertImportes(amount: number, voluntario: number | null): void {
    if (voluntario !== null && voluntario > amount) {
      throw new BadRequestException(
        'Importe del pago voluntario: no puede superar el importe de la multa',
      );
    }
  }

  private async assertActaLibre(
    jurisdiction: string,
    actNumber: string,
    distributorId: string,
    excluirId: string | null,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = manager ? manager.getRepository(TrafficFine) : this.fines;
    const qb = repo
      .createQueryBuilder('m')
      .where(
        'm.distributor_id = :distributorId AND m.jurisdiction = :jurisdiction AND m.act_number = :actNumber',
        { distributorId, jurisdiction, actNumber },
      );
    if (excluirId) qb.andWhere('m.fine_id <> :excluirId', { excluirId });
    if ((await qb.getCount()) > 0) {
      throw new ConflictException(ACTA_REPETIDA);
    }
  }
}
