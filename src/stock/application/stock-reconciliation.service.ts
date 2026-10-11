import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { conciliarVendible } from '../domain/stock-rules';
import {
  DiferenciaDeVendibleDto,
  PedidoEntregadoSinMovimientoDto,
  StockReconciliationDto,
} from '../dto/stock-response.dto';

/**
 * Verifica la invariante del vendible (D4):
 *
 *   gas_cylinder.stock = Σ llenas (depósitos + camiones) − Σ pedidos abiertos
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
  ) {}

  async conciliar(distributorId: string): Promise<StockReconciliationDto> {
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const [garrafas, fisicas, reservadas, arranque] = await Promise.all([
        manager.query<
          Array<{ gas_cylinder_id: string; type: string; stock: number }>
        >(
          `SELECT "gas_cylinder_id", "type", "stock" FROM "gas_cylinder"
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
        manager.query<Array<{ desde: Date | null }>>(
          `SELECT MIN("occurred_at") AS desde FROM "stock_movement" WHERE "distributor_id" = $1`,
          [distributorId],
        ),
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
          correction: -d.difference,
        };
      });

      // Sólo cuentan las entregas posteriores al arranque del módulo: las
      // anteriores no tenían stock físico que descontar.
      const deliveriesWithoutMovement: PedidoEntregadoSinMovimientoDto[] = [];
      const desde = arranque[0]?.desde;
      if (desde) {
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
          deliveriesWithoutMovement.push({
            orderId: e.orderId,
            deliveredAt: e.deliveredAt,
            gasCylinderId: e.gasCylinderId,
            gasCylinderType: tipos.get(e.gasCylinderId) ?? e.gasCylinderId,
            quantity: Number(e.quantity),
          });
        }
      }

      return {
        checkedAt: new Date(),
        consistent:
          cylinders.every((c) => c.difference === 0) &&
          deliveriesWithoutMovement.length === 0,
        cylinders,
        deliveriesWithoutMovement,
      };
    });
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
