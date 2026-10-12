import { ConflictException, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  codigoSqlDelError,
  traducirErrorDeBase,
} from '../../common/errors/db-exceptions';
import { GarrafaNoEncontradaEnStockError } from '../../stock/domain/errors/stock.errors';
import { CargaNoEncontradaError } from '../domain/errors/truck-load.errors';
import { TruckLoad } from '../entities/truck-load.entity';

/**
 * Lock de la fila de la carga (`FOR UPDATE`, 404 si no es de la distribuidora).
 * Es el PRIMER lock de toda operación sobre una carga ya abierta: después vienen
 * `gas_cylinder`, el depósito, los saldos (los toma el ledger, en su orden) y,
 * si hace falta, `document_sequence`.
 */
export async function bloquearCarga(
  manager: EntityManager,
  id: string,
  distributorId: string,
): Promise<TruckLoad> {
  const carga = await manager
    .getRepository(TruckLoad)
    .createQueryBuilder('l')
    .setLock('pessimistic_write')
    .where('l.loadId = :id AND l.distributorId = :distributorId', {
      id,
      distributorId,
    })
    .getOne();
  if (!carga) throw new CargaNoEncontradaError(id);
  return carga;
}

/**
 * Una carga ajena al chofer que pregunta es un 404 (no se revela que existe).
 * `alcance` es el `delivery_id` del chofer, o `undefined` si pide un
 * administrador.
 */
export function asegurarAlcance(
  carga: TruckLoad,
  alcance: string | undefined,
): void {
  if (alcance !== undefined && carga.deliveryId !== alcance) {
    throw new CargaNoEncontradaError(carga.loadId);
  }
}

/**
 * Las garrafas existen y son de la distribuidora; las deja con `FOR KEY SHARE`,
 * por id, ANTES de la secuencia o de insertar renglones: es lo que la clave
 * foránea del renglón pide igual, y tomarlo después de otros locks se cruzaba
 * con un ajuste (que bloquea `gas_cylinder` primero).
 */
export async function bloquearGarrafasComoClaveForanea(
  manager: EntityManager,
  distributorId: string,
  ids: string[],
): Promise<void> {
  const unicos = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  if (unicos.length === 0) return;
  const filas: Array<{ gas_cylinder_id: string }> = await manager.query(
    `SELECT "gas_cylinder_id" FROM "gas_cylinder"
     WHERE "gas_cylinder_id" = ANY($1::uuid[]) AND "distributor_id" = $2
     ORDER BY "gas_cylinder_id" FOR KEY SHARE`,
    [unicos, distributorId],
  );
  const vistas = new Set(filas.map((f) => f.gas_cylinder_id));
  const faltante = unicos.find((id) => !vistas.has(id));
  if (faltante) throw new GarrafaNoEncontradaEnStockError(faltante);
}

function restriccionDelError(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const driver: unknown = (error as Record<string, unknown>).driverError;
  if (typeof driver !== 'object' || driver === null) return undefined;
  const constraint: unknown = (driver as Record<string, unknown>).constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

/**
 * Los errores de base (carrera sobre el único de carga abierta) salen con un
 * mensaje claro; lo demás se deja pasar o se traduce como siempre.
 */
export function traducirErrorDeCarga(
  error: unknown,
  logger: Logger,
  contexto: string,
): never {
  if (codigoSqlDelError(error) === undefined) throw error;
  const restriccion = restriccionDelError(error);
  if (restriccion === 'UQ_truck_load_camion_abierta') {
    throw new ConflictException('El camión ya tiene una carga abierta');
  }
  if (restriccion === 'UQ_truck_load_chofer_abierta') {
    throw new ConflictException('El chofer ya tiene una carga abierta');
  }
  return traducirErrorDeBase(error, logger, contexto);
}

/**
 * El reloj de la base. `openedAt` y `returnedAt` delimitan qué entregas
 * pertenecen a la carga (se comparan con `occurred_at` del libro): salen de
 * acá y no del reloj del proceso, para que un servidor desfasado no deje afuera
 * (o adentro) una entrega. `clock_timestamp()` y no `now()`: este último es el
 * inicio de la transacción.
 */
export async function ahoraDeLaBase(manager: EntityManager): Promise<Date> {
  const [{ ahora }]: Array<{ ahora: Date }> = await manager.query(
    `SELECT clock_timestamp() AS ahora`,
  );
  return ahora;
}
