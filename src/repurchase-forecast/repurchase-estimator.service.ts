import { Injectable } from '@nestjs/common';
import { CustomersService } from '../customer/customer.service';
import { ConfigurableProcess } from '../distributor/entities/module-config.entity';
import { ProcessConfigService } from '../distributor/process-config.service';
import { ValoresDeProceso } from '../distributor/process-config';
import {
  CompraEntregadaRef,
  OrderLookupService,
} from '../order/lookup/order-lookup.service';
import { aplicarOffset } from './domain/ajuste-por-cliente';
import { RepurchaseOffsetService } from './repurchase-offset.service';
import {
  EstimacionDeRecompra,
  MotivoSinEstimacion,
  estimarRecompra,
} from './domain/estimacion-de-recompra';
import {
  HabitosDeCompra,
  comoEstimacion,
  habitosDe,
} from './domain/habitos-de-compra';

const MS_POR_DIA = 86_400_000;
/** Cuánto historial se mira: más viejo que esto ya no es su ritmo de hoy. */
export const HISTORIAL_DIAS = 400;

/** Los parámetros del proceso `repurchase`, ya leídos de la distribuidora. */
export interface ParametrosDeRecompra {
  /** La anticipación está encendida para la distribuidora (viene apagada). */
  enabled: boolean;
  minOrders: number;
  anticipationDays: number;
  invitationTtlHours: number;
  minIntervalDays: number;
  runHour: number;
  recentOrderDays: number;
  staleDays: number;
}

/** Un cliente con la fecha en que se le acaba el gas y lo que suele pedir. */
export interface RecompraEstimada {
  customerId: string;
  userId: string;
  fullName: string | null;
  email: string | null;
  phoneNumber: string | null;
  /** La estimación, ya con el ajuste del cliente si le correspondía. */
  estimate: EstimacionDeRecompra;
  /** Días que el ajuste del cliente (M3a) corrió la fecha; 0 si no se aplicó. */
  offsetDays: number;
  habits: HabitosDeCompra;
  declaredKgPerMonth: number | null;
  /** Días de anticipación que rigen para él: los suyos o los de la distribuidora. */
  noticeDays: number;
  noticeEnabled: boolean;
  /** Cuántos días de anticipación eligió él; `null` si rige la distribuidora. */
  ownNoticeDays: number | null;
}

/** El resultado de evaluar a un cliente: su estimación o por qué no hay. */
export interface EvaluacionDeCliente {
  userId: string;
  cliente: RecompraEstimada | null;
  reason: MotivoSinEstimacion | null;
}

/**
 * Estima cuándo se le acaba el gas a los clientes de una distribuidora (CU-106 y
 * CU-146). La fecha no se guarda: sale de las compras que la distribuidora le
 * entregó al cliente y, sin historia suficiente, del consumo que declaró
 * (CU-143 y CU-144). Un cliente que nunca le compró a la distribuidora no
 * aparece: pertenece a ella desde su primera compra.
 */
@Injectable()
export class RepurchaseEstimatorService {
  constructor(
    private readonly processConfig: ProcessConfigService,
    private readonly pedidos: OrderLookupService,
    private readonly customers: CustomersService,
    private readonly offsets: RepurchaseOffsetService,
  ) {}

  /** Los parámetros vigentes del proceso para la distribuidora. */
  async parametros(distributorId: string): Promise<ParametrosDeRecompra> {
    const valores: ValoresDeProceso = await this.processConfig.obtener(
      distributorId,
      ConfigurableProcess.REPURCHASE,
    );
    return {
      enabled: valores.enabled === 1,
      minOrders: valores.minOrders,
      anticipationDays: valores.anticipationDays,
      invitationTtlHours: valores.invitationTtlHours,
      minIntervalDays: valores.minIntervalDays,
      runHour: valores.runHour,
      recentOrderDays: valores.recentOrderDays,
      staleDays: valores.staleDays,
    };
  }

  /**
   * Las estimaciones de los clientes de la distribuidora, ordenadas por la
   * fecha en que se les acaba el gas. Quedan afuera los que no tienen con qué
   * estimarlos.
   */
  async estimar(
    distributorId: string,
    ahora: Date,
    params: ParametrosDeRecompra,
  ): Promise<RecompraEstimada[]> {
    const evaluados = await this.evaluar(distributorId, ahora, params);
    const resultado: RecompraEstimada[] = [];
    for (const e of evaluados) {
      if (e.cliente) resultado.push(e.cliente);
    }
    return resultado.sort(
      (a, b) =>
        a.estimate.estimatedAt.getTime() - b.estimate.estimatedAt.getTime() ||
        a.userId.localeCompare(b.userId),
    );
  }

  /**
   * La estimación de un cliente, o por qué no se lo puede proyectar. `null` si
   * no es cliente de la distribuidora.
   */
  async estimarCliente(
    distributorId: string,
    userId: string,
    ahora: Date,
    params: ParametrosDeRecompra,
  ): Promise<EvaluacionDeCliente | null> {
    const [evaluado] = await this.evaluar(distributorId, ahora, params, userId);
    return evaluado ?? null;
  }

  private async evaluar(
    distributorId: string,
    ahora: Date,
    params: ParametrosDeRecompra,
    userId?: string,
  ): Promise<EvaluacionDeCliente[]> {
    const desde = new Date(ahora.getTime() - HISTORIAL_DIAS * MS_POR_DIA);
    const compras = await this.pedidos.comprasEntregadas(
      distributorId,
      desde,
      userId,
    );
    const porCliente = new Map<string, CompraEntregadaRef[]>();
    for (const c of compras) {
      porCliente.set(c.customerId, [
        ...(porCliente.get(c.customerId) ?? []),
        c,
      ]);
    }
    const fichas = await this.customers.fichasDeRecompra(
      distributorId,
      userId ? [userId] : [...porCliente.keys()],
    );

    const ajustes = await this.offsets.deClientes(
      distributorId,
      fichas.map((f) => f.userId),
    );

    return fichas.map((ficha) => {
      const suyas = porCliente.get(ficha.userId) ?? [];
      const estimacion = estimarRecompra(
        suyas.map(comoEstimacion),
        ficha.avgMonthlyConsumptionKg,
        ahora,
        { minOrders: params.minOrders, staleDays: params.staleDays },
      );
      if (!estimacion.ok) {
        return {
          userId: ficha.userId,
          cliente: null,
          reason: estimacion.reason,
        };
      }
      const { estimacion: ajustada, aplicado } = aplicarOffset(
        estimacion,
        ajustes.get(ficha.userId) ?? 0,
        params.minOrders,
      );
      return {
        userId: ficha.userId,
        reason: null,
        cliente: {
          customerId: ficha.customerId,
          userId: ficha.userId,
          fullName: ficha.fullName,
          email: ficha.email,
          phoneNumber: ficha.phoneNumber,
          estimate: ajustada,
          offsetDays: aplicado,
          habits: habitosDe(suyas),
          declaredKgPerMonth: ficha.avgMonthlyConsumptionKg,
          noticeDays: ficha.noticeDays ?? params.anticipationDays,
          noticeEnabled: ficha.noticeEnabled,
          ownNoticeDays: ficha.noticeDays,
        },
      };
    });
  }
}
