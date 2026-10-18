import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { CarService } from '../car/car.service';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import {
  CreateTireDto,
  CreateTireEventDto,
  QueryTireDto,
} from './dto/tire.dto';
import { movimientoValidoParaElEstado } from './domain/estados';
import { Tire, TireStatus } from './entities/tire.entity';
import { TireEvent, TireEventType } from './entities/tire-event.entity';

const MOVIMIENTO_INVALIDO = 'Movimiento inválido para el estado del neumático';

/**
 * Neumáticos (CU-205) y sus movimientos (CU-206). El neumático no se edita:
 * cambia de estado, vehículo y posición sólo con un movimiento, y cada
 * movimiento es un asiento que no se modifica. Opcional dentro del módulo.
 */
@Injectable()
export class TireService {
  private readonly logger = new Logger(TireService.name);

  constructor(
    @InjectRepository(Tire) private readonly tires: Repository<Tire>,
    @InjectRepository(TireEvent)
    private readonly events: Repository<TireEvent>,
    private readonly dataSource: DataSource,
    private readonly cars: CarService,
  ) {}

  /** CU-205: nace en depósito, sin vehículo ni posición. */
  async registrar(dto: CreateTireDto, distributorId: string): Promise<Tire> {
    const existe = await this.tires.exists({
      where: { distributorId, serialNumber: dto.serialNumber },
    });
    if (existe) {
      throw new ConflictException('El neumático ya está registrado');
    }
    try {
      return await this.tires.save(
        this.tires.create({
          distributorId,
          serialNumber: dto.serialNumber,
          brand: dto.brand,
          size: dto.size,
          cost: dto.cost,
          status: TireStatus.IN_STOCK,
        }),
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'neumáticos');
    }
  }

  async findOne(id: string, distributorId: string): Promise<Tire> {
    const neumatico = await this.tires.findOne({
      where: { tireId: id, distributorId },
      relations: { car: true },
    });
    if (!neumatico) {
      throw new NotFoundException(`Neumático ${id} no encontrado`);
    }
    return neumatico;
  }

  /** El historial de un neumático, del movimiento más reciente al más antiguo. */
  async historial(id: string, distributorId: string): Promise<TireEvent[]> {
    await this.findOne(id, distributorId);
    return this.events.find({
      where: { tireId: id, distributorId },
      order: { createdAt: 'DESC', eventId: 'ASC' },
    });
  }

  async findAll(
    distributorId: string,
    query: QueryTireDto,
  ): Promise<{ data: Tire[]; total: number }> {
    const qb = this.tires
      .createQueryBuilder('t')
      .leftJoinAndSelect('t.car', 'car')
      .where('t.distributor_id = :distributorId', { distributorId });
    if (query.status)
      qb.andWhere('t.status = :status', { status: query.status });
    if (query.carId) qb.andWhere('t.car_id = :carId', { carId: query.carId });
    const total = await qb.getCount();
    const data = await qb
      .orderBy('t.createdAt', 'DESC')
      .addOrderBy('t.tire_id', 'ASC')
      .limit(query.limit ?? 10)
      .offset(query.offset ?? 0)
      .getMany();
    return { data, total };
  }

  /** Los neumáticos de un vehículo (404 si no es de la distribuidora). */
  async delVehiculo(
    carId: string,
    distributorId: string,
    query: QueryTireDto,
  ): Promise<{ data: Tire[]; total: number }> {
    await this.cars.findOne(carId, distributorId);
    return this.findAll(distributorId, { ...query, carId });
  }

  /**
   * CU-206: registra el movimiento y deja al neumático en el estado que
   * corresponde. Todo bajo el lock de la fila del neumático.
   */
  async registrarMovimiento(
    id: string,
    dto: CreateTireEventDto,
    distributorId: string,
    userId: string,
  ): Promise<{ tire: Tire; event: TireEvent }> {
    let evento: TireEvent;
    try {
      evento = await this.dataSource.transaction(async (manager) => {
        const neumatico = await manager.getRepository(Tire).findOne({
          where: { tireId: id, distributorId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!neumatico) {
          throw new NotFoundException(`Neumático ${id} no encontrado`);
        }
        if (!movimientoValidoParaElEstado(dto.type, neumatico.status)) {
          throw new ConflictException(MOVIMIENTO_INVALIDO);
        }

        const asiento = await this.aplicar(
          manager,
          neumatico,
          dto,
          distributorId,
        );
        await manager.getRepository(Tire).save(neumatico);
        return manager.getRepository(TireEvent).save(
          manager.getRepository(TireEvent).create({
            tireId: neumatico.tireId,
            distributorId,
            type: dto.type,
            carId: asiento.carId,
            position: asiento.position,
            odometerKm: dto.odometerKm,
            createdByUserId: userId,
          }),
        );
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'neumáticos');
    }
    return { tire: await this.findOne(id, distributorId), event: evento };
  }

  /** Muta el neumático según el movimiento y devuelve vehículo y posición del asiento. */
  private async aplicar(
    manager: EntityManager,
    t: Tire,
    dto: CreateTireEventDto,
    distributorId: string,
  ): Promise<{ carId: string | null; position: string | null }> {
    switch (dto.type) {
      case TireEventType.MOUNT: {
        if (!dto.carId || !dto.position) {
          throw new BadRequestException(
            'carId y position: son obligatorios en un montaje',
          );
        }
        await this.cars.bloquear(manager, dto.carId, distributorId);
        await this.assertPosicionLibre(manager, dto.carId, dto.position);
        t.status = TireStatus.MOUNTED;
        t.carId = dto.carId;
        t.position = dto.position;
        t.mountedOdometerKm = dto.odometerKm;
        return { carId: dto.carId, position: dto.position };
      }
      case TireEventType.UNMOUNT: {
        const asiento = { carId: t.carId, position: t.position };
        this.cerrarMontaje(t, dto.odometerKm);
        t.status = TireStatus.IN_STOCK;
        this.soltar(t);
        return asiento;
      }
      case TireEventType.ROTATE: {
        if (!dto.position) {
          throw new BadRequestException(
            'position: es obligatoria en una rotación',
          );
        }
        if (dto.carId && dto.carId !== t.carId) {
          throw new BadRequestException(
            'carId: la rotación es dentro del mismo vehículo',
          );
        }
        if (dto.position === t.position) {
          throw new ConflictException(MOVIMIENTO_INVALIDO);
        }
        await this.assertPosicionLibre(
          manager,
          t.carId as string,
          dto.position,
        );
        this.cerrarMontaje(t, dto.odometerKm);
        t.position = dto.position;
        t.mountedOdometerKm = dto.odometerKm;
        return { carId: t.carId, position: dto.position };
      }
      case TireEventType.RETREAD:
        t.retreadCount += 1;
        return { carId: null, position: null };
      case TireEventType.RETIRE: {
        const asiento = { carId: t.carId, position: t.position };
        if (t.status === TireStatus.MOUNTED) {
          this.cerrarMontaje(t, dto.odometerKm);
        }
        t.status = TireStatus.RETIRED;
        this.soltar(t);
        return asiento;
      }
    }
  }

  /** Suma lo recorrido en el montaje que termina; el kilometraje no puede ir hacia atrás. */
  private cerrarMontaje(t: Tire, odometerKm: number): void {
    const montaje = t.mountedOdometerKm ?? 0;
    if (odometerKm < montaje) {
      throw new BadRequestException(
        `odometerKm: es menor que el del montaje (${montaje} km)`,
      );
    }
    t.kmTraveled += odometerKm - montaje;
  }

  private soltar(t: Tire): void {
    t.carId = null;
    t.position = null;
    t.mountedOdometerKm = null;
  }

  private async assertPosicionLibre(
    manager: EntityManager,
    carId: string,
    position: string,
  ): Promise<void> {
    const ocupada = await manager.getRepository(Tire).exists({
      where: { carId, position, status: TireStatus.MOUNTED },
    });
    if (ocupada) {
      throw new ConflictException(
        `La posición ${position} del vehículo ya tiene un neumático montado`,
      );
    }
  }
}
