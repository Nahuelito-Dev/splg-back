import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GasCylinderPhotoService } from '../../gascylinder/gascylinder-photo.service';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { StockOnHandService } from './stock-on-hand.service';
import { conciliarVendible } from '../domain/stock-rules';
import {
  DiferenciaDeVendibleDto,
  PedidoEntregadoSinMovimientoDto,
  StockReconciliationDto,
} from '../dto/stock-response.dto';

/**
 * Verifica la invariante del vendible (D4):
 *
 *   gas_cylinder.stock = max(0, Σ llenas (depósitos + camiones) − Σ pedidos abiertos)
 *
 * y busca las entregas que no descontaron el físico. Sólo informa: NUNCA
 * corrige. Lee todo en una transacción `REPEATABLE READ`, así las tres cifras
 * son del mismo instante y un pedido que se crea mientras tanto no genera una
 * diferencia falsa.
 */
@Injectable()
export class StockReconciliationService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orders: OrderLookupService,
    private readonly onHand: StockOnHandService,
    private readonly productos: GasCylinderPhotoService,
  ) {}

  async conciliar(distributorId: string): Promise<StockReconciliationDto> {
    const informe = await this.dataSource.transaction(
      'REPEATABLE READ',
      (manager) => this.leer(manager, distributorId),
    );
    // La foto no es parte de la foto del instante: se firma fuera de la transacción.
    const fotos = await this.productos.urlsPorId(distributorId, [
      ...informe.cylinders.map((c) => c.gasCylinderId),
      ...informe.deliveriesWithoutMovement.map((e) => e.gasCylinderId),
    ]);
    for (const c of informe.cylinders) {
      c.gasCylinderPhotoUrl = fotos.get(c.gasCylinderId) ?? null;
    }
    for (const e of informe.deliveriesWithoutMovement) {
      e.gasCylinderPhotoUrl = fotos.get(e.gasCylinderId) ?? null;
    }
    return informe;
  }

  private async leer(
    manager: DataSource['manager'],
    distributorId: string,
  ): Promise<StockReconciliationDto> {
    {
      const [garrafas, fisicas, reservadas, arranque] = await Promise.all([
        manager.query<
          Array<{
            gas_cylinder_id: string;
            type: string;
            stock: number;
            reservation_deficit: number;
          }>
        >(
          `SELECT "gas_cylinder_id", "type", "stock", "reservation_deficit" FROM "gas_cylinder"
           WHERE "distributor_id" = $1 ORDER BY "type"`,
          [distributorId],
        ),
        manager.query<Array<{ gas_cylinder_id: string; total: string }>>(
          `SELECT "gas_cylinder_id", SUM("quantity") AS total FROM "stock_balance"
           WHERE "distributor_id" = $1 AND "condition" = 'full'
           GROUP BY "gas_cylinder_id"`,
          [distributorId],
        ),
        this.orders.reservedByCylinder(distributorId, manager),
        this.onHand.inicioDelLibro(manager, distributorId),
      ]);
      const tipos = new Map(garrafas.map((g) => [g.gas_cylinder_id, g.type]));
      const fisicoPorGarrafa = new Map(
        fisicas.map((f) => [f.gas_cylinder_id, Number(f.total)]),
      );

      const cylinders: DiferenciaDeVendibleDto[] = garrafas.map((g) => {
        const d = conciliarVendible(
          g.gas_cylinder_id,
          g.stock,
          fisicoPorGarrafa.get(g.gas_cylinder_id) ?? 0,
          reservadas.get(g.gas_cylinder_id) ?? 0,
        );
        return {
          ...d,
          gasCylinderType: g.type,
          gasCylinderPhotoUrl: null,
          correction: 0 - d.difference,
          reservationDeficit: g.reservation_deficit,
          deficitDifference: g.reservation_deficit - d.overReserved,
        };
      });

      const deliveriesWithoutMovement = await this.entregasSinMovimiento(
        manager,
        distributorId,
        arranque,
        tipos,
      );

      return {
        checkedAt: new Date(),
        consistent:
          cylinders.every(
            (c) =>
              c.difference === 0 &&
              c.overReserved === 0 &&
              c.deficitDifference === 0,
          ) && deliveriesWithoutMovement.length === 0,
        cylinders,
        deliveriesWithoutMovement,
      };
    }
  }

  /**
   * Renglones entregados desde el arranque del módulo que no descontaron el
   * físico (sólo cuentan los posteriores al arranque: los anteriores no tenían
   * stock físico que descontar).
   */
  private async entregasSinMovimiento(
    manager: DataSource['manager'],
    distributorId: string,
    desde: Date | null,
    tipos: Map<string, string>,
  ): Promise<PedidoEntregadoSinMovimientoDto[]> {
    const pendientes: PedidoEntregadoSinMovimientoDto[] = [];
    if (!desde) return pendientes;
    const entregadas = await this.orders.deliveredItemsSince(
      distributorId,
      desde,
      manager,
    );
    const hechos = await this.entregasConMovimiento(
      manager,
      distributorId,
      entregadas.map((e) => e.orderId),
    );
    for (const e of entregadas) {
      if (hechos.has(`${e.orderId}|${e.gasCylinderId}`)) continue;
      pendientes.push({
        orderId: e.orderId,
        deliveredAt: e.deliveredAt,
        gasCylinderId: e.gasCylinderId,
        gasCylinderType: tipos.get(e.gasCylinderId) ?? e.gasCylinderId,
        gasCylinderPhotoUrl: null,
        quantity: Number(e.quantity),
      });
    }
    return pendientes;
  }

  /** Unidades entregadas de una garrafa que todavía no descontaron el físico. */
  async unidadesSinMovimientoDe(
    manager: DataSource['manager'],
    distributorId: string,
    gasCylinderId: string,
  ): Promise<number> {
    const desde = await this.onHand.inicioDelLibro(manager, distributorId);
    const pendientes = await this.entregasSinMovimiento(
      manager,
      distributorId,
      desde,
      new Map(),
    );
    return pendientes
      .filter((p) => p.gasCylinderId === gasCylinderId)
      .reduce((total, p) => total + p.quantity, 0);
  }

  private async entregasConMovimiento(
    manager: DataSource['manager'],
    distributorId: string,
    orderIds: string[],
  ): Promise<Set<string>> {
    if (orderIds.length === 0) return new Set();
    const filas: Array<{ reference_id: string; gas_cylinder_id: string }> =
      await manager.query(
        `SELECT "reference_id", "gas_cylinder_id" FROM "stock_movement"
         WHERE "distributor_id" = $1 AND "reference_type" = 'order' AND "reason" = 'delivery'
           AND "reference_id" = ANY($2::uuid[])`,
        [distributorId, [...new Set(orderIds)]],
      );
    return new Set(filas.map((f) => `${f.reference_id}|${f.gas_cylinder_id}`));
  }
}
