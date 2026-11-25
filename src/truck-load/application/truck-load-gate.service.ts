import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { TruckLoadGatePort } from '../../order/domain/ports/truck-load-gate.port';
import { ESTADOS_ABIERTOS, TruckLoadStatus } from '../domain/truck-load.enums';
import { MotivoSinPedidos, motivoSinPedidos } from '../domain/truck-load-rules';
import {
  alcanzaElStock,
  RenglonPedido,
} from '../domain/stock-del-camion-alcanza';
import { StockControlSettingsService } from './stock-control-settings.service';

export const MENSAJE_SIN_CARGA =
  'Tu distribuidora exige una carga de camión abierta para trabajar: pedile al administrador que abra tu carga del día';
export const MENSAJE_SIN_CARGA_DEL_CHOFER =
  'El chofer no tiene la carga del día abierta';
/** Lo que la app le muestra al chofer que tiene que abrir su carga. */
export const MENSAJE_ABRIR_CARGA = 'Abrí tu carga para recibir pedidos';

interface FilaDeChofer {
  user_id: string;
  delivery_id: string;
  number: number | null;
  status: TruckLoadStatus | null;
  car_id: string | null;
  en_uso: string | null;
}

/**
 * Implementación del puerto del despacho: quién recibe y acepta pedidos según
 * su carga de camión (ver `motivoSinPedidos`). Lee `truck_load` y la
 * asignación del vehículo en una sola consulta.
 */
@Injectable()
export class TruckLoadGateService extends TruckLoadGatePort {
  constructor(
    private readonly settings: StockControlSettingsService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super();
  }

  async choferesQuePuedenRecibir(
    distributorId: string,
    userIds: string[],
  ): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const exige = (await this.settings.obtener(distributorId))
      .requireOpenTruckLoad;
    const filas = await this.leer(distributorId, 'd."user_id"', userIds);
    return new Set(
      filas
        .filter((f) => this.motivoDe(exige, f) === null)
        .map((f) => f.user_id),
    );
  }

  async choferesConStockPara(
    distributorId: string,
    userIds: string[],
    renglones: readonly RenglonPedido[],
  ): Promise<Set<string>> {
    const todos = new Set(userIds);
    if (userIds.length === 0 || renglones.length === 0) return todos;
    const { requireOpenTruckLoad } = await this.settings.obtener(distributorId);
    if (!requireOpenTruckLoad) return todos;

    const vehiculos: Array<{ user_id: string; car_id: string }> =
      await this.dataSource.query(
        `SELECT d."user_id", va."car_id"
           FROM "delivery" d
           JOIN "vehicle_assignment" va ON va."delivery_id" = d."delivery_id"
            AND va."released_at" IS NULL
          WHERE d."distributor_id" = $1 AND d."user_id" = ANY($2::uuid[])`,
        [distributorId, userIds],
      );
    if (vehiculos.length === 0) return todos;

    // Una fila por vehículo que tiene ubicación de stock (aunque esté vacía:
    // `gas_cylinder_id` null); un vehículo sin ubicación no tiene datos.
    const saldos: Array<{
      car_id: string;
      gas_cylinder_id: string | null;
      full: number;
    }> = await this.dataSource.query(
      `SELECT l."car_id", b."gas_cylinder_id",
              COALESCE(SUM(b."quantity") FILTER (WHERE b."condition" = 'full'), 0)::int AS "full"
         FROM "stock_location" l
         LEFT JOIN "stock_balance" b ON b."location_id" = l."location_id" AND b."quantity" > 0
        WHERE l."distributor_id" = $1 AND l."car_id" = ANY($2::uuid[])
        GROUP BY l."car_id", b."gas_cylinder_id"`,
      [distributorId, [...new Set(vehiculos.map((v) => v.car_id))]],
    );
    const llenasPorVehiculo = new Map<string, Map<string, number>>();
    for (const s of saldos) {
      const tipos =
        llenasPorVehiculo.get(s.car_id) ?? new Map<string, number>();
      if (s.gas_cylinder_id) {
        tipos.set(
          s.gas_cylinder_id,
          (tipos.get(s.gas_cylinder_id) ?? 0) + s.full,
        );
      }
      llenasPorVehiculo.set(s.car_id, tipos);
    }
    for (const v of vehiculos) {
      const llenas = llenasPorVehiculo.get(v.car_id);
      if (llenas && !alcanzaElStock(llenas, renglones)) todos.delete(v.user_id);
    }
    return todos;
  }

  async motivoParaNoRecibir(
    distributorId: string,
    userId: string,
  ): Promise<string | null> {
    const exige = (await this.settings.obtener(distributorId))
      .requireOpenTruckLoad;
    const [fila] = await this.leer(distributorId, 'd."user_id"', [userId]);
    const motivo = fila ? this.motivoDe(exige, fila) : null;
    return motivo ? this.textoParaLaApp(motivo) : null;
  }

  async motivoParaElAdmin(
    distributorId: string,
    userId: string,
  ): Promise<string | null> {
    const exige = (await this.settings.obtener(distributorId))
      .requireOpenTruckLoad;
    const [fila] = await this.leer(distributorId, 'd."user_id"', [userId]);
    const motivo = fila ? this.motivoDe(exige, fila) : null;
    return motivo ? this.textoParaElAdmin(motivo) : null;
  }

  async assertPuedeAceptar(
    distributorId: string,
    deliveryId: string,
    manager?: EntityManager,
  ): Promise<void> {
    await this.exigir(distributorId, deliveryId, MENSAJE_SIN_CARGA, manager);
  }

  async assertPuedeAsignar(
    distributorId: string,
    deliveryId: string,
    manager?: EntityManager,
  ): Promise<void> {
    await this.exigir(
      distributorId,
      deliveryId,
      MENSAJE_SIN_CARGA_DEL_CHOFER,
      manager,
    );
  }

  private async exigir(
    distributorId: string,
    deliveryId: string,
    mensajeSinCarga: string,
    manager?: EntityManager,
  ): Promise<void> {
    const exige = (await this.settings.obtener(distributorId))
      .requireOpenTruckLoad;
    if (manager) {
      // FOR SHARE sobre la carga abierta del chofer, ANTES de leer su estado:
      // la vuelta la toma FOR UPDATE (`bloquearCarga`), así que se serializan.
      await manager.query(
        `SELECT 1 FROM "truck_load" WHERE "delivery_id" = $1
           AND "status"::text = ANY($2::text[]) FOR SHARE`,
        [deliveryId, ESTADOS_ABIERTOS],
      );
    }
    const [fila] = await this.leer(
      distributorId,
      'd."delivery_id"',
      [deliveryId],
      manager,
    );
    const motivo = fila ? this.motivoDe(exige, fila) : null;
    if (!motivo) return;
    throw new BadRequestException(
      motivo.codigo === 'sin-carga'
        ? mensajeSinCarga
        : this.textoParaLaApp(motivo),
    );
  }

  private motivoDe(exige: boolean, f: FilaDeChofer): MotivoSinPedidos | null {
    return motivoSinPedidos({
      exige,
      carga:
        f.number !== null && f.status !== null && f.car_id !== null
          ? { number: f.number, status: f.status, carId: f.car_id }
          : null,
      vehiculoEnUsoId: f.en_uso,
    });
  }

  private textoParaLaApp(m: MotivoSinPedidos): string {
    switch (m.codigo) {
      case 'sin-carga':
        return MENSAJE_ABRIR_CARGA;
      case 'sin-salir':
        return `La carga N° ${m.number} todavía no salió: confirmá la salida del camión para recibir pedidos`;
      case 'devuelta':
        return `La carga N° ${m.number} ya volvió: no se reciben pedidos hasta cerrar su rendición`;
      case 'otro-vehiculo':
        return `El vehículo en uso no es el de la carga N° ${m.number}`;
    }
  }

  private textoParaElAdmin(m: MotivoSinPedidos): string {
    switch (m.codigo) {
      case 'sin-carga':
        return 'no tiene la carga del día abierta';
      case 'sin-salir':
        return `la carga N° ${m.number} todavía no salió`;
      case 'devuelta':
        return `la carga N° ${m.number} ya volvió y falta cerrar su rendición`;
      case 'otro-vehiculo':
        return `su vehículo en uso no es el de la carga N° ${m.number}`;
    }
  }

  private leer(
    distributorId: string,
    columna: string,
    valores: string[],
    manager?: EntityManager,
  ): Promise<FilaDeChofer[]> {
    return (manager ?? this.dataSource).query(
      `SELECT d."user_id", d."delivery_id", l."number", l."status", l."car_id",
              va."car_id" AS en_uso
       FROM "delivery" d
       LEFT JOIN "truck_load" l ON l."delivery_id" = d."delivery_id"
         AND l."status"::text = ANY($3::text[])
       LEFT JOIN "vehicle_assignment" va ON va."delivery_id" = d."delivery_id"
         AND va."released_at" IS NULL
       WHERE d."distributor_id" = $1 AND ${columna} = ANY($2::uuid[])`,
      [distributorId, valores, ESTADOS_ABIERTOS],
    );
  }
}
