import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { EntregaDePedido } from '../../order/domain/ports/stock-delivery.port';
import { StockDeliveryService } from './stock-delivery.service';
import { StockOnHandService } from './stock-on-hand.service';

export interface ResultadoDeReaplicacion {
  /** Pedidos revisados que no tenían su movimiento. */
  revisados: number;
  /** Pedidos a los que se les descontó el físico ahora. */
  reaplicados: number;
  /** Pedidos que siguen sin saldo de donde sacar. */
  pendientes: number;
}

/**
 * Acción explícita del administrador (no la hace la conciliación sola): vuelve
 * a descontar el físico de las entregas que no lo hicieron, una vez que
 * corrigió la causa (por ejemplo, transfirió llenas al depósito). Idempotente.
 */
@Injectable()
export class ReapplyDeliveriesUseCase {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orders: OrderLookupService,
    private readonly delivery: StockDeliveryService,
    private readonly onHand: StockOnHandService,
  ) {}

  async execute(distributorId: string): Promise<ResultadoDeReaplicacion> {
    const desde = await this.onHand.inicioDelLibro(
      this.dataSource.manager,
      distributorId,
    );
    if (!desde) return { revisados: 0, reaplicados: 0, pendientes: 0 };

    const renglones = await this.orders.deliveredItemsSince(
      distributorId,
      desde,
    );
    const porPedido = new Map<
      string,
      EntregaDePedido & {
        items: Array<{
          gasCylinderId: string;
          quantity: number;
          containersCharged: number;
          emptiesReceived: number | null;
        }>;
      }
    >();
    for (const r of renglones) {
      const entrega = porPedido.get(r.orderId) ?? {
        orderId: r.orderId,
        distributorId,
        vehicleCarId: r.vehicleCarId,
        items: [],
      };
      entrega.items.push({
        gasCylinderId: r.gasCylinderId,
        quantity: Number(r.quantity),
        containersCharged: Number(r.containersCharged),
        emptiesReceived:
          r.emptiesReceived === null ? null : Number(r.emptiesReceived),
      });
      porPedido.set(r.orderId, entrega);
    }

    const resultado: ResultadoDeReaplicacion = {
      revisados: 0,
      reaplicados: 0,
      pendientes: 0,
    };
    for (const entrega of porPedido.values()) {
      const r = await this.dataSource.transaction((manager) =>
        this.delivery.registrarEntrega(manager, entrega),
      );
      if (r.aplicadas.length === 0 && r.omitidas.length === 0) continue;
      resultado.revisados += 1;
      if (r.omitidas.length > 0) resultado.pendientes += 1;
      else resultado.reaplicados += 1;
    }
    return resultado;
  }
}
