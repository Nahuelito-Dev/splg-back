import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { CarService } from '../car/car.service';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import {
  diaArgentino,
  inicioDelDiaArgentino,
} from '../common/utils/dias-argentina';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';
import {
  ChargeTrafficFineDto,
  CreateTrafficFineDto,
  PayTrafficFineDto,
  QueryTrafficFineDto,
  UpdateTrafficFineDto,
  VoidTrafficFineDto,
} from './dto/traffic-fine.dto';
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
@Injectable()
export class TrafficFineService {
  private readonly logger = new Logger(TrafficFineService.name);

  constructor(
    @InjectRepository(TrafficFine)
    private readonly fines: Repository<TrafficFine>,
    private readonly dataSource: DataSource,
    private readonly cars: CarService,
    private readonly driver: DriverContextService,
  ) {}

  /** CU-198: nace pendiente; el responsable se deduce de quién tenía el vehículo en uso en la infracción. */
  async registrar(
    dto: CreateTrafficFineDto,
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
    dto: UpdateTrafficFineDto,
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
        }),
      );
      // Una fecha de vencimiento nueva vuelve a entrar en el aviso diario.
      if (venceOtroDia) multa.alertedAt = null;
    });
  }

  /** CU-199: la multa pendiente o apelada pasa a pagada, con lo efectivamente pagado. */
  async pagar(
    id: string,
    dto: PayTrafficFineDto,
    distributorId: string,
  ): Promise<TrafficFine> {
    if (dto.paidAt > diaArgentino()) {
      throw new BadRequestException('paidAt: no puede ser posterior a hoy');
    }
    return this.mutar(id, distributorId, (_manager, multa) => {
      this.assertAbierta(multa, 'La multa no admite el pago');
      multa.status = TrafficFineStatus.PAID;
      multa.paidAt = inicioDelDiaArgentino(dto.paidAt);
      multa.paidAmount = dto.paidAmount;
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
          'employeeId: indicá el empleado responsable (la multa no tiene uno)',
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
      throw new NotFoundException(`Multa ${id} no encontrada`);
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
          throw new NotFoundException(`Multa ${id} no encontrada`);
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

  private assertImportes(amount: number, voluntario: number | null): void {
    if (voluntario !== null && voluntario > amount) {
      throw new BadRequestException(
        'voluntaryPaymentAmount: no puede superar el importe de la multa',
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
