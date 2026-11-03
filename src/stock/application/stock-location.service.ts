import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { CarService } from '../../car/car.service';
import { StockLocationKind } from '../domain/stock.enums';
import { OperacionDeStockInvalidaError } from '../domain/errors/stock.errors';
import { StockLocation } from '../entities/stock-location.entity';
import { Warehouse } from '../entities/warehouse.entity';

/** Una ubicación nombrada por su dueño: un depósito o un vehículo. */
export interface ReferenciaDeUbicacion {
  warehouseId?: string;
  carId?: string;
}

@Injectable()
export class StockLocationService {
  constructor(
    @InjectRepository(StockLocation)
    private readonly locations: Repository<StockLocation>,
    private readonly cars: CarService,
  ) {}

  /**
   * La ubicación que nombra la referencia, dentro de la distribuidora. Un
   * depósito dado de baja o de otra distribuidora es 404. La ubicación de un
   * vehículo se crea la primera vez que se la nombra.
   */
  async resolver(
    manager: EntityManager,
    distributorId: string,
    ref: ReferenciaDeUbicacion,
  ): Promise<StockLocation> {
    const tieneDeposito = ref.warehouseId !== undefined;
    const tieneVehiculo = ref.carId !== undefined;
    if (tieneDeposito === tieneVehiculo) {
      throw new OperacionDeStockInvalidaError(
        'La ubicación se indica con warehouseId o con carId, uno solo',
      );
    }
    if (ref.warehouseId) {
      return this.ubicacionDeDeposito(manager, distributorId, ref.warehouseId);
    }
    return this.ubicacionDeVehiculo(manager, distributorId, ref.carId!);
  }

  async ubicacionDeDeposito(
    manager: EntityManager,
    distributorId: string,
    warehouseId: string,
  ): Promise<StockLocation> {
    const ubicacion = await manager
      .getRepository(StockLocation)
      .createQueryBuilder('l')
      .innerJoin(Warehouse, 'w', 'w.warehouseId = l.warehouseId')
      .where('l.warehouseId = :warehouseId', { warehouseId })
      .andWhere('l.distributorId = :distributorId', { distributorId })
      .andWhere('w.deletedAt IS NULL')
      .getOne();
    if (!ubicacion) {
      throw new NotFoundException('Depósito no encontrado');
    }
    return ubicacion;
  }

  /**
   * La ubicación de un depósito que va a ser el ORIGEN de una carga de camión:
   * tiene que estar activo (la rendición le devuelve las garrafas y un depósito
   * inactivo no recibe) y queda con `FOR SHARE`, que frena su baja o
   * desactivación hasta que la carga se guarde. Se llama DESPUÉS de bloquear las
   * garrafas: es el orden global (`gas_cylinder` antes que `warehouse`).
   */
  async ubicacionDeOrigenDeCarga(
    manager: EntityManager,
    distributorId: string,
    warehouseId: string,
  ): Promise<StockLocation> {
    const [fila]: Array<{ is_active: boolean }> = await manager.query(
      `SELECT "is_active" FROM "warehouse"
       WHERE "warehouse_id" = $1 AND "distributor_id" = $2 AND "deletedAt" IS NULL
       FOR SHARE`,
      [warehouseId, distributorId],
    );
    if (!fila) {
      throw new NotFoundException('Depósito no encontrado');
    }
    if (!fila.is_active) {
      throw new OperacionDeStockInvalidaError(
        'El depósito de origen está inactivo: activalo o elegí otro para abrir la carga',
      );
    }
    return this.ubicacionDeDeposito(manager, distributorId, warehouseId);
  }

  /**
   * La ubicación del vehículo; si todavía no existe la crea. El vehículo tiene
   * que ser de la distribuidora (404 si no).
   */
  async ubicacionDeVehiculo(
    manager: EntityManager,
    distributorId: string,
    carId: string,
  ): Promise<StockLocation> {
    // Un vehículo dado de baja que todavía tiene stock tiene que poder
    // vaciarse: si su ubicación ya existe se usa sin mirar el estado del auto
    // (el ledger le prohíbe recibir). Sólo para crearla se exige un vehículo
    // vigente de la distribuidora.
    const existente = await manager
      .getRepository(StockLocation)
      .findOne({ where: { carId, distributorId } });
    if (existente) return existente;
    await this.cars.findOne(carId, distributorId);
    await manager.query(
      `INSERT INTO "stock_location" ("distributor_id", "kind", "car_id")
       VALUES ($1, 'vehicle', $2)
       ON CONFLICT ("car_id") DO NOTHING`,
      [distributorId, carId],
    );
    return manager
      .getRepository(StockLocation)
      .findOneOrFail({ where: { carId, distributorId } });
  }

  /** La ubicación del vehículo si ya existe, sin crearla. */
  ubicacionExistenteDeVehiculo(
    manager: EntityManager,
    distributorId: string,
    carId: string,
  ): Promise<StockLocation | null> {
    return manager
      .getRepository(StockLocation)
      .findOne({ where: { carId, distributorId } });
  }

  async findOne(
    locationId: string,
    distributorId: string,
  ): Promise<StockLocation> {
    const ubicacion = await this.locations.findOne({
      where: { locationId, distributorId },
    });
    if (!ubicacion) {
      throw new NotFoundException('Ubicación no encontrada');
    }
    return ubicacion;
  }

  /**
   * Depósitos vigentes y vehículos con ubicación, con el nombre que se muestra.
   */
  async listar(distributorId: string): Promise<
    Array<{
      locationId: string;
      kind: StockLocationKind;
      name: string;
      warehouseId: string | null;
      carId: string | null;
    }>
  > {
    const filas: Array<{
      location_id: string;
      kind: StockLocationKind;
      name: string;
      warehouse_id: string | null;
      car_id: string | null;
    }> = await this.locations.query(
      `SELECT l."location_id", l."kind", l."warehouse_id", l."car_id",
              COALESCE(w."name", 'Vehículo ' || COALESCE(c."car_patent", l."car_id"::text)) AS name
       FROM "stock_location" l
       LEFT JOIN "warehouse" w ON w."warehouse_id" = l."warehouse_id"
       LEFT JOIN "car" c ON c."car_id" = l."car_id"
       WHERE l."distributor_id" = $1
         AND (w."warehouse_id" IS NULL OR w."deletedAt" IS NULL)
       ORDER BY l."kind", name`,
      [distributorId],
    );
    return filas.map((f) => ({
      locationId: f.location_id,
      kind: f.kind,
      name: f.name,
      warehouseId: f.warehouse_id,
      carId: f.car_id,
    }));
  }
}
