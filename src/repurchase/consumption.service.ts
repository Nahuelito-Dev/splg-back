import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CustomersService } from '../customer/customer.service';
import type { ConsumoDeclarado } from '../customer/customer.service';
import { Customer } from '../customer/entities/customer.entity';
import { GasCylinder } from '../gascylinder/entities/gascylinder.entity';
import { GasCylinderService } from '../gascylinder/gascylinder.service';
import { OrderLookupService } from '../order/lookup/order-lookup.service';
import {
  CONSUMO_MAXIMO_KG_MES,
  CONSUMO_MINIMO_KG_MES,
  consumoEnRango,
  estimarProximaRecompra,
  kilosPorMes,
} from './domain/consumption';

/** Lo que el cliente declara: garrafas por mes de un tipo. */
export interface DeclaracionDeConsumo {
  cylinderTypeId?: string;
  quantityPerMonth?: number;
  confirmOutOfRange?: boolean;
}

/**
 * Consumo promedio declarado y estimación de la próxima recompra (CU-143 y
 * CU-144). El módulo depende de `customer` y de la lectura de pedidos, y
 * `order` no depende de él: no hay ciclo. `CustomersService` es dueño de los
 * campos y los persiste.
 */
@Injectable()
export class ConsumptionService {
  constructor(
    private readonly customers: CustomersService,
    private readonly catalogo: GasCylinderService,
    private readonly pedidos: OrderLookupService,
  ) {}

  /**
   * CU-143. Valida y calcula la declaración del registro SIN guardar: el alta
   * la persiste en la transacción de la ficha. Todavía no hay compras, así que
   * la estimación supone como inicio `ahora` con la garrafa habitual llena.
   * Con el valor fuera de rango pide confirmación (400) salvo
   * `confirmOutOfRange`.
   */
  async calcularDeclaracion(
    declaracion: DeclaracionDeConsumo & {
      cylinderTypeId: string;
      quantityPerMonth: number;
    },
    ahora: Date = new Date(),
  ): Promise<ConsumoDeclarado> {
    const garrafa = await this.garrafaHabitual(declaracion.cylinderTypeId);
    const kgPorMes = this.kilosValidados(garrafa, declaracion);
    return {
      declaredCylinderTypeId: garrafa.gasCylinderId,
      avgMonthlyConsumptionKg: kgPorMes,
      nextRepurchaseEstimateAt: estimarProximaRecompra(
        ahora,
        garrafa.weight,
        kgPorMes,
      ),
    };
  }

  /**
   * CU-144. Corrige el consumo y recalcula la estimación desde la última
   * compra entregada; si nunca compró, desde ahora. `distributorId`, si hay
   * una en contexto, acota el catálogo del que se elige la garrafa.
   */
  async actualizar(
    userId: string,
    declaracion: DeclaracionDeConsumo,
    distributorId?: string | null,
    ahora: Date = new Date(),
  ): Promise<Customer> {
    const actual = await this.customers.findOneByUserId(userId);
    const cylinderTypeId =
      declaracion.cylinderTypeId ?? actual.declaredCylinderTypeId;
    if (!cylinderTypeId) {
      throw new BadRequestException(
        'Indicá el tipo de garrafa habitual (cylinderTypeId): todavía no declaraste uno',
      );
    }
    const garrafa = await this.garrafaHabitual(
      cylinderTypeId,
      declaracion.cylinderTypeId ? distributorId : null,
    );
    const kgPorMes = this.kilosDeActualizacion(actual, garrafa, declaracion);

    const ultima = await this.pedidos.ultimaCompraEntregada(userId);
    const estimada = ultima
      ? estimarProximaRecompra(ultima.deliveredAt, ultima.kg, kgPorMes)
      : estimarProximaRecompra(ahora, garrafa.weight, kgPorMes);

    return this.customers.guardarConsumo(userId, {
      declaredCylinderTypeId: garrafa.gasCylinderId,
      avgMonthlyConsumptionKg: kgPorMes,
      nextRepurchaseEstimateAt: estimada,
    });
  }

  /** La ficha del cliente con su consumo declarado. */
  obtener(userId: string): Promise<Customer> {
    return this.customers.findOneByUserId(userId);
  }

  /**
   * Los kg por mes de la corrección: con `quantityPerMonth`, la conversión de
   * siempre (validada); sin él, sólo se cambió la garrafa y se mantiene el
   * consumo ya declarado en kg.
   */
  private kilosDeActualizacion(
    actual: Customer,
    garrafa: GasCylinder,
    declaracion: DeclaracionDeConsumo,
  ): number {
    if (declaracion.quantityPerMonth !== undefined) {
      return this.kilosValidados(garrafa, {
        ...declaracion,
        quantityPerMonth: declaracion.quantityPerMonth,
      });
    }
    if (
      !declaracion.cylinderTypeId ||
      actual.avgMonthlyConsumptionKg === null
    ) {
      throw new BadRequestException(
        'Indicá quantityPerMonth (garrafas por mes); sólo con cylinderTypeId se puede cambiar la garrafa de quien ya declaró su consumo',
      );
    }
    return actual.avgMonthlyConsumptionKg;
  }

  private async garrafaHabitual(
    id: string,
    distributorId?: string | null,
  ): Promise<GasCylinder> {
    try {
      const garrafa = await this.catalogo.findOne(id, distributorId);
      if (garrafa.isActive) return garrafa;
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
    }
    throw new BadRequestException(
      'El tipo de garrafa no existe o está dado de baja',
    );
  }

  private kilosValidados(
    garrafa: GasCylinder,
    declaracion: DeclaracionDeConsumo & { quantityPerMonth: number },
  ): number {
    const kgPorMes = kilosPorMes(garrafa.weight, declaracion.quantityPerMonth);
    // Ni con confirmación se acepta un consumo nulo o negativo: no es un
    // consumo "fuera de rango", es inválido (y rompería la estimación).
    if (kgPorMes <= 0) {
      throw new BadRequestException(
        'El consumo declarado tiene que ser mayor que cero',
      );
    }
    if (!consumoEnRango(kgPorMes) && !declaracion.confirmOutOfRange) {
      throw new BadRequestException(
        `El consumo declarado (${kgPorMes} kg por mes) está fuera del rango razonable ` +
          `(${CONSUMO_MINIMO_KG_MES} a ${CONSUMO_MAXIMO_KG_MES} kg por mes): ` +
          'confirmalo enviando confirmOutOfRange: true',
      );
    }
    return kgPorMes;
  }
}
