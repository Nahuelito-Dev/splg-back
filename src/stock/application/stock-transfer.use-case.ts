import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { exigirGarrafasDeLosRenglones } from './renglones-de-garrafas';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import { OperacionDeStockInvalidaError } from '../domain/errors/stock.errors';
import {
  MovimientoDeStock,
  StockLedgerPort,
} from '../domain/ports/stock-ledger.port';
import {
  StockCondition,
  StockLocationKind,
  StockMovementReason,
  StockReferenceType,
} from '../domain/stock.enums';
import { CreateTransferDto } from '../dto/stock-operations.dto';
import { StockLocationService } from './stock-location.service';

export const MENSAJE_CAMION_POR_CARGA =
  'El camión se carga y se rinde desde la carga del día';

/**
 * Transferencia entre dos ubicaciones: depósito a depósito, o de un vehículo
 * al depósito. Sin tabla propia: son movimientos del libro con el mismo lote y
 * `reason = transfer`. El vendible no cambia (las llenas siguen dentro del
 * conjunto depósitos + camiones).
 *
 * El stock del camión entra y sale SÓLO por la carga del día (`truck-load`):
 * no se transfiere a un vehículo. La única excepción es regularizar —devolver al
 * depósito lo que un vehículo tiene suelto— y sólo si no tiene una carga abierta
 * y con una nota que lo explique. Se eligió esta vía y no un endpoint aparte
 * porque deja el mismo rastro (lote, libro, auditoría, idempotencia) y la regla
 * cabe en una línea; el endpoint de regularización sería la misma transferencia
 * con otro nombre.
 */
@Injectable()
export class StockTransferUseCase {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: StockLedgerPort,
    private readonly locations: StockLocationService,
  ) {}

  /**
   * Devolver al depósito lo que un vehículo tiene suelto: sin carga abierta (si
   * la tiene, se rinde desde la carga) y con nota. Lee `truck_load` sólo para
   * saber si hay una carga abierta; no escribe nada de ese módulo.
   */
  private async validarRegularizacion(
    manager: EntityManager,
    carId: string | null,
    notes: string | undefined,
  ): Promise<void> {
    const [abierta]: Array<{ number: number }> = await manager.query(
      `SELECT "number" FROM "truck_load"
       WHERE "car_id" = $1 AND "status"::text IN ('loading', 'on_route', 'returned')`,
      [carId],
    );
    if (abierta) {
      throw new ConflictException(
        `${MENSAJE_CAMION_POR_CARGA}: el camión tiene abierta la carga N° ${abierta.number}`,
      );
    }
    if (!notes?.trim()) {
      throw new OperacionDeStockInvalidaError(
        'Para devolver al depósito el stock suelto de un camión indicá en las notas por qué',
      );
    }
  }

  /** Devuelve el id del lote. */
  async execute(
    dto: CreateTransferDto,
    distributorId: string,
    actorUserId: string,
  ): Promise<string> {
    const repetidas = new Set<string>();
    for (const item of dto.items) {
      const clave = `${item.gasCylinderId}|${item.condition ?? StockCondition.FULL}`;
      if (repetidas.has(clave)) {
        throw new OperacionDeStockInvalidaError(
          'Hay dos renglones para la misma garrafa y condición',
        );
      }
      repetidas.add(clave);
    }
    return withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          await exigirGarrafasDeLosRenglones(
            manager,
            distributorId,
            dto.items.map((i) => i.gasCylinderId),
          );
          const origen = await this.locations.resolver(
            manager,
            distributorId,
            dto.from,
          );
          const destino = await this.locations.resolver(
            manager,
            distributorId,
            dto.to,
          );
          if (origen.locationId === destino.locationId) {
            throw new OperacionDeStockInvalidaError(
              'El origen y el destino son la misma ubicación',
            );
          }
          if (
            origen.kind === StockLocationKind.VEHICLE &&
            destino.kind === StockLocationKind.VEHICLE
          ) {
            throw new OperacionDeStockInvalidaError(
              'No se transfiere de un vehículo a otro: pasá por un depósito',
            );
          }
          if (destino.kind === StockLocationKind.VEHICLE) {
            throw new OperacionDeStockInvalidaError(MENSAJE_CAMION_POR_CARGA);
          }
          if (origen.kind === StockLocationKind.VEHICLE) {
            await this.validarRegularizacion(manager, origen.carId, dto.notes);
          }
          const batchId = randomUUID();
          const movimientos: MovimientoDeStock[] = dto.items.map((item) => {
            const condition = item.condition ?? StockCondition.FULL;
            return {
              gasCylinderId: item.gasCylinderId,
              quantity: item.quantity,
              from: { locationId: origen.locationId, condition },
              to: { locationId: destino.locationId, condition },
              reason: StockMovementReason.TRANSFER,
            };
          });
          await this.ledger.aplicar(manager, {
            distributorId,
            referenceType: StockReferenceType.TRANSFER,
            referenceId: batchId,
            batchId,
            actorUserId,
            notes: dto.notes?.trim() || null,
            movimientos,
          });
          return batchId;
        }),
      { context: 'transferencia de stock' },
    );
  }
}
