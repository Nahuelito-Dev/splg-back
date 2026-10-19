import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import {
  DataSource,
  EntityManager,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { CarService } from '../car/car.service';
import { CashDocumentPaymentService } from '../cash/application/cash-document-payment.service';
import { CashReferenceType, CashSystemCode } from '../cash/domain/cash.enums';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';
import {
  CreateFuelLoadDto,
  CreateMyFuelLoadDto,
  FuelEfficiencyDto,
  QueryFuelLoadDto,
  UpdateFuelLoadDto,
} from './dto/fuel-load.dto';
import {
  armarTramos,
  CargaParaConsumo,
  esConsumoAnomalo,
  importeCoincide,
  litrosEntranEnElTanque,
  ordenarCargas,
  totalizarTramos,
} from './domain/fuel-consumption';
import { rangoDeFiltros } from './domain/rango';
import { FleetCostSourceService } from '../fleet/fleet-cost-source.service';
import { DriverContextService } from './driver-context.service';
import { FleetExpenseMapper } from './fleet-expense.mapper';
import { FuelLoad, FuelPaymentMethod } from './entities/fuel-load.entity';
import {
  CargaDeCombustibleAnomalaEvent,
  EVENTO_CARGA_ANOMALA,
} from './events/fleet-expense.events';

/** Una carga con fecha dentro de esta tolerancia sobre el reloj del servidor no se considera futura. */
const TOLERANCIA_DE_RELOJ_MS = 5 * 60 * 1000;

export interface PaginaDeCargas {
  data: FuelLoad[];
  total: number;
  totalLiters: number;
  totalAmount: number;
}

type DatosDeCarga = Omit<CreateFuelLoadDto, 'carId'> | CreateMyFuelLoadDto;

/**
 * Cargas de combustible (CU-195, CU-320 a CU-322) y su consumo (CU-196). La
 * carga es un registro propio; el kilometraje del vehículo se sube desde un
 * único punto (`CarService.actualizarOdometro`) y toda escritura toma antes el
 * lock de la fila del vehículo, así dos cargas simultáneas no se pisan al
 * comparar kilometrajes ni al medir el consumo.
 */
@Injectable()
export class FuelLoadService {
  private readonly logger = new Logger(FuelLoadService.name);

  constructor(
    @InjectRepository(FuelLoad)
    private readonly loads: Repository<FuelLoad>,
    private readonly dataSource: DataSource,
    private readonly cars: CarService,
    private readonly driver: DriverContextService,
    private readonly eventos: EventEmitter2,
    private readonly fleet: FleetCostSourceService,
    private readonly pagos: CashDocumentPaymentService,
  ) {}

  /** CU-195, camino del administrador. */
  async registrar(
    dto: CreateFuelLoadDto,
    distributorId: string,
    userId: string,
  ): Promise<FuelLoad> {
    await this.cars.findOne(dto.carId, distributorId); // 404 antes de tocar nada
    const { carId, ...datos } = dto;
    const loadedAt = this.instante(datos.loadedAt);
    const employeeId = await this.driver.legajoDelVehiculoEn(
      carId,
      distributorId,
      loadedAt,
    );
    return this.guardar(
      carId,
      datos,
      loadedAt,
      employeeId,
      distributorId,
      userId,
      true,
    );
  }

  /** CU-195, camino del chofer: su vehículo en uso, sin corrección de kilometraje. */
  async registrarPropia(
    dto: CreateMyFuelLoadDto,
    distributorId: string,
    userId: string,
  ): Promise<FuelLoad> {
    const carId = await this.driver.vehiculoEnUso(userId, distributorId);
    const employeeId = await this.driver.legajoDe(userId, distributorId);
    return this.guardar(
      carId,
      dto,
      this.instante(dto.loadedAt),
      employeeId,
      distributorId,
      userId,
      false,
    );
  }

  private instante(loadedAt: string | undefined): Date {
    const ahora = Date.now();
    const fecha = loadedAt ? new Date(loadedAt) : new Date(ahora);
    if (fecha.getTime() > ahora + TOLERANCIA_DE_RELOJ_MS) {
      throw new BadRequestException('loadedAt: la carga no puede ser futura');
    }
    return fecha;
  }

  private async guardar(
    carId: string,
    datos: DatosDeCarga,
    loadedAt: Date,
    employeeId: string | null,
    distributorId: string,
    userId: string,
    permitirCorreccion: boolean,
  ): Promise<FuelLoad> {
    let guardada: FuelLoad;
    if (
      'cashBoxId' in datos &&
      datos.cashBoxId &&
      datos.paymentMethod !== FuelPaymentMethod.CASH_BOX
    ) {
      throw new BadRequestException(
        'cashBoxId: sólo se indica cuando el pago es de la caja (paymentMethod: cash_box)',
      );
    }
    try {
      guardada = await this.dataSource.transaction(async (manager) => {
        const car = await this.cars.bloquear(manager, carId, distributorId);
        const fuelType = datos.fuelType ?? car.fuelType;
        if (!fuelType) {
          throw new BadRequestException(
            'fuelType: indicá el combustible (el vehículo no tiene uno cargado)',
          );
        }
        this.assertImporteYTanque(
          datos.liters,
          datos.unitPrice,
          datos.totalAmount,
          car.tankCapacityLiters,
        );

        // Sólo el administrador fuerza el kilometraje: aunque el cuerpo del
        // chofer lo trajera, acá no se lee.
        const correccion =
          permitirCorreccion &&
          'odometerCorrection' in datos &&
          datos.odometerCorrection === true;
        const nota =
          permitirCorreccion && 'odometerCorrectionNote' in datos
            ? (datos.odometerCorrectionNote ?? null)
            : null;
        await this.assertKilometraje(
          manager,
          carId,
          loadedAt,
          datos.odometerKm,
          null,
          correccion,
          nota,
        );

        const nueva = manager.getRepository(FuelLoad).create({
          distributorId,
          carId,
          employeeId,
          loadedAt,
          fuelType,
          liters: datos.liters,
          unitPrice: datos.unitPrice,
          totalAmount: datos.totalAmount,
          odometerKm: datos.odometerKm,
          isFullTank: datos.isFullTank ?? true,
          station: datos.station ?? null,
          paymentMethod: datos.paymentMethod,
          receiptNumber: datos.receiptNumber ?? null,
          anomaly: false,
          notes: datos.notes ?? null,
          odometerCorrectionNote: correccion ? nota : null,
          createdByUserId: userId,
          registeredByDriver: !permitirCorreccion,
        });
        const salvada = await manager.getRepository(FuelLoad).save(nueva);
        await this.asentarPagoDeCaja(
          manager,
          salvada,
          permitirCorreccion && 'cashBoxId' in datos
            ? datos.cashBoxId
            : undefined,
          permitirCorreccion,
          userId,
        );

        await this.cars.actualizarOdometro(manager, carId, datos.odometerKm);
        salvada.anomaly = await this.evaluarAnomalia(
          manager,
          carId,
          salvada.fuelLoadId,
        );
        if (salvada.anomaly) {
          await manager.getRepository(FuelLoad).save(salvada);
        }
        return salvada;
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'cargas de combustible');
    }

    if (guardada.anomaly) {
      this.eventos.emit(
        EVENTO_CARGA_ANOMALA,
        new CargaDeCombustibleAnomalaEvent(
          distributorId,
          guardada.fuelLoadId,
          carId,
        ),
      );
    }
    return this.findOne(guardada.fuelLoadId, distributorId);
  }

  /** CU-320: corrige los datos y revalida las mismas reglas que el alta. */
  async modificar(
    id: string,
    dto: UpdateFuelLoadDto,
    distributorId: string,
  ): Promise<FuelLoad> {
    let anomala = false;
    let carId: string;
    try {
      ({ carId, anomala } = await this.dataSource.transaction(
        async (manager) => {
          const carga = await this.cargarParaEscribir(
            manager,
            id,
            distributorId,
          );
          const car = await this.cars.bloquear(
            manager,
            carga.carId,
            distributorId,
          );
          const kmAnterior = carga.odometerKm;
          const importeAnterior = carga.totalAmount;
          const medioAnterior = carga.paymentMethod;
          const loadedAt = dto.loadedAt
            ? this.instante(dto.loadedAt)
            : carga.loadedAt;

          Object.assign(
            carga,
            sinIndefinidos({
              loadedAt,
              fuelType: dto.fuelType,
              liters: dto.liters,
              unitPrice: dto.unitPrice,
              totalAmount: dto.totalAmount,
              odometerKm: dto.odometerKm,
              isFullTank: dto.isFullTank,
              station: dto.station,
              paymentMethod: dto.paymentMethod,
              receiptNumber: dto.receiptNumber,
              notes: dto.notes,
            }),
          );

          if (
            carga.registeredByDriver &&
            carga.paymentMethod !== medioAnterior &&
            (carga.paymentMethod === FuelPaymentMethod.CASH_BOX ||
              medioAnterior === FuelPaymentMethod.CASH_BOX) &&
            (carga.paymentMethod === FuelPaymentMethod.DRIVER_CASH ||
              medioAnterior === FuelPaymentMethod.DRIVER_CASH)
          ) {
            throw new ConflictException(
              'Una carga del chofer no pasa de efectivo propio (driver_cash) a caja (cash_box) ni al revés: si se registró mal, anulala y registrala de nuevo',
            );
          }
          if (
            carga.cashMovementId &&
            (carga.paymentMethod !== FuelPaymentMethod.CASH_BOX ||
              carga.totalAmount !== importeAnterior)
          ) {
            throw new ConflictException(
              'La carga ya salió de una caja: no se cambian su importe ni su medio de pago. Anulala y registrala de nuevo',
            );
          }
          this.assertImporteYTanque(
            carga.liters,
            carga.unitPrice,
            carga.totalAmount,
            car.tankCapacityLiters,
          );
          const correccion = dto.odometerCorrection === true;
          await this.assertKilometraje(
            manager,
            carga.carId,
            carga.loadedAt,
            carga.odometerKm,
            carga.fuelLoadId,
            correccion,
            dto.odometerCorrectionNote ?? null,
          );
          if (correccion) {
            carga.odometerCorrectionNote = dto.odometerCorrectionNote ?? null;
          }

          await manager.getRepository(FuelLoad).save(carga);
          await this.recalcularOdometro(
            manager,
            carga.carId,
            kmAnterior,
            carga.odometerKm,
            distributorId,
          );
          carga.anomaly = await this.evaluarAnomalia(
            manager,
            carga.carId,
            carga.fuelLoadId,
          );
          await manager.getRepository(FuelLoad).save(carga);
          return { carId: carga.carId, anomala: carga.anomaly };
        },
      ));
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'cargas de combustible');
    }

    if (anomala) {
      this.eventos.emit(
        EVENTO_CARGA_ANOMALA,
        new CargaDeCombustibleAnomalaEvent(distributorId, id, carId),
      );
    }
    return this.findOne(id, distributorId);
  }

  /** CU-321: baja lógica; si era la que fijó el kilometraje, el vehículo vuelve al de la anterior. */
  async anular(
    id: string,
    distributorId: string,
    userId: string,
  ): Promise<MessageResponseDto> {
    try {
      await this.dataSource.transaction(async (manager) => {
        const carga = await this.cargarParaEscribir(manager, id, distributorId);
        await this.cars.bloquear(manager, carga.carId, distributorId);
        if (carga.cashMovementId) {
          await this.pagos.revertir(
            manager,
            carga.cashMovementId,
            distributorId,
            'Carga de combustible anulada',
            userId,
          );
        }
        await manager.getRepository(FuelLoad).softRemove(carga);
        const restante = await this.kilometrajeMaximoVigente(
          manager,
          carga.carId,
          distributorId,
        );
        await this.cars.bajarOdometro(
          manager,
          carga.carId,
          carga.odometerKm,
          restante,
        );
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'cargas de combustible');
    }
    return MessageResponseDto.of('Carga de combustible anulada');
  }

  /**
   * La carga que registró el chofer con `cash_box` no elige caja: queda
   * pendiente de asentar hasta que un administrador indica de cuál sale
   * (la rendición del chofer no la toma, porque no la pagó él). La que pagó con
   * su propio efectivo (`driver_cash`) la rinde como gasto en su rendición.
   */
  async pagarDesdeCaja(
    id: string,
    cashBoxId: string,
    distributorId: string,
    userId: string,
  ): Promise<FuelLoad> {
    try {
      await this.dataSource.transaction(async (manager) => {
        const carga = await this.cargarParaEscribir(manager, id, distributorId);
        if (carga.paymentMethod !== FuelPaymentMethod.CASH_BOX) {
          throw new BadRequestException(
            'Sólo se asienta en una caja la carga pagada de la caja (cash_box)',
          );
        }
        await this.cars.bloquear(manager, carga.carId, distributorId);
        if (carga.cashMovementId) {
          throw new ConflictException('La carga ya salió de una caja');
        }
        if (carga.cashPaymentLegacy) {
          throw new ConflictException(
            'La carga es anterior al asiento de caja y se resolvió fuera del libro: no se asienta; si hace falta, registrá un egreso manual con motivo',
          );
        }
        await this.asentarPagoDeCaja(manager, carga, cashBoxId, true, userId);
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'cargas de combustible');
    }
    return this.findOne(id, distributorId);
  }

  /**
   * Sale de la caja el importe de una carga `cash_box` (categoría de sistema
   * `fuel`, origen `fuel_load`), en la transacción de la carga. Sólo el
   * administrador la asienta; con cajas de efectivo activas la caja es
   * obligatoria. Sin cajas de efectivo, o con importe 0, no asienta nada.
   */
  private async asentarPagoDeCaja(
    manager: EntityManager,
    carga: FuelLoad,
    cashBoxId: string | undefined,
    asienta: boolean,
    userId: string,
  ): Promise<void> {
    if (!asienta || carga.paymentMethod !== FuelPaymentMethod.CASH_BOX) return;
    const cajaId = await this.pagos.cajaDelPago(
      manager,
      carga.distributorId,
      cashBoxId,
    );
    if (!cajaId || carga.totalAmount <= 0) return;
    const movimiento = await this.pagos.egresar(manager, {
      distributorId: carga.distributorId,
      cashBoxId: cajaId,
      amount: carga.totalAmount,
      systemCode: CashSystemCode.FUEL,
      referenceType: CashReferenceType.FUEL_LOAD,
      referenceId: carga.fuelLoadId,
      description: `Combustible pagado en efectivo (${carga.liters} L${carga.station ? ` en ${carga.station}` : ''})`,
      userId,
    });
    carga.cashMovementId = movimiento.movementId;
    await manager.getRepository(FuelLoad).save(carga);
  }

  /** La carga puntual; también la anulada, con `voidedAt`. 404 si no es de la distribuidora. */
  async findOne(id: string, distributorId: string): Promise<FuelLoad> {
    const carga = await this.loads.findOne({
      where: { fuelLoadId: id, distributorId },
      relations: { car: true, employee: true },
      withDeleted: true,
    });
    if (!carga) {
      throw new NotFoundException(`Carga de combustible ${id} no encontrada`);
    }
    return carga;
  }

  /** CU-322: las cargas vigentes que cumplen los filtros, con el total de litros e importe. */
  async findAll(
    distributorId: string,
    query: QueryFuelLoadDto,
  ): Promise<PaginaDeCargas> {
    const filtradas = (): SelectQueryBuilder<FuelLoad> => {
      const qb = this.loads
        .createQueryBuilder('f')
        .where('f.distributor_id = :distributorId', { distributorId });
      if (query.carId) qb.andWhere('f.car_id = :carId', { carId: query.carId });
      if (query.employeeId) {
        qb.andWhere('f.employee_id = :employeeId', {
          employeeId: query.employeeId,
        });
      }
      if (query.anomaly !== undefined) {
        qb.andWhere('f.anomaly = :anomaly', { anomaly: query.anomaly });
      }
      const { desde, hasta } = rangoDeFiltros(query.from, query.to);
      if (desde) qb.andWhere('f.loaded_at >= :desde', { desde });
      if (hasta) qb.andWhere('f.loaded_at < :hasta', { hasta });
      return qb;
    };

    const sumas = await filtradas()
      .select('COUNT(*)', 'total')
      .addSelect('COALESCE(SUM(f.liters), 0)', 'liters')
      .addSelect('COALESCE(SUM(f.total_amount), 0)', 'amount')
      .getRawOne<{ total: string; liters: string; amount: string }>();

    const data = await filtradas()
      .leftJoinAndSelect('f.car', 'car')
      .leftJoinAndSelect('f.employee', 'employee')
      .orderBy('f.loaded_at', 'DESC')
      .addOrderBy('f.fuel_load_id', 'ASC')
      .limit(query.limit ?? 10)
      .offset(query.offset ?? 0)
      .getMany();

    return {
      data,
      total: Number(sumas?.total ?? 0),
      totalLiters: Number(sumas?.liters ?? 0),
      totalAmount: Number(sumas?.amount ?? 0),
    };
  }

  /** CU-196: tramos entre cargas de tanque lleno, totales y anomalías del rango. */
  async consumo(
    carId: string,
    distributorId: string,
    from: string,
    to: string,
  ): Promise<FuelEfficiencyDto> {
    await this.cars.findOne(carId, distributorId); // 404 «Vehículo … no encontrado»
    const { desde, hasta } = rangoDeFiltros(from, to);
    const cargas = ordenarCargas(
      await this.loads
        .createQueryBuilder('f')
        .leftJoinAndSelect('f.car', 'car')
        .leftJoinAndSelect('f.employee', 'employee')
        .where('f.car_id = :carId AND f.distributor_id = :distributorId', {
          carId,
          distributorId,
        })
        .andWhere('f.loaded_at >= :desde AND f.loaded_at < :hasta', {
          desde,
          hasta,
        })
        .getMany(),
    );
    const tramos = armarTramos(cargas);

    const dto = new FuelEfficiencyDto();
    dto.carId = carId;
    dto.from = from;
    dto.to = to;
    dto.tranches = tramos.map((t) => ({
      fromLoadId: t.desdeCargaId,
      toLoadId: t.hastaCargaId,
      fromKm: t.desdeKm,
      toKm: t.hastaKm,
      km: t.km,
      liters: t.liters,
      amount: t.amount,
      kmPerLiter: t.kmPerLiter,
      costPerKm: t.costPerKm,
    }));
    dto.totals = totalizarTramos(tramos);
    dto.anomalies = cargas
      .filter((c) => c.anomaly)
      .map((c) => FleetExpenseMapper.fuelLoad(c));
    return dto;
  }

  /**
   * La carga vigente para escribir, bloqueada (`FOR UPDATE`): 404 si no es de
   * la distribuidora, 409 si está anulada. Orden de locks: carga → vehículo →
   * caja; quien llama relee `cashMovementId` ya con el lock tomado.
   */
  private async cargarParaEscribir(
    manager: EntityManager,
    id: string,
    distributorId: string,
  ): Promise<FuelLoad> {
    const carga = await manager.getRepository(FuelLoad).findOne({
      where: { fuelLoadId: id, distributorId },
      withDeleted: true,
      lock: { mode: 'pessimistic_write' },
    });
    if (!carga) {
      throw new NotFoundException(`Carga de combustible ${id} no encontrada`);
    }
    if (carga.deletedAt) {
      throw new ConflictException('La carga de combustible está anulada');
    }
    return carga;
  }

  private assertImporteYTanque(
    liters: number,
    unitPrice: number,
    totalAmount: number,
    capacidad: number | null,
  ): void {
    if (!importeCoincide(liters, unitPrice, totalAmount)) {
      const esperado = new Decimal(liters).times(unitPrice).toDecimalPlaces(2);
      throw new BadRequestException(
        `totalAmount: el importe no coincide con los litros por el precio por litro (${esperado.toString()}, con una tolerancia del 1 %)`,
      );
    }
    if (!litrosEntranEnElTanque(liters, capacidad)) {
      throw new BadRequestException(
        `liters: superan la capacidad del tanque (${capacidad} L, con una tolerancia del 5 %)`,
      );
    }
  }

  /**
   * El kilometraje no puede ser menor que el de la última carga vigente
   * anterior a esta (por fecha). Sólo el administrador lo fuerza, con una nota.
   */
  private async assertKilometraje(
    manager: EntityManager,
    carId: string,
    loadedAt: Date,
    odometerKm: number,
    excluirId: string | null,
    correccion: boolean,
    nota: string | null,
  ): Promise<void> {
    const qb = manager
      .getRepository(FuelLoad)
      .createQueryBuilder('f')
      .where('f.car_id = :carId AND f.loaded_at <= :loadedAt', {
        carId,
        loadedAt,
      });
    if (excluirId) qb.andWhere('f.fuel_load_id <> :excluirId', { excluirId });
    const anterior = await qb
      .orderBy('f.loaded_at', 'DESC')
      .addOrderBy('f.odometer_km', 'DESC')
      .getOne();

    if (!anterior || odometerKm >= anterior.odometerKm) return;
    if (!correccion) {
      throw new BadRequestException(
        'odometerKm: El kilometraje es menor que el de la última carga',
      );
    }
    if (!nota) {
      throw new BadRequestException(
        'odometerCorrectionNote: la corrección del kilometraje necesita una nota',
      );
    }
  }

  private async evaluarAnomalia(
    manager: EntityManager,
    carId: string,
    fuelLoadId: string,
  ): Promise<boolean> {
    const cargas = await manager
      .getRepository(FuelLoad)
      .find({ where: { carId } });
    return esConsumoAnomalo(
      ordenarCargas<CargaParaConsumo>(cargas),
      fuelLoadId,
    );
  }

  /**
   * El kilometraje que le queda al vehículo cuando una carga deja de valer: el
   * mayor entre las cargas vigentes y las tareas de mantenimiento hechas con
   * kilometraje (las dos fuentes que lo escriben). `null` si no queda ninguna:
   * el vehículo conserva el que tenía.
   */
  private async kilometrajeMaximoVigente(
    manager: EntityManager,
    carId: string,
    distributorId: string,
  ): Promise<number | null> {
    const fila = await manager
      .getRepository(FuelLoad)
      .createQueryBuilder('f')
      .select('MAX(f.odometer_km)', 'max')
      .where('f.car_id = :carId', { carId })
      .getRawOne<{ max: number | null }>();
    const deTareas = await this.fleet.kmMaximoDeTareasHechas(
      distributorId,
      carId,
    );
    const candidatos = [fila?.max ?? null, deTareas].filter(
      (km): km is number => km !== null,
    );
    return candidatos.length === 0 ? null : Math.max(...candidatos);
  }

  /** Sube el kilometraje del vehículo, o lo baja si el viejo valor era el que había fijado esta carga. */
  private async recalcularOdometro(
    manager: EntityManager,
    carId: string,
    kmAnterior: number,
    kmNuevo: number,
    distributorId: string,
  ): Promise<void> {
    if (kmNuevo > kmAnterior) {
      await this.cars.actualizarOdometro(manager, carId, kmNuevo);
    } else if (kmNuevo < kmAnterior) {
      const restante = await this.kilometrajeMaximoVigente(
        manager,
        carId,
        distributorId,
      );
      await this.cars.bajarOdometro(manager, carId, kmAnterior, restante);
    }
  }
}
