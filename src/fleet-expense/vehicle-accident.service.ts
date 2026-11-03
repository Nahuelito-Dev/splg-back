import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { CarService } from '../car/car.service';
import { FleetStatus } from '../car/entities/car.entity';
import { VehicleAssignmentService } from '../car/vehicle-assignment.service';
import { puntoDesdeLatLng } from '../common/geo/punto';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';
import {
  CloseVehicleAccidentDto,
  CreateMyVehicleAccidentDto,
  CreateVehicleAccidentDto,
  QueryVehicleAccidentDto,
  UpdateVehicleAccidentDto,
} from './dto/vehicle-accident.dto';
import { transicionDeSiniestroValida } from './domain/estados';
import { rangoDeFiltros } from './domain/rango';
import { DriverContextService } from './driver-context.service';
import {
  VehicleAccident,
  VehicleAccidentStatus,
} from './entities/vehicle-accident.entity';
import {
  EVENTO_SINIESTRO_CON_ASIGNACION_PENDIENTE,
  EVENTO_SINIESTRO_CON_DERRAME,
  SiniestroConAsignacionPendienteEvent,
  SiniestroConDerrameEvent,
} from './events/fleet-expense.events';

/** Un siniestro recién registrado y qué pasó con la asignación de su vehículo. */
export interface SiniestroRegistrado {
  siniestro: VehicleAccident;
  /** El vehículo quedó fuera de servicio pero su chofer lo sigue teniendo asignado. */
  assignmentKept: boolean;
  assignmentKeptReason: string | null;
}

const TOLERANCIA_DE_RELOJ_MS = 5 * 60 * 1000;

/**
 * Siniestros de un vehículo (CU-201, CU-202, CU-327, CU-328). Si el vehículo
 * queda inutilizable pasa a fuera de servicio y se libera a su chofer, todo en
 * la transacción del alta; cerrar el siniestro NO lo reactiva (CU-247).
 */
@Injectable()
export class VehicleAccidentService {
  private readonly logger = new Logger(VehicleAccidentService.name);

  constructor(
    @InjectRepository(VehicleAccident)
    private readonly accidents: Repository<VehicleAccident>,
    private readonly dataSource: DataSource,
    private readonly cars: CarService,
    private readonly assignments: VehicleAssignmentService,
    private readonly driver: DriverContextService,
    private readonly eventos: EventEmitter2,
  ) {}

  /** CU-201, camino del administrador. */
  async registrar(
    dto: CreateVehicleAccidentDto,
    distributorId: string,
    userId: string,
  ): Promise<SiniestroRegistrado> {
    const { carId, employeeId: legajoIndicado, ...datos } = dto;
    await this.cars.findOne(carId, distributorId); // 404 «Vehículo … no encontrado»
    const occurredAt = this.instante(datos.occurredAt);
    let employeeId = legajoIndicado ?? null;
    if (employeeId) {
      await this.driver.assertLegajoDeLaDistribuidora(
        employeeId,
        distributorId,
      );
    } else {
      employeeId = await this.driver.legajoDelVehiculoEn(
        carId,
        distributorId,
        occurredAt,
      );
    }
    return this.guardar(
      carId,
      datos,
      occurredAt,
      employeeId,
      distributorId,
      userId,
    );
  }

  /** CU-201, camino del chofer: su vehículo en uso y su propio legajo. */
  async registrarPropio(
    dto: CreateMyVehicleAccidentDto,
    distributorId: string,
    userId: string,
  ): Promise<SiniestroRegistrado> {
    const carId = await this.driver.vehiculoEnUso(userId, distributorId);
    const employeeId = await this.driver.legajoDe(userId, distributorId);
    return this.guardar(
      carId,
      dto,
      this.instante(dto.occurredAt),
      employeeId,
      distributorId,
      userId,
    );
  }

  private instante(occurredAt: string): Date {
    const fecha = new Date(occurredAt);
    if (fecha.getTime() > Date.now() + TOLERANCIA_DE_RELOJ_MS) {
      throw new BadRequestException(
        'occurredAt: el siniestro no puede ser futuro',
      );
    }
    return fecha;
  }

  private async guardar(
    carId: string,
    datos: CreateMyVehicleAccidentDto,
    occurredAt: Date,
    employeeId: string | null,
    distributorId: string,
    userId: string,
  ): Promise<SiniestroRegistrado> {
    const punto = datos.location ? puntoDesdeLatLng(datos.location) : null;
    let guardado: VehicleAccident;
    let mantenida: string | null = null;
    try {
      guardado = await this.dataSource.transaction(async (manager) => {
        const car = await this.cars.bloquear(manager, carId, distributorId);
        const inutilizable = datos.vehicleUnusable ?? false;

        const siniestro = await manager.getRepository(VehicleAccident).save(
          manager.getRepository(VehicleAccident).create({
            distributorId,
            carId,
            employeeId,
            occurredAt,
            location: punto,
            address: datos.address ?? null,
            description: datos.description,
            injuries: datos.injuries ?? false,
            thirdPartiesInvolved: datos.thirdPartiesInvolved ?? false,
            hazmatRelease: datos.hazmatRelease ?? false,
            policeReportNumber: datos.policeReportNumber ?? null,
            insurerClaimNumber: datos.insurerClaimNumber ?? null,
            status: VehicleAccidentStatus.REPORTED,
            vehicleUnusable: inutilizable,
            createdByUserId: userId,
          }),
        );

        if (inutilizable) {
          if (car.fleetStatus !== FleetStatus.GROUNDED) {
            await this.cars.cambiarEstadoDeFlota(
              manager,
              carId,
              distributorId,
              FleetStatus.GROUNDED,
            );
          }
          // El vehículo sale de servicio siempre. Si su chofer está en plena
          // entrega (pedido en curso o carga de camión abierta) la asignación
          // se mantiene y se avisa a los administradores para que lo resuelvan.
          const liberacion = await this.assignments.liberarDelVehiculo(
            carId,
            manager,
            {
              motivo:
                'Liberado automáticamente: el vehículo quedó fuera de servicio por un siniestro.',
              actorUserId: userId,
            },
          );
          mantenida = liberacion.motivoSiSeMantiene;
        }
        return siniestro;
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'siniestros');
    }

    if (guardado.hazmatRelease) {
      this.eventos.emit(
        EVENTO_SINIESTRO_CON_DERRAME,
        new SiniestroConDerrameEvent(distributorId, guardado.accidentId, carId),
      );
    }
    if (mantenida !== null) {
      this.eventos.emit(
        EVENTO_SINIESTRO_CON_ASIGNACION_PENDIENTE,
        new SiniestroConAsignacionPendienteEvent(
          distributorId,
          guardado.accidentId,
          carId,
          mantenida,
        ),
      );
    }
    return {
      siniestro: await this.findOne(guardado.accidentId, distributorId),
      assignmentKept: mantenida !== null,
      assignmentKeptReason: mantenida,
    };
  }

  /** CU-327: corrige los datos y avanza el ciclo, de denunciado a en revisión y a en reparación. */
  async modificar(
    id: string,
    dto: UpdateVehicleAccidentDto,
    distributorId: string,
  ): Promise<VehicleAccident> {
    const punto =
      dto.location === undefined
        ? undefined
        : dto.location === null
          ? null
          : puntoDesdeLatLng(dto.location);
    let nuevoDerrame = false;
    const actualizado = await this.mutar(id, distributorId, (siniestro) => {
      this.assertAbierto(siniestro, 'El siniestro está cerrado');
      // El derrame de gas se informa una vez y no se retira: es un incidente de seguridad.
      if (dto.hazmatRelease === false && siniestro.hazmatRelease) {
        throw new BadRequestException(
          'hazmatRelease: un derrame de gas ya informado no se puede retirar',
        );
      }
      nuevoDerrame = dto.hazmatRelease === true && !siniestro.hazmatRelease;
      if (dto.status !== undefined) {
        if (!transicionDeSiniestroValida(siniestro.status, dto.status)) {
          throw new ConflictException(
            `El siniestro no puede pasar de ${siniestro.status} a ${dto.status}: el ciclo es denunciado, en revisión y en reparación`,
          );
        }
        siniestro.status = dto.status;
      }
      Object.assign(
        siniestro,
        sinIndefinidos({
          occurredAt: dto.occurredAt
            ? this.instante(dto.occurredAt)
            : undefined,
          location: punto,
          address: dto.address,
          description: dto.description,
          injuries: dto.injuries,
          thirdPartiesInvolved: dto.thirdPartiesInvolved,
          hazmatRelease: dto.hazmatRelease,
          policeReportNumber: dto.policeReportNumber,
          insurerClaimNumber: dto.insurerClaimNumber,
        }),
      );
    });
    if (nuevoDerrame) {
      this.eventos.emit(
        EVENTO_SINIESTRO_CON_DERRAME,
        new SiniestroConDerrameEvent(
          distributorId,
          actualizado.accidentId,
          actualizado.carId,
        ),
      );
    }
    return actualizado;
  }

  /** CU-202: asienta los importes y la fecha de cierre. No reactiva el vehículo. */
  async cerrar(
    id: string,
    dto: CloseVehicleAccidentDto,
    distributorId: string,
  ): Promise<VehicleAccident> {
    return this.mutar(id, distributorId, (siniestro) => {
      this.assertAbierto(siniestro, 'El siniestro ya está cerrado');
      if (dto.insurerReimbursement > dto.repairCost) {
        throw new BadRequestException(
          'insurerReimbursement: el reintegro del seguro no puede superar el costo de la reparación',
        );
      }
      if (
        siniestro.paymentAmount !== null &&
        Math.max(dto.repairCost, dto.deductibleAmount) < siniestro.paymentAmount
      ) {
        throw new ConflictException(
          'repairCost: ya se registró un pago de la empresa por más que el costo de la reparación y la franquicia',
        );
      }
      if (
        siniestro.reimbursementAmount !== null &&
        dto.insurerReimbursement < siniestro.reimbursementAmount
      ) {
        throw new ConflictException(
          'insurerReimbursement: ya se registró un reintegro del seguro por más que ese importe',
        );
      }
      siniestro.status = VehicleAccidentStatus.CLOSED;
      siniestro.repairCost = dto.repairCost;
      siniestro.insurerReimbursement = dto.insurerReimbursement;
      siniestro.deductibleAmount = dto.deductibleAmount;
      siniestro.closedAt = new Date();
    });
  }

  async findOne(id: string, distributorId: string): Promise<VehicleAccident> {
    const siniestro = await this.accidents.findOne({
      where: { accidentId: id, distributorId },
      relations: { car: true, employee: true },
    });
    if (!siniestro) {
      throw new NotFoundException('Siniestro no encontrado');
    }
    return siniestro;
  }

  /** CU-328 */
  async findAll(
    distributorId: string,
    query: QueryVehicleAccidentDto,
  ): Promise<{ data: VehicleAccident[]; total: number }> {
    const qb: SelectQueryBuilder<VehicleAccident> = this.accidents
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.car', 'car')
      .leftJoinAndSelect('s.employee', 'employee')
      .where('s.distributor_id = :distributorId', { distributorId });
    if (query.carId) qb.andWhere('s.car_id = :carId', { carId: query.carId });
    if (query.status)
      qb.andWhere('s.status = :status', { status: query.status });
    const { desde, hasta } = rangoDeFiltros(query.from, query.to);
    if (desde) qb.andWhere('s.occurred_at >= :desde', { desde });
    if (hasta) qb.andWhere('s.occurred_at < :hasta', { hasta });

    const total = await qb.getCount();
    const data = await qb
      .orderBy('s.occurred_at', 'DESC')
      .addOrderBy('s.accident_id', 'ASC')
      .limit(query.limit ?? 10)
      .offset(query.offset ?? 0)
      .getMany();
    return { data, total };
  }

  private async mutar(
    id: string,
    distributorId: string,
    cambio: (siniestro: VehicleAccident, manager: EntityManager) => void,
  ): Promise<VehicleAccident> {
    try {
      await this.dataSource.transaction(async (manager) => {
        const siniestro = await manager.getRepository(VehicleAccident).findOne({
          where: { accidentId: id, distributorId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!siniestro) {
          throw new NotFoundException('Siniestro no encontrado');
        }
        cambio(siniestro, manager);
        await manager.getRepository(VehicleAccident).save(siniestro);
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'siniestros');
    }
    return this.findOne(id, distributorId);
  }

  private assertAbierto(siniestro: VehicleAccident, mensaje: string): void {
    if (siniestro.status === VehicleAccidentStatus.CLOSED) {
      throw new ConflictException(mensaje);
    }
  }
}
