import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { VehicleAssignmentService } from '../../car/vehicle-assignment.service';
import { bloquearChoferVigente } from '../../common/locks/chofer-lock';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import { DeliveryService } from '../../delivery/delivery.service';
import {
  DocType,
  DocumentSequenceService,
} from '../../document-sequence/document-sequence.service';
import { EmployeeService } from '../../employee/employee.service';
import { StockLocationService } from '../../stock/application/stock-location.service';
import { WarehouseService } from '../../stock/application/warehouse.service';
import { CargaInvalidaError } from '../domain/errors/truck-load.errors';
import { ESTADOS_ABIERTOS } from '../domain/truck-load.enums';
import { validarRenglones } from '../domain/truck-load-rules';
import { CreateTruckLoadDto } from '../dto/truck-load.dto';
import { TruckLoadItem } from '../entities/truck-load-item.entity';
import { TruckLoad } from '../entities/truck-load.entity';
import {
  ahoraDeLaBase,
  bloquearGarrafasComoClaveForanea,
  traducirErrorDeCarga,
} from './truck-load-support';

/**
 * Abre la carga del día de un camión y un chofer, en estado `loading`, con sus
 * renglones. No mueve stock (eso pasa al confirmar la salida) pero sí valida
 * que el camión esté en uso por el chofer y que ninguno de los dos tenga otra
 * carga abierta.
 *
 * Orden de locks: car (`FOR SHARE`, frena a `ponerEnUso`) -> delivery -> las
 * garrafas (`FOR KEY SHARE`) -> `document_sequence` (el número, al final).
 */
@Injectable()
export class OpenTruckLoadUseCase {
  private readonly logger = new Logger(OpenTruckLoadUseCase.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly deliveries: DeliveryService,
    private readonly assignments: VehicleAssignmentService,
    private readonly employees: EmployeeService,
    private readonly warehouses: WarehouseService,
    private readonly locations: StockLocationService,
    private readonly sequences: DocumentSequenceService,
  ) {}

  /** Devuelve el id de la carga. */
  async execute(
    dto: CreateTruckLoadDto,
    distributorId: string,
    actorUserId: string,
  ): Promise<string> {
    const renglones = dto.items.map((i) => ({
      gasCylinderId: i.gasCylinderId,
      loadedFull: i.loadedFull,
      loadedEmpty: i.loadedEmpty ?? 0,
    }));
    validarRenglones(renglones);
    const businessDate = dto.businessDate ?? diaArgentino();
    try {
      return await withTransactionRetry(
        () =>
          this.dataSource.transaction((manager) =>
            this.abrir(
              manager,
              dto,
              renglones,
              businessDate,
              distributorId,
              actorUserId,
            ),
          ),
        { context: 'apertura de carga de camión' },
      );
    } catch (error) {
      return traducirErrorDeCarga(error, this.logger, 'apertura de carga');
    }
  }

  private async abrir(
    manager: EntityManager,
    dto: CreateTruckLoadDto,
    renglones: Array<{
      gasCylinderId: string;
      loadedFull: number;
      loadedEmpty: number;
    }>,
    businessDate: string,
    distributorId: string,
    actorUserId: string,
  ): Promise<string> {
    const [auto]: Array<{ car_patent: string | null }> = await manager.query(
      `SELECT "car_patent" FROM "car"
       WHERE "car_id" = $1 AND "distributor_id" = $2 AND "deletedAt" IS NULL
       FOR SHARE`,
      [dto.carId, distributorId],
    );
    if (!auto)
      throw new NotFoundException(`Vehículo ${dto.carId} no encontrado`);

    const chofer = await this.deliveries.findById(dto.deliveryId);
    if (!chofer || chofer.distributorId !== distributorId) {
      throw new NotFoundException(`Chofer ${dto.deliveryId} no encontrado`);
    }
    if (!(await bloquearChoferVigente(manager, dto.deliveryId))) {
      throw new NotFoundException(`Chofer ${dto.deliveryId} no encontrado`);
    }

    const enUso = await this.assignments.vehiculoEnUso(
      dto.deliveryId,
      distributorId,
    );
    if (enUso?.carId !== dto.carId) {
      throw new CargaInvalidaError(
        `El vehículo ${auto.car_patent ?? dto.carId} no está en uso por ese chofer: asignáselo antes de abrir la carga`,
      );
    }
    if (dto.helperEmployeeId) {
      await this.employees.findOne(dto.helperEmployeeId, distributorId);
    }

    const { locationId: originLocationId } = dto.originWarehouseId
      ? await this.locations.ubicacionDeDeposito(
          manager,
          distributorId,
          dto.originWarehouseId,
        )
      : await this.warehouses.asegurarPredeterminado(distributorId, manager);

    await bloquearGarrafasComoClaveForanea(
      manager,
      distributorId,
      renglones.map((r) => r.gasCylinderId),
    );
    await this.asegurarSinCargaAbierta(
      manager,
      dto.carId,
      dto.deliveryId,
      auto.car_patent,
    );

    const number = await this.sequences.siguienteNumero(
      manager,
      distributorId,
      DocType.TRUCK_LOAD,
    );
    const carga = await manager.save(
      manager.create(TruckLoad, {
        distributorId,
        number,
        carId: dto.carId,
        deliveryId: dto.deliveryId,
        helperEmployeeId: dto.helperEmployeeId ?? null,
        originLocationId,
        businessDate,
        openedAt: await ahoraDeLaBase(manager),
        openedByUserId: actorUserId,
        notes: dto.notes?.trim() || null,
      }),
    );
    await manager.save(
      renglones.map((r) =>
        manager.create(TruckLoadItem, {
          loadId: carga.loadId,
          gasCylinderId: r.gasCylinderId,
          loadedFull: r.loadedFull,
          loadedEmpty: r.loadedEmpty,
        }),
      ),
    );
    return carga.loadId;
  }

  private async asegurarSinCargaAbierta(
    manager: EntityManager,
    carId: string,
    deliveryId: string,
    patente: string | null,
  ): Promise<void> {
    const abiertas: Array<{
      number: number;
      car_id: string;
      delivery_id: string;
    }> = await manager.query(
      `SELECT "number", "car_id", "delivery_id" FROM "truck_load"
       WHERE ("car_id" = $1 OR "delivery_id" = $2) AND "status"::text = ANY($3::text[])`,
      [carId, deliveryId, ESTADOS_ABIERTOS],
    );
    const delCamion = abiertas.find((a) => a.car_id === carId);
    if (delCamion) {
      throw new ConflictException(
        `El camión ${patente ?? carId} ya tiene abierta la carga N° ${delCamion.number}: cerrala o cancelala antes`,
      );
    }
    const delChofer = abiertas.find((a) => a.delivery_id === deliveryId);
    if (delChofer) {
      throw new ConflictException(
        `El chofer ya tiene abierta la carga N° ${delChofer.number}: cerrala o cancelala antes`,
      );
    }
  }
}
