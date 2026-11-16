import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';
import { CarService } from '../../car/car.service';
import { Car } from '../../car/entities/car.entity';
import { errorMessage } from '../../common/errors/error-message';
import {
  assertDuenoSinCambios,
  ValoresDelDueno,
} from '../../common/utils/conciliacion-de-documentos';
import { MaintenanceTaskStatus } from '../../fleet/entities/maintenance-task.entity';
import { traducirErrorDeBase } from '../../common/errors/db-exceptions';
import { sinIndefinidos } from '../../common/utils/sin-indefinidos.util';
import {
  FleetInsuranceSyncService,
  ResultadoDeLaReversion,
  ResultadoDeLaSincronizacion,
} from '../../fleet/fleet-insurance-sync.service';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { InstallmentStatus } from '../domain/insurance.enums';
import { DIAS_DE_GRACIA_POR_OMISION } from '../domain/insurance.enums';
import { generarCuotas } from '../domain/installment-plan';
import {
  CancelInsurancePolicyDto,
  CreateInsurancePolicyDto,
  FleetSyncDto,
  UpdateInsurancePolicyDto,
} from '../dto/insurance-policy.dto';
import { InsuranceInstallment } from '../entities/insurance-installment.entity';
import { InsurancePolicy } from '../entities/insurance-policy.entity';
import { Insurer } from '../entities/insurer.entity';

/** Una póliza dada de alta con lo que pasó con la tarea de seguro de flota. */
export interface PolizaCreada {
  policyId: string;
  fleet: FleetSyncDto;
}

/**
 * Pólizas de los vehículos con su plan de cuotas. Dar de alta una póliza
 * genera sus cuotas y deja la tarea de seguro de flota con el vencimiento de la
 * póliza, todo en una transacción. Renovar es dar de alta otra póliza: la
 * anterior queda como historial y las vigencias de un vehículo no se solapan.
 */
@Injectable()
export class InsurancePolicyService {
  private readonly logger = new Logger(InsurancePolicyService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cars: CarService,
    private readonly flota: FleetInsuranceSyncService,
  ) {}

  async crear(
    dto: CreateInsurancePolicyDto,
    distributorId: string,
  ): Promise<PolizaCreada> {
    const car = await this.cars.findOne(dto.carId, distributorId); // 404 «Vehículo … no encontrado»
    if (dto.validTo <= dto.validFrom) {
      throw new BadRequestException(
        'Válido hasta: la póliza tiene que vencer después de que empieza',
      );
    }
    const cuotas = generarCuotas({
      count: dto.installments.count,
      amount: dto.installments.amount,
      firstDueDate: dto.installments.firstDueDate,
      graceDays: dto.installments.graceDays ?? DIAS_DE_GRACIA_POR_OMISION,
    });
    this.assertCuotasEnVigencia(
      cuotas.map((c) => c.dueDate),
      dto.validFrom,
      dto.validTo,
    );

    try {
      return await this.dataSource.transaction(async (manager) => {
        const aseguradora = await manager.findOne(Insurer, {
          where: { insurerId: dto.insurerId, distributorId },
        });
        if (!aseguradora) {
          throw new NotFoundException('Aseguradora no encontrada');
        }
        await this.assertSinSolapamiento(
          manager,
          dto.carId,
          dto.validFrom,
          dto.validTo,
          distributorId,
        );

        const prima = cuotas.reduce((s, c) => s.plus(c.amount), new Decimal(0));
        const resultado = await this.flota.sincronizar(manager, {
          distributorId,
          carId: dto.carId,
          typeCar: car.typeCar,
          validFrom: dto.validFrom,
          validTo: dto.validTo,
          cost: prima.toDecimalPlaces(2).toNumber(),
          insurerName: aseguradora.name,
          policyNumber: dto.policyNumber,
        });

        const poliza = await manager.save(
          manager.create(InsurancePolicy, {
            distributorId,
            carId: dto.carId,
            insurerId: dto.insurerId,
            policyNumber: dto.policyNumber,
            coverage: dto.coverage,
            validFrom: dto.validFrom,
            validTo: dto.validTo,
            paymentCode: dto.paymentCode ?? null,
            cancelledAt: null,
            cancelReason: null,
            ...this.vinculoConFlota(resultado),
          }),
        );
        await manager.save(
          cuotas.map((c) =>
            manager.create(InsuranceInstallment, {
              distributorId,
              policyId: poliza.policyId,
              number: c.number,
              total: c.total,
              dueDate: c.dueDate,
              graceUntil: c.graceUntil,
              amount: c.amount.toNumber(),
              status: InstallmentStatus.PENDING,
            }),
          ),
        );
        return { policyId: poliza.policyId, fleet: this.aDto(resultado) };
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'pólizas de seguro');
    }
  }

  /** Aseguradora, número, cobertura y código de pago; la vigencia y las cuotas no se editan. */
  async modificar(
    id: string,
    dto: UpdateInsurancePolicyDto,
    distributorId: string,
  ): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        const poliza = await this.bloquear(manager, id, distributorId);
        this.assertNoCancelada(poliza, 'La póliza cancelada no se modifica');
        if (dto.insurerId && dto.insurerId !== poliza.insurerId) {
          const existe = await manager.exists(Insurer, {
            where: { insurerId: dto.insurerId, distributorId },
          });
          if (!existe) {
            throw new NotFoundException('Aseguradora no encontrada');
          }
        }
        Object.assign(poliza, sinIndefinidos({ ...dto }));
        await manager.save(poliza);
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'pólizas de seguro');
    }
  }

  /**
   * Corrige número y vigencia con lo que confirmó el administrador, dentro de
   * la transacción de la lectura. La tarea que la póliza ya tiene se corrige en
   * su lugar; sin tarea vinculada o abierta, se sincroniza como una póliza nueva.
   */
  async actualizarDesdeLectura(
    manager: EntityManager,
    id: string,
    distributorId: string,
    datos: {
      policyNumber: string;
      validFrom: string;
      validTo: string;
      patent: string | null;
      expected: ValoresDelDueno;
    },
  ): Promise<void> {
    const poliza = await this.bloquear(manager, id, distributorId);
    this.assertNoCancelada(poliza, 'La póliza cancelada no se modifica');
    const car = await manager.findOne(Car, {
      where: { carId: poliza.carId, distributorId },
      lock: { mode: 'pessimistic_read' },
    });
    if (!car) throw new NotFoundException('Vehículo no encontrado');
    assertDuenoSinCambios(datos.expected, {
      patente: car.carPatent,
      numero_de_poliza: poliza.policyNumber,
      vigencia_desde: poliza.validFrom,
      vigencia_hasta: poliza.validTo,
    });
    if (datos.patent && datos.patent !== car.carPatent) {
      throw new BadRequestException(
        'Patente: la patente leída no coincide con el vehículo de la póliza',
      );
    }
    if (datos.validTo <= datos.validFrom) {
      throw new BadRequestException(
        'Válido hasta: la póliza tiene que vencer después de que empieza',
      );
    }
    const cuotas = await manager.find(InsuranceInstallment, {
      where: { policyId: poliza.policyId, distributorId },
    });
    this.assertCuotasEnVigencia(
      cuotas
        .filter((c) => c.status !== InstallmentStatus.CANCELLED)
        .map((c) => c.dueDate)
        .sort(),
      datos.validFrom,
      datos.validTo,
    );
    poliza.policyNumber = datos.policyNumber;
    poliza.validFrom = datos.validFrom;
    poliza.validTo = datos.validTo;
    await manager.save(poliza);

    if (
      poliza.fleetTaskId &&
      (await this.flota.recalcularVencimiento(manager, {
        distributorId,
        taskId: poliza.fleetTaskId,
        validFrom: poliza.validFrom,
        validTo: poliza.validTo,
        policyNumber: poliza.policyNumber,
      }))
    ) {
      return;
    }
    const aseguradora = await manager.findOne(Insurer, {
      where: { insurerId: poliza.insurerId, distributorId },
      withDeleted: true,
    });
    if (!aseguradora) throw new NotFoundException('Aseguradora no encontrada');
    const costo = cuotas.reduce((s, c) => s.plus(c.amount), new Decimal(0));
    const resultado = await this.flota.sincronizar(manager, {
      distributorId,
      carId: car.carId,
      typeCar: car.typeCar,
      validFrom: poliza.validFrom,
      validTo: poliza.validTo,
      cost: costo.toDecimalPlaces(2).toNumber(),
      insurerName: aseguradora.name,
      policyNumber: poliza.policyNumber,
    });
    poliza.fleetPending = resultado.pending;
    if (resultado.synced) {
      poliza.fleetTaskId = resultado.taskId;
      poliza.fleetClosedTasks = [
        ...poliza.fleetClosedTasks,
        ...resultado.closedTasks,
      ];
    }
    await manager.save(poliza);
  }

  /**
   * Baja lógica con motivo: cancela también las cuotas que quedaban pendientes
   * (las pagas se conservan) y deshace en la flota lo que hizo la póliza
   * (cancela la tarea de seguro que creó y reabre las que dio por hechas).
   */
  async cancelar(
    id: string,
    dto: CancelInsurancePolicyDto,
    distributorId: string,
  ): Promise<ResultadoDeLaReversion> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const poliza = await this.bloquear(manager, id, distributorId);
        this.assertNoCancelada(poliza, 'La póliza ya está cancelada');
        poliza.cancelledAt = new Date();
        poliza.cancelReason = dto.reason;

        const cuotas = await manager.find(InsuranceInstallment, {
          where: { policyId: id, distributorId },
          lock: { mode: 'pessimistic_write' },
        });
        for (const cuota of cuotas) {
          if (cuota.status === InstallmentStatus.PENDING) {
            cuota.status = InstallmentStatus.CANCELLED;
          }
        }
        await manager.save(cuotas);

        let reversion: ResultadoDeLaReversion = { reverted: false, notes: [] };
        if (poliza.fleetTaskId || poliza.fleetClosedTasks.length > 0) {
          reversion = await this.flota.revertir(manager, {
            distributorId,
            taskId: poliza.fleetTaskId,
            closedTasks: poliza.fleetClosedTasks.map((t) => ({
              taskId: t.taskId,
              status: t.status as MaintenanceTaskStatus,
            })),
            validTo: poliza.validTo,
          });
        }
        poliza.fleetPending = false;
        await manager.save(poliza);
        return reversion;
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'pólizas de seguro');
    }
  }

  /**
   * Las pólizas que empezaron y esperaban a que venciera el seguro de flota:
   * ya se pueden sincronizar. Las usa el cron diario; devuelve cuántas quedaron
   * sincronizadas.
   */
  async completarPendientes(
    distributorId: string,
    hoy: string = diaArgentino(),
  ): Promise<number> {
    const pendientes = await this.dataSource
      .getRepository(InsurancePolicy)
      .createQueryBuilder('p')
      .where('p.distributor_id = :distributorId AND p.fleet_pending = true', {
        distributorId,
      })
      .andWhere('p.cancelled_at IS NULL AND p.valid_from <= :hoy', { hoy })
      .getMany();
    let hechas = 0;
    for (const { policyId } of pendientes) {
      try {
        if (await this.completarUna(policyId, distributorId, hoy)) hechas += 1;
      } catch (error) {
        this.logger.error(
          `No se pudo sincronizar la póliza ${policyId} con la flota: ${errorMessage(error)}`,
        );
      }
    }
    return hechas;
  }

  private completarUna(
    policyId: string,
    distributorId: string,
    hoy: string,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const poliza = await this.bloquear(manager, policyId, distributorId);
      if (poliza.cancelledAt || !poliza.fleetPending) return false;
      const [car, aseguradora, cuotas] = await Promise.all([
        this.cars.findOne(poliza.carId, distributorId),
        manager.findOneOrFail(Insurer, {
          where: { insurerId: poliza.insurerId },
          withDeleted: true,
        }),
        manager.find(InsuranceInstallment, { where: { policyId } }),
      ]);
      const prima = cuotas.reduce((s, c) => s.plus(c.amount), new Decimal(0));
      const resultado = await this.flota.sincronizar(
        manager,
        {
          distributorId,
          carId: poliza.carId,
          typeCar: car.typeCar,
          validFrom: poliza.validFrom,
          validTo: poliza.validTo,
          cost: prima.toDecimalPlaces(2).toNumber(),
          insurerName: aseguradora.name,
          policyNumber: poliza.policyNumber,
        },
        hoy,
      );
      Object.assign(poliza, this.vinculoConFlota(resultado));
      await manager.save(poliza);
      return resultado.synced;
    });
  }

  private vinculoConFlota(r: ResultadoDeLaSincronizacion) {
    return {
      fleetTaskId: r.synced ? r.taskId : null,
      fleetClosedTasks: r.closedTasks,
      fleetPending: r.pending,
    };
  }

  private aDto(r: ResultadoDeLaSincronizacion): FleetSyncDto {
    return {
      synced: r.synced,
      pending: r.pending,
      taskId: r.taskId,
      reason: r.reason,
    };
  }

  private async bloquear(
    manager: EntityManager,
    id: string,
    distributorId: string,
  ): Promise<InsurancePolicy> {
    const poliza = await manager.findOne(InsurancePolicy, {
      where: { policyId: id, distributorId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!poliza) throw new NotFoundException('Póliza no encontrada');
    return poliza;
  }

  /** `vencimientos` en orden: ninguna cuota vence fuera de la vigencia de la póliza. */
  private assertCuotasEnVigencia(
    vencimientos: string[],
    validFrom: string,
    validTo: string,
  ): void {
    if (vencimientos.length === 0) return;
    if (vencimientos[0] < validFrom) {
      throw new BadRequestException(
        'Primer vencimiento de las cuotas: la primera cuota no puede vencer antes de que empiece la póliza',
      );
    }
    if (vencimientos[vencimientos.length - 1] > validTo) {
      throw new BadRequestException(
        'Cuotas: la última cuota vence después de que vence la póliza',
      );
    }
  }

  private assertNoCancelada(poliza: InsurancePolicy, mensaje: string): void {
    if (poliza.cancelledAt) throw new ConflictException(mensaje);
  }

  /** Un vehículo no tiene dos pólizas no canceladas con vigencias solapadas (`[desde, hasta)`). */
  private async assertSinSolapamiento(
    manager: EntityManager,
    carId: string,
    validFrom: string,
    validTo: string,
    distributorId: string,
  ): Promise<void> {
    const choque = await manager
      .getRepository(InsurancePolicy)
      .createQueryBuilder('p')
      .where('p.car_id = :carId AND p.distributor_id = :distributorId', {
        carId,
        distributorId,
      })
      .andWhere('p.cancelled_at IS NULL')
      .andWhere('p.valid_from < :validTo AND p.valid_to > :validFrom', {
        validFrom,
        validTo,
      })
      .getOne();
    if (choque) {
      throw new ConflictException(
        `El vehículo ya tiene la póliza ${choque.policyNumber} vigente entre el ${choque.validFrom} y el ${choque.validTo}: cancelala o renová desde su vencimiento`,
      );
    }
  }
}
