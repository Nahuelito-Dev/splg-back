import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';
import { empleadoDelChofer } from '../../common/tenancy/chofer-empleado';
import { errorMessage } from '../../common/errors/error-message';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { aCentavos } from '../../common/utils/dinero';
import { Order, OrderStatus } from '../../order/entities/order.entity';
import { calcularComision } from '../domain/commission-rules';
import { CommissionEntryType } from '../domain/commission.enums';
import { ComisionConflictoError } from '../domain/errors/commission.errors';
import { CommissionEntry } from '../entities/commission-entry.entity';
import { CommissionRule } from '../entities/commission-rule.entity';

export type ResultadoDeDevengo =
  | 'creada'
  | 'existente'
  | 'sin-regla'
  | 'sin-chofer'
  | 'no-entregado';

/** Los pedidos entregados se miran hasta hace tanto tiempo en el barrido nocturno. */
const VENTANA_DEL_BARRIDO_DIAS = 7;

/**
 * Libro de comisiones del chofer. Devenga la comisión de cada entrega (CU-241)
 * con la regla vigente el día de la entrega y guarda una copia de ella; y
 * asienta las deducciones (el faltante de una rendición a cargo del chofer).
 * Idempotente: el asiento de una entrega es único por pedido.
 */
@Injectable()
export class CommissionLedgerService {
  private readonly logger = new Logger(CommissionLedgerService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async devengarPorPedido(orderId: string): Promise<ResultadoDeDevengo> {
    return this.dataSource.transaction(async (manager) => {
      const pedido = await manager.findOne(Order, {
        where: { orderId },
        relations: { items: true },
      });
      if (
        !pedido ||
        pedido.status !== OrderStatus.DELIVERED ||
        !pedido.deliveryId ||
        !pedido.deliveredAt
      ) {
        return 'no-entregado';
      }
      const yaEsta = await manager.exists(CommissionEntry, {
        where: { orderId, type: CommissionEntryType.DELIVERY_COMMISSION },
      });
      if (yaEsta) return 'existente';

      const empleado = await empleadoDelChofer(manager, pedido.deliveryId);
      if (!empleado) {
        this.logger.warn(
          `Pedido ${orderId}: el chofer ${pedido.deliveryId} no tiene legajo, no se devenga comisión`,
        );
        return 'sin-chofer';
      }
      const reglas = await manager.find(CommissionRule, {
        where: { distributorId: pedido.distributorId, isActive: true },
      });
      const dia = diaArgentino(pedido.deliveredAt);
      const { total, lineas } = calcularComision(
        reglas,
        empleado.employeeId,
        dia,
        pedido.items.map((i) => ({
          gasCylinderId: i.gasCylinderId,
          quantity: i.quantity,
          subtotal: i.subtotal,
        })),
      );
      if (lineas.length === 0 || total.isZero()) return 'sin-regla';

      const resultado = await manager
        .createQueryBuilder()
        .insert()
        .into(CommissionEntry)
        .values({
          distributorId: pedido.distributorId,
          employeeId: empleado.employeeId,
          deliveryId: pedido.deliveryId,
          type: CommissionEntryType.DELIVERY_COMMISSION,
          amount: aCentavos(total),
          orderId,
          ruleId: lineas[0].ruleId,
          ruleSnapshot: lineas,
          description: `Comisión por la entrega del pedido ${orderId.slice(0, 8)}`,
          occurredAt: pedido.deliveredAt,
        })
        .orIgnore()
        .execute();
      return resultado.identifiers.length > 0 ? 'creada' : 'existente';
    });
  }

  /**
   * Descuenta al chofer el faltante de una rendición (importe negativo en el
   * libro). Único por rendición. 409 si el chofer no tiene legajo.
   */
  async registrarFaltante(
    manager: EntityManager,
    datos: {
      distributorId: string;
      deliveryId: string;
      faltante: Decimal.Value;
      settlementId: string;
      settlementNumber: number;
      userId: string;
    },
  ): Promise<void> {
    const empleado = await empleadoDelChofer(manager, datos.deliveryId);
    if (!empleado) {
      throw new ComisionConflictoError(
        'El chofer no tiene legajo: no se le puede descontar el faltante. Resolvelo como absorbed',
      );
    }
    await manager
      .createQueryBuilder()
      .insert()
      .into(CommissionEntry)
      .values({
        distributorId: datos.distributorId,
        employeeId: empleado.employeeId,
        deliveryId: datos.deliveryId,
        type: CommissionEntryType.SETTLEMENT_SHORTAGE,
        amount: aCentavos(new Decimal(datos.faltante).abs().negated()),
        referenceId: datos.settlementId,
        description: `Faltante de la rendición N° ${datos.settlementNumber}`,
        createdByUserId: datos.userId,
      })
      .orIgnore()
      .execute();
  }

  /**
   * Barrido nocturno: devenga las comisiones de los pedidos entregados en los
   * últimos días que se quedaron sin asiento (un oyente que falló, un servidor
   * caído). Devuelve cuántos asientos creó.
   */
  async barrer(): Promise<number> {
    const pendientes: Array<{ order_id: string }> = await this.dataSource.query(
      `SELECT o."order_id" FROM "order" o
       WHERE o."status" = 'delivered' AND o."delivery_id" IS NOT NULL
         AND o."deliveredAt" >= now() - make_interval(days => $1)
         AND NOT EXISTS (
           SELECT 1 FROM "commission_entry" c
           WHERE c."order_id" = o."order_id" AND c."type" = 'delivery_commission')`,
      [VENTANA_DEL_BARRIDO_DIAS],
    );
    let creadas = 0;
    for (const { order_id } of pendientes) {
      try {
        if ((await this.devengarPorPedido(order_id)) === 'creada') creadas += 1;
      } catch (error) {
        this.logger.error(
          `No se pudo devengar la comisión del pedido ${order_id}: ${errorMessage(error)}`,
        );
      }
    }
    return creadas;
  }
}
