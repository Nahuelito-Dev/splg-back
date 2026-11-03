import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import { traducirErrorDeBase } from '../../common/errors/db-exceptions';
import { StockLocationKind, WarehouseKind } from '../domain/stock.enums';
import { StockLocation } from '../entities/stock-location.entity';
import { StockThreshold } from '../entities/stock-threshold.entity';
import { Warehouse } from '../entities/warehouse.entity';
import {
  CreateWarehouseDto,
  QueryWarehouseDto,
  UpdateWarehouseDto,
} from '../dto/warehouse.dto';

export const NOMBRE_DEPOSITO_CENTRAL = 'Depósito central';
export const CODIGO_DEPOSITO_CENTRAL = 'CENTRAL';

/** Un depósito con la ubicación de stock que lo representa. */
export interface DepositoConUbicacion {
  warehouse: Warehouse;
  locationId: string;
}

@Injectable()
export class WarehouseService {
  private readonly logger = new Logger(WarehouseService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Warehouse)
    private readonly warehouses: Repository<Warehouse>,
  ) {}

  async create(
    dto: CreateWarehouseDto,
    distributorId: string,
  ): Promise<DepositoConUbicacion> {
    try {
      return await withTransactionRetry(
        () =>
          this.dataSource.transaction(async (manager) => {
            await this.bloquearPredeterminados(manager, distributorId, null);
            const repo = manager.getRepository(Warehouse);
            const hayPredeterminado = await repo.exists({
              where: { distributorId, isDefault: true },
            });
            const esPredeterminado =
              dto.isDefault === true || !hayPredeterminado;
            if (esPredeterminado && hayPredeterminado) {
              await this.sacarPredeterminado(manager, distributorId);
            }
            return this.insertar(manager, distributorId, {
              name: dto.name,
              code: dto.code,
              kind: dto.kind ?? WarehouseKind.DEPOT,
              address: dto.address ?? null,
              isDefault: esPredeterminado,
            });
          }),
        { context: 'alta de depósito' },
      );
    } catch (error) {
      return this.traducir(error);
    }
  }

  async findAll(
    distributorId: string,
    query: QueryWarehouseDto = {},
  ): Promise<DepositoConUbicacion[]> {
    const qb = this.warehouses
      .createQueryBuilder('w')
      .innerJoinAndMapOne(
        'w.location',
        StockLocation,
        'l',
        'l.warehouseId = w.warehouseId',
      )
      .where('w.distributorId = :distributorId', { distributorId })
      .orderBy('w.isDefault', 'DESC')
      .addOrderBy('w.name', 'ASC');
    if (!query.includeInactive) qb.andWhere('w.isActive = true');
    const filas = await qb.getMany();
    return filas.map((w) => ({
      warehouse: w,
      locationId: (w as Warehouse & { location: StockLocation }).location
        .locationId,
    }));
  }

  async findOne(
    warehouseId: string,
    distributorId: string,
  ): Promise<DepositoConUbicacion> {
    const warehouse = await this.warehouses.findOne({
      where: { warehouseId, distributorId },
    });
    if (!warehouse) {
      throw new NotFoundException('Depósito no encontrado');
    }
    const ubicacion = await this.dataSource
      .getRepository(StockLocation)
      .findOneOrFail({ where: { warehouseId } });
    return { warehouse, locationId: ubicacion.locationId };
  }

  async update(
    warehouseId: string,
    dto: UpdateWarehouseDto,
    distributorId: string,
  ): Promise<DepositoConUbicacion> {
    try {
      await withTransactionRetry(
        () =>
          this.dataSource.transaction(async (manager) => {
            // Los dos depósitos que pueden cambiar de marca (el actual y el nuevo)
            // se bloquean juntos y en orden por id: dos cambios simultáneos hacia
            // lados opuestos no se cruzan.
            await this.bloquearPredeterminados(
              manager,
              distributorId,
              dto.isDefault === true ? warehouseId : null,
            );
            const repo = manager.getRepository(Warehouse);
            const warehouse = await repo.findOne({
              where: { warehouseId, distributorId },
              // Desactivar pide el lock exclusivo, como la baja: frena a la
              // apertura de una carga que lo está tomando de origen.
              ...(dto.isActive === false
                ? { lock: { mode: 'pessimistic_write' as const } }
                : {}),
            });
            if (!warehouse) {
              throw new NotFoundException('Depósito no encontrado');
            }
            if (dto.isActive === false && warehouse.isActive) {
              await this.asegurarSinCargaAbierta(
                manager,
                warehouseId,
                'desactivarlo',
              );
            }
            if (dto.isDefault === false && warehouse.isDefault) {
              throw new ConflictException(
                'Es el depósito predeterminado: elegí otro como predeterminado en lugar de sacarle la marca a este',
              );
            }
            if (dto.isActive === false && warehouse.isDefault) {
              throw new ConflictException(
                'No se puede desactivar el depósito predeterminado: elegí otro primero',
              );
            }
            if (dto.isDefault === true && !warehouse.isDefault) {
              // La entrega acredita la vacía en el predeterminado y un depósito
              // inactivo no recibe stock: omitiría todo el pedido.
              if ((dto.isActive ?? warehouse.isActive) === false) {
                throw new BadRequestException(
                  'El depósito predeterminado no puede estar inactivo: activalo o elegí otro como predeterminado',
                );
              }
              await this.sacarPredeterminado(manager, distributorId);
              warehouse.isDefault = true;
            }
            if (dto.name !== undefined) warehouse.name = dto.name;
            if (dto.code !== undefined) warehouse.code = dto.code;
            if (dto.kind !== undefined) warehouse.kind = dto.kind;
            if (dto.address !== undefined) warehouse.address = dto.address;
            if (dto.isActive !== undefined) warehouse.isActive = dto.isActive;
            await repo.save(warehouse);
          }),
        { context: 'edición de depósito' },
      );
    } catch (error) {
      return this.traducir(error);
    }
    return this.findOne(warehouseId, distributorId);
  }

  /**
   * Baja lógica. No se da de baja el predeterminado ni uno que todavía tiene
   * garrafas (de cualquier condición) ni uno que es el origen de una carga de
   * camión abierta: primero hay que transferirlas, ajustarlas o cerrar la carga.
   * Sus umbrales se borran con él.
   */
  async remove(warehouseId: string, distributorId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // Lock exclusivo de la fila: frena a una operación de stock que está
      // usando el depósito y, al obtenerlo, el saldo que se lee es el final.
      const warehouse = await manager
        .getRepository(Warehouse)
        .createQueryBuilder('w')
        .setLock('pessimistic_write')
        .where('w.warehouseId = :warehouseId', { warehouseId })
        .andWhere('w.distributorId = :distributorId', { distributorId })
        .getOne();
      if (!warehouse) {
        throw new NotFoundException('Depósito no encontrado');
      }
      if (warehouse.isDefault) {
        throw new ConflictException(
          'No se puede dar de baja el depósito predeterminado: elegí otro primero',
        );
      }
      await this.asegurarSinCargaAbierta(manager, warehouseId, 'darlo de baja');
      const [{ total }]: Array<{ total: string }> = await manager.query(
        `SELECT COALESCE(SUM(b."quantity"), 0) AS total
         FROM "stock_balance" b
         JOIN "stock_location" l ON l."location_id" = b."location_id"
         WHERE l."warehouse_id" = $1`,
        [warehouseId],
      );
      if (Number(total) !== 0) {
        throw new ConflictException(
          `El depósito todavía tiene ${total} garrafa(s): transferilas o ajustalas antes de darlo de baja`,
        );
      }
      await manager.delete(StockThreshold, { warehouseId });
      await manager.getRepository(Warehouse).softRemove(warehouse);
    });
  }

  /**
   * 409 si el depósito es el origen de una carga de camión abierta (`loading`,
   * `on_route` o `returned`): la rendición le devuelve las garrafas, y sin
   * depósito (o inactivo) la carga quedaría trabada. Lee `truck_load` de sólo
   * lectura, como la regularización de la transferencia: `stock` no depende de
   * `truck-load`. Corre con el depósito bloqueado `FOR UPDATE`; la apertura de
   * una carga lo toma `FOR SHARE`, así que una carga que se abre en paralelo se
   * ve acá o espera.
   */
  private async asegurarSinCargaAbierta(
    manager: EntityManager,
    warehouseId: string,
    accion: string,
  ): Promise<void> {
    const [abierta]: Array<{ number: number }> = await manager.query(
      `SELECT t."number" FROM "truck_load" t
       JOIN "stock_location" l ON l."location_id" = t."origin_location_id"
       WHERE l."warehouse_id" = $1
         AND t."status"::text IN ('loading', 'on_route', 'returned')
       ORDER BY t."number" LIMIT 1`,
      [warehouseId],
    );
    if (abierta) {
      throw new ConflictException(
        `El depósito es el origen de la carga N° ${abierta.number}, que sigue abierta: cerrala o cancelala antes de ${accion}`,
      );
    }
  }

  /**
   * El depósito predeterminado de la distribuidora; si no tiene ninguno, crea
   * el "Depósito central". Idempotente: lo usan el alta de la distribuidora,
   * el ajuste manual del catálogo y la entrega.
   */
  async asegurarPredeterminado(
    distributorId: string,
    manager?: EntityManager,
  ): Promise<DepositoConUbicacion> {
    const base = manager ?? this.dataSource.manager;
    const existente = await this.leerPredeterminado(base, distributorId);
    if (existente) return existente;
    try {
      // En un savepoint: si dos altas simultáneas chocan por el índice único,
      // se deshace sólo esta y la transacción de quien llama sigue sana.
      return await base.transaction((m) =>
        this.insertar(m, distributorId, {
          name: NOMBRE_DEPOSITO_CENTRAL,
          code: CODIGO_DEPOSITO_CENTRAL,
          kind: WarehouseKind.DEPOT,
          address: null,
          isDefault: true,
        }),
      );
    } catch (error) {
      if (esUnicoViolado(error)) {
        const ganador = await this.leerPredeterminado(base, distributorId);
        if (ganador) return ganador;
      }
      throw error;
    }
  }

  private async leerPredeterminado(
    manager: EntityManager,
    distributorId: string,
  ): Promise<DepositoConUbicacion | null> {
    const warehouse = await manager.getRepository(Warehouse).findOne({
      where: { distributorId, isDefault: true },
    });
    if (!warehouse) return null;
    const ubicacion = await manager
      .getRepository(StockLocation)
      .findOneOrFail({ where: { warehouseId: warehouse.warehouseId } });
    return { warehouse, locationId: ubicacion.locationId };
  }

  private async insertar(
    manager: EntityManager,
    distributorId: string,
    datos: Pick<Warehouse, 'name' | 'code' | 'kind' | 'address' | 'isDefault'>,
  ): Promise<DepositoConUbicacion> {
    const warehouse = await manager.getRepository(Warehouse).save(
      manager.getRepository(Warehouse).create({
        ...datos,
        distributorId,
        isActive: true,
      }),
    );
    const ubicacion = await manager.getRepository(StockLocation).save(
      manager.getRepository(StockLocation).create({
        distributorId,
        kind: StockLocationKind.WAREHOUSE,
        warehouseId: warehouse.warehouseId,
        carId: null,
      }),
    );
    this.logger.log(
      `Depósito ${warehouse.code} creado para la distribuidora ${distributorId}`,
    );
    return { warehouse, locationId: ubicacion.locationId };
  }

  /** `SELECT … ORDER BY id FOR UPDATE` del predeterminado actual y del candidato. */
  private async bloquearPredeterminados(
    manager: EntityManager,
    distributorId: string,
    candidato: string | null,
  ): Promise<void> {
    await manager.query(
      `SELECT "warehouse_id" FROM "warehouse"
       WHERE "distributor_id" = $1 AND "deletedAt" IS NULL
         AND ("is_default" OR "warehouse_id" = $2::uuid)
       ORDER BY "warehouse_id"
       FOR UPDATE`,
      [distributorId, candidato],
    );
  }

  private async sacarPredeterminado(
    manager: EntityManager,
    distributorId: string,
  ): Promise<void> {
    const repo = manager.getRepository(Warehouse);
    const actuales = await repo.find({
      where: { distributorId, isDefault: true },
    });
    for (const w of actuales) {
      w.isDefault = false;
      await repo.save(w);
    }
  }

  private traducir(error: unknown): never {
    if (esUnicoViolado(error)) {
      const restriccion = restriccionDe(error);
      if (restriccion === 'UQ_warehouse_default_vigente') {
        throw new ConflictException(
          'Otro cambio del depósito predeterminado se hizo al mismo tiempo: probá de nuevo',
        );
      }
      throw new ConflictException(
        'Ya existe un depósito vigente con ese código',
      );
    }
    return traducirErrorDeBase(error, this.logger, 'depósitos');
  }
}

function esUnicoViolado(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; driverError?: { code?: unknown } };
  return e.code === '23505' || e.driverError?.code === '23505';
}

function restriccionDe(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as {
    constraint?: unknown;
    driverError?: { constraint?: unknown };
  };
  const c = e.constraint ?? e.driverError?.constraint;
  return typeof c === 'string' ? c : undefined;
}
