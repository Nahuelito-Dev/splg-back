import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, And, MoreThanOrEqual, LessThan } from 'typeorm';
import Decimal from 'decimal.js';
import {
  esVentaCobrada,
  soloVentaCobrada,
} from '../common/utils/venta-cobrada';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../order/entities/order.entity';
import { OrderItem } from '../order/entities/order-item.entity';
import {
  diaArgentino,
  truncarEnArgentinaSql,
  ZONA_ARGENTINA,
} from '../common/utils/dias-argentina';
import { EntityPhotoService } from '../s3/entity-photo.service';
import { FleetCostSummaryDto } from '../fleet-expense/dto/fleet-cost.dto';
import { RangoDelInforme } from './rango-del-informe';
import { FleetCostService } from '../fleet-expense/fleet-cost.service';
import { VehicleUtilizationReportDto } from './dto/vehicle-utilization-response.dto';
import { saldoPendienteSql } from '../order/domain/saldo-pendiente';
import {
  mayorVentaPrimero,
  sumar,
  ticketPromedio,
} from './domain/totales-de-ventas';
import {
  ResumenDeVentasDto,
  TotalDelDiaDto,
  TotalesDeVentasDto,
  TotalesPorProductoDto,
} from './dto/report-v2.dto';
import {
  CobrosDeEfectivoDto,
  EvolucionDeVentasDto,
  VentasPorChoferDto,
  VentasPorMedioDePagoDto,
  VentasPorProductoDto,
} from './dto/report-response.dto';

/** Una fila de getRawMany: las claves son las que devuelve Postgres. */
type Fila = Record<string, unknown>;

/** Number() de un valor de fila; NaN sale como null en el JSON. */
function numero(valor: unknown): number {
  return Number(valor);
}

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,
    private readonly fleetCosts: FleetCostService,
    private readonly photos: EntityPhotoService,
  ) {}

  /**
   * Agregado por vehículo. Costos y km salen del tablero de flota (misma
   * fuente); entregas y días en uso, de los pedidos entregados en el rango
   * `[startDate, endDate)` en hora argentina.
   */
  async getVehicleUtilization(
    rango: RangoDelInforme,
    distributorId: string,
    vehicleId?: string,
  ): Promise<VehicleUtilizationReportDto> {
    const visible: FleetCostSummaryDto[] = vehicleId
      ? [
          await this.fleetCosts.costoDelVehiculo(
            vehicleId,
            distributorId,
            rango.from,
            rango.to,
          ),
        ]
      : await this.fleetCosts.tablero(distributorId, rango.from, rango.to);

    const deliveriesQuery = () => {
      const query = this.orderRepository
        .createQueryBuilder('order')
        .where('order.distributorId = :distributorId', { distributorId })
        .andWhere('order.status = :status', { status: OrderStatus.DELIVERED })
        .andWhere('order.vehicleCarId IS NOT NULL')
        .andWhere('order.deliveredAt >= :start AND order.deliveredAt < :end', {
          start: rango.startDate,
          end: rango.endDate,
        });
      if (vehicleId) {
        query.andWhere('order.vehicleCarId = :vehicleId', { vehicleId });
      }
      return query;
    };
    const dayExpression = `DATE(order.deliveredAt AT TIME ZONE '${ZONA_ARGENTINA}')`;
    const deliveries = await deliveriesQuery()
      .select('order.vehicleCarId', 'vehicleId')
      .addSelect('COUNT(*)', 'deliveries')
      .addSelect(`COUNT(DISTINCT ${dayExpression})`, 'daysInUse')
      .groupBy('order.vehicleCarId')
      .getRawMany<{
        vehicleId: string;
        deliveries: string;
        daysInUse: string;
      }>();
    const fleetDays = await deliveriesQuery()
      .select(`COUNT(DISTINCT ${dayExpression})`, 'daysInUse')
      .getRawOne<{ daysInUse: string }>();
    const deliveriesByVehicle = new Map(
      deliveries.map((entry) => [entry.vehicleId, entry]),
    );
    const photos = await this.photosOf(
      visible.map((vehicle) => vehicle.carId),
      distributorId,
    );

    const rows = visible.map((vehicle) => {
      const delivered = deliveriesByVehicle.get(vehicle.carId);
      const km = vehicle.km;
      const deliveries = Number(delivered?.deliveries ?? 0);
      const other = new Decimal(vehicle.fines)
        .plus(vehicle.accidents)
        .toNumber();
      const total = new Decimal(vehicle.total).toNumber();
      return {
        vehicleId: vehicle.carId,
        plate: vehicle.carPatent,
        name: vehicle.carBrand,
        model: vehicle.carModel,
        photo: photos.get(vehicle.carId) ?? null,
        daysInUse: Number(delivered?.daysInUse ?? 0),
        km,
        deliveries,
        insuranceEstimated: vehicle.insuranceEstimated,
        costs: {
          fuel: vehicle.fuel,
          maintenance: vehicle.maintenance,
          insurance: vehicle.insurance,
          other,
          total,
        },
        costPerDelivery:
          deliveries > 0
            ? new Decimal(total).div(deliveries).toDecimalPlaces(2).toNumber()
            : null,
        costPerKm:
          km > 0
            ? new Decimal(total).div(km).toDecimalPlaces(2).toNumber()
            : null,
      };
    });
    const sum = (field: (row: (typeof rows)[number]) => number) =>
      rows.reduce((total, row) => total.plus(field(row)), new Decimal(0));
    const totalKm = sum((row) => row.km);
    const totalDeliveries = sum((row) => row.deliveries);
    const costs = {
      fuel: sum((row) => row.costs.fuel).toNumber(),
      maintenance: sum((row) => row.costs.maintenance).toNumber(),
      insurance: sum((row) => row.costs.insurance).toNumber(),
      other: sum((row) => row.costs.other).toNumber(),
      total: sum((row) => row.costs.total).toNumber(),
    };
    const insuranceEstimated = rows.some((row) => row.insuranceEstimated);
    return {
      rows,
      totals: {
        vehicles: rows.length,
        daysInUse: Number(fleetDays?.daysInUse ?? 0),
        km: totalKm.toNumber(),
        deliveries: totalDeliveries.toNumber(),
        insuranceEstimated,
        costs,
        costPerDelivery: totalDeliveries.gt(0)
          ? new Decimal(costs.total)
              .div(totalDeliveries)
              .toDecimalPlaces(2)
              .toNumber()
          : null,
        costPerKm: totalKm.gt(0)
          ? new Decimal(costs.total).div(totalKm).toDecimalPlaces(2).toNumber()
          : null,
      },
    };
  }

  /** URL firmada de la foto de cada vehículo (nunca la del dueño). */
  private async photosOf(
    carIds: string[],
    distributorId: string,
  ): Promise<Map<string, string>> {
    if (carIds.length === 0) return new Map();
    const keys = await this.orderRepository.manager
      .createQueryBuilder()
      .select('c.car_id', 'carId')
      .addSelect('c.photo_key', 'photoKey')
      .from('car', 'c')
      .where('c.distributor_id = :distributorId', { distributorId })
      .andWhere('c.car_id IN (:...carIds)', { carIds })
      .andWhere('c.photo_key IS NOT NULL')
      .getRawMany<{ carId: string; photoKey: string }>();
    const withPhoto: Array<{
      carId: string;
      photoKey: string;
      photoSignedUrl?: string | null;
    }> = keys;
    await this.photos.firmar(withPhoto, (item) => item.photoKey);
    return new Map(
      withPhoto.flatMap((item) =>
        item.photoSignedUrl ? [[item.carId, item.photoSignedUrl] as const] : [],
      ),
    );
  }

  /**
   * Los rangos son `[startDate, endDate)`: el controlador los arma desde días
   * en hora argentina con `to` inclusivo (ver `rangoDeDiasArgentinos`).
   *
   * `distributorId` opcional: si viene (admin de distribuidora), acota el
   * reporte a SUS pedidos. `null`/`undefined` (super_admin sin header) →
   * sin filtro, ve todas las distribuidoras.
   */
  async getSalesByDriver(
    startDate: Date,
    endDate: Date,
    distributorId?: string | null,
  ): Promise<VentasPorChoferDto[]> {
    const orders = await this.orderRepository.find({
      where: {
        status: OrderStatus.DELIVERED,
        deliveredAt: And(MoreThanOrEqual(startDate), LessThan(endDate)),
        ...(distributorId ? { distributorId } : {}),
      },
      // Historial: el chofer, el cliente o la dirección dados de baja siguen
      // apareciendo en lo que ya pasó (H-74).
      withDeleted: true,
      relations: ['delivery', 'delivery.user'],
    });

    const report: Record<
      string,
      {
        driverId: string;
        driverName: string | undefined;
        totalOrders: number;
        totalSales: Decimal;
      }
    > = {};

    for (const order of orders) {
      if (!esVentaCobrada(order)) continue;
      if (!order.delivery || !order.delivery.user) continue;

      const driverName = order.delivery.user.fullName;
      const driverId = order.delivery.userId; // Using user_id as key

      if (!report[driverId]) {
        report[driverId] = {
          driverId,
          driverName,
          totalOrders: 0,
          totalSales: new Decimal(0),
        };
      }

      report[driverId].totalOrders++;
      report[driverId].totalSales = report[driverId].totalSales.plus(
        order.totalAmount,
      );
    }

    // Los Decimal se convierten a número para el JSON.
    return Object.values(report).map((entry) => ({
      ...entry,
      totalSales: entry.totalSales.toNumber(),
    }));
  }

  async getSalesByProduct(
    startDate: Date,
    endDate: Date,
    distributorId?: string | null,
  ): Promise<VentasPorProductoDto[]> {
    // We need to query order items for delivered orders in the range
    const query = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.items', 'item')
      .innerJoinAndSelect('item.gasCylinder', 'product')
      .where('order.status = :status', { status: OrderStatus.DELIVERED })
      .andWhere('order.deliveredAt >= :start AND order.deliveredAt < :end', {
        start: startDate,
        end: endDate,
      });

    soloVentaCobrada(query, 'order');

    // Sólo filtramos por tenant si vino distributorId (super_admin ve todo).
    if (distributorId) {
      query.andWhere('order.distributorId = :distributorId', {
        distributorId,
      });
    }

    // select(expresión, alias) entrecomilla el alias: sin eso Postgres lo pasa
    // a minúsculas y productType, totalQuantity y totalSales llegaban vacíos
    // (H-56).
    const result = await query
      .select('product.type', 'productType')
      .addSelect('product.description', 'description')
      .addSelect('SUM(item.quantity)', 'totalQuantity')
      .addSelect('SUM(item.subtotal)', 'totalSales')
      .groupBy('product.type')
      .addGroupBy('product.description')
      .getRawMany<Fila>();

    return result.map((row) => ({
      productType: String(row['productType']),
      description: (row['description'] as string | undefined) ?? null,
      totalQuantity: numero(row['totalQuantity']),
      totalSales: numero(row['totalSales']),
    }));
  }

  async getSalesByPaymentMethod(
    startDate: Date,
    endDate: Date,
    distributorId?: string | null,
  ): Promise<VentasPorMedioDePagoDto[]> {
    const query = this.orderRepository
      .createQueryBuilder('order')
      .select('order.paymentMethod', 'method')
      .addSelect('COUNT(order.orderId)', 'count')
      .addSelect('SUM(order.totalAmount)', 'total')
      .where('order.status = :status', { status: OrderStatus.DELIVERED })
      .andWhere('order.deliveredAt >= :start AND order.deliveredAt < :end', {
        start: startDate,
        end: endDate,
      });

    soloVentaCobrada(query, 'order');

    if (distributorId) {
      query.andWhere('order.distributorId = :distributorId', {
        distributorId,
      });
    }

    const result = await query
      .groupBy('order.paymentMethod')
      .getRawMany<Fila>();

    return result.map((row) => ({
      method: String(row['method']),
      totalOrders: numero(row['count']),
      totalSales: numero(row['total']),
    }));
  }

  /**
   * Evolución temporal de ventas (pedidos entregados) agrupada por día,
   * semana o mes, usando `date_trunc` de Postgres sobre `deliveredAt` en hora argentina.
   * Devuelve los períodos ordenados cronológicamente, listos para un
   * gráfico de líneas/barras en el panel.
   *
   * `week` usa semanas ISO 8601 (arrancan el lunes): es el mismo criterio
   * que `date_trunc('week', ...)` aplica nativamente, así que no hace falta
   * ningún cálculo propio (H-57: antes se aceptaba y se trataba como 'day').
   */
  async getSalesEvolution(
    startDate: Date,
    endDate: Date,
    granularity: 'day' | 'week' | 'month',
    distributorId?: string | null,
  ): Promise<EvolucionDeVentasDto[]> {
    const query = this.orderRepository
      .createQueryBuilder('order')
      .select(truncarEnArgentinaSql(granularity, 'order.deliveredAt'), 'period')
      .addSelect('COUNT(order.orderId)', 'count')
      .addSelect('SUM(order.totalAmount)', 'total')
      .where('order.status = :status', { status: OrderStatus.DELIVERED })
      .andWhere('order.deliveredAt >= :start AND order.deliveredAt < :end', {
        start: startDate,
        end: endDate,
      });

    soloVentaCobrada(query, 'order');

    if (distributorId) {
      query.andWhere('order.distributorId = :distributorId', {
        distributorId,
      });
    }

    const result = await query
      .groupBy('period')
      .orderBy('period', 'ASC')
      .getRawMany<Fila>();

    return result.map((row) => ({
      period: row['period'] as Date,
      totalOrders: numero(row['count']),
      totalSales: numero(row['total']),
    }));
  }

  /**
   * Cifras aparte de las ventas: el efectivo entregado que el chofer todavía
   * no confirmó, los impagos y lo dado por perdido, de los pedidos entregados
   * en el rango. No suman a las ventas.
   */
  async getCollections(
    startDate: Date,
    endDate: Date,
    distributorId?: string | null,
  ): Promise<CobrosDeEfectivoDto> {
    const query = this.orderRepository
      .createQueryBuilder('order')
      .select('order.paymentMethod', 'method')
      .addSelect('order.paymentStatus', 'status')
      .addSelect('COUNT(order.orderId)', 'count')
      .addSelect('SUM(order.totalAmount)', 'total')
      .addSelect(`SUM(${saldoPendienteSql('order')})`, 'balance')
      .where('order.status = :status', { status: OrderStatus.DELIVERED })
      .andWhere('order.deliveredAt >= :start AND order.deliveredAt < :end', {
        start: startDate,
        end: endDate,
      })
      .andWhere(
        '((order.paymentMethod = :cash AND order.paymentStatus IN (:...estadosCash)) ' +
          'OR (order.paymentMethod = :transfer AND order.paymentStatus IN (:...estadosTransfer)))',
        {
          cash: PaymentMethod.CASH,
          estadosCash: [
            PaymentStatus.PENDING,
            PaymentStatus.UNPAID,
            PaymentStatus.WRITTEN_OFF,
          ],
          transfer: PaymentMethod.TRANSFER,
          estadosTransfer: [PaymentStatus.PENDING, PaymentStatus.FAILED],
        },
      );

    if (distributorId) {
      query.andWhere('order.distributorId = :distributorId', {
        distributorId,
      });
    }

    const rows = await query
      .groupBy('order.paymentMethod')
      .addGroupBy('order.paymentStatus')
      .getRawMany<Fila>();
    // `campo`: 'total' (el total del pedido) o 'balance' (lo que falta cobrar,
    // sin la seña ya paga: es lo adeudado en un impago).
    const cifra = (
      metodo: PaymentMethod,
      estado: PaymentStatus,
      campo: 'total' | 'balance' = 'total',
    ) => {
      const fila = rows.find(
        (r) => r['method'] === metodo && r['status'] === estado,
      );
      return {
        totalOrders: fila ? numero(fila['count']) : 0,
        totalAmount: fila ? numero(fila[campo]) : 0,
      };
    };
    // Pedidos cobrados (online o transferencia) y después cancelados: el dinero
    // sigue en la distribuidora y hay que devolverlo. Dato informativo: el
    // sistema no gestiona el reintegro.
    // Se ubica por el día en que se canceló (la última transición a `cancelled`
    // del historial), no por `updatedAt`: cualquier edición posterior movería el
    // pedido de rango. Un pedido cancelado antes de que existiera el historial
    // no tiene la fila y cae a `updatedAt`. Es una subconsulta por pedido (usa
    // el índice parcial `IDX_order_status_history_cancelacion`) y no un
    // agregado de todo el historial.
    const cancelacion =
      '(SELECT MAX(h.changed_at) FROM order_status_history h ' +
      'WHERE h.order_id = order.orderId AND h.to_status = :cancelada)';
    const reintegros = this.orderRepository
      .createQueryBuilder('order')
      .select('COUNT(order.orderId)', 'count')
      .addSelect('SUM(order.totalAmount)', 'total')
      .where('order.status = :cancelado', { cancelado: OrderStatus.CANCELLED })
      .andWhere('order.paymentStatus = :pagado', {
        pagado: PaymentStatus.PAID,
      })
      .andWhere(
        `COALESCE(${cancelacion}, order.updatedAt) >= :start AND ` +
          `COALESCE(${cancelacion}, order.updatedAt) < :end`,
        {
          start: startDate,
          end: endDate,
          cancelada: OrderStatus.CANCELLED,
        },
      );
    if (distributorId) {
      reintegros.andWhere('order.distributorId = :distributorId', {
        distributorId,
      });
    }
    const [filaReintegro] = await reintegros.getRawMany<Fila>();
    return {
      pendingRefund: {
        totalOrders: filaReintegro ? numero(filaReintegro['count']) : 0,
        totalAmount: filaReintegro ? numero(filaReintegro['total']) : 0,
      },
      pendingCash: cifra(PaymentMethod.CASH, PaymentStatus.PENDING),
      unpaid: cifra(PaymentMethod.CASH, PaymentStatus.UNPAID, 'balance'),
      writtenOff: cifra(PaymentMethod.CASH, PaymentStatus.WRITTEN_OFF),
      pendingTransfer: cifra(PaymentMethod.TRANSFER, PaymentStatus.PENDING),
      notReceivedTransfer: cifra(PaymentMethod.TRANSFER, PaymentStatus.FAILED),
    };
  }

  /** Las filas de mayor a menor venta y sus totales, sumados acá y no en el panel. */
  totalesDeVentas(
    filas: { totalOrders: number; totalSales: number }[],
  ): TotalesDeVentasDto {
    return {
      totalOrders: filas.reduce((n, f) => n + f.totalOrders, 0),
      totalSales: sumar(filas.map((f) => f.totalSales)),
    };
  }

  async getSalesByDriverConTotales(
    startDate: Date,
    endDate: Date,
    distributorId?: string | null,
  ) {
    const filas = mayorVentaPrimero(
      await this.getSalesByDriver(startDate, endDate, distributorId),
      (f) => `${f.driverName ?? ''}|${f.driverId}`,
    );
    return { rows: filas, totals: this.totalesDeVentas(filas) };
  }

  async getSalesByPaymentMethodConTotales(
    startDate: Date,
    endDate: Date,
    distributorId?: string | null,
  ) {
    const filas = mayorVentaPrimero(
      await this.getSalesByPaymentMethod(startDate, endDate, distributorId),
      (f) => f.method,
    );
    return { rows: filas, totals: this.totalesDeVentas(filas) };
  }

  async getSalesByProductConTotales(
    startDate: Date,
    endDate: Date,
    distributorId?: string | null,
  ) {
    const filas = mayorVentaPrimero(
      await this.getSalesByProduct(startDate, endDate, distributorId),
      (f) => `${f.productType}|${f.description ?? ''}`,
    );
    const totals: TotalesPorProductoDto = {
      totalQuantity: filas.reduce((n, f) => n + f.totalQuantity, 0),
      totalSales: sumar(filas.map((f) => f.totalSales)),
    };
    return { rows: filas, totals };
  }

  /** Ventas cobradas, pedidos y ticket promedio de un rango. */
  async getSalesSummary(
    startDate: Date,
    endDate: Date,
    distributorId?: string | null,
  ): Promise<ResumenDeVentasDto> {
    const query = this.orderRepository
      .createQueryBuilder('order')
      .select('COUNT(order.orderId)', 'count')
      .addSelect('COALESCE(SUM(order.totalAmount), 0)', 'total')
      .where('order.status = :status', { status: OrderStatus.DELIVERED })
      .andWhere('order.deliveredAt >= :start AND order.deliveredAt < :end', {
        start: startDate,
        end: endDate,
      });
    soloVentaCobrada(query, 'order');
    if (distributorId) {
      query.andWhere('order.distributorId = :distributorId', {
        distributorId,
      });
    }
    const [fila] = await query.getRawMany<Fila>();
    const totalOrders = fila ? numero(fila['count']) : 0;
    const totalSales = fila ? sumar([numero(fila['total'])]) : 0;
    return {
      totalSales,
      totalOrders,
      averageTicket: ticketPromedio(totalSales, totalOrders),
    };
  }

  /**
   * Lo adeudado en cobros impagos: los pedidos con `paymentStatus: unpaid` de
   * la distribuidora, sin acotar por fecha (los mismos que lista `GET /orders`
   * con ese filtro).
   */
  async getUnpaidTotal(
    distributorId?: string | null,
  ): Promise<{ totalOrders: number; totalAmount: number }> {
    const query = this.orderRepository
      .createQueryBuilder('order')
      .withDeleted()
      .select('COUNT(order.orderId)', 'count')
      .addSelect(`COALESCE(SUM(${saldoPendienteSql('order')}), 0)`, 'total')
      .where('order.paymentStatus = :unpaid', {
        unpaid: PaymentStatus.UNPAID,
      });
    if (distributorId) {
      query.andWhere('order.distributorId = :distributorId', {
        distributorId,
      });
    }
    const [fila] = await query.getRawMany<Fila>();
    return {
      totalOrders: fila ? numero(fila['count']) : 0,
      totalAmount: fila ? sumar([numero(fila['total'])]) : 0,
    };
  }

  /**
   * Lo entregado por un chofer, día por día (hora argentina): pedidos y lo que
   * había que cobrar de ellos (total menos la seña ya paga, igual que
   * `remainingBalance` del pedido). Sólo días con entregas, del más reciente
   * al más antiguo.
   */
  async getDriverDailyTotals(
    driverUserId: string,
    startDate: Date,
    endDate: Date,
    distributorId: string,
  ): Promise<TotalDelDiaDto[]> {
    const dia = truncarEnArgentinaSql('day', 'order.deliveredAt');
    const filas = await this.orderRepository
      .createQueryBuilder('order')
      .innerJoin('order.delivery', 'delivery')
      .select(dia, 'period')
      .addSelect('COUNT(order.orderId)', 'count')
      .addSelect(`COALESCE(SUM(${saldoPendienteSql('order')}), 0)`, 'total')
      .where('order.status = :status', { status: OrderStatus.DELIVERED })
      .andWhere('delivery.userId = :driverUserId', { driverUserId })
      .andWhere('order.distributorId = :distributorId', { distributorId })
      .andWhere('order.deliveredAt >= :start AND order.deliveredAt < :end', {
        start: startDate,
        end: endDate,
      })
      .groupBy('period')
      .orderBy('period', 'DESC')
      .getRawMany<Fila>();
    return filas.map((f) => ({
      day: diaArgentino(f['period'] as Date),
      deliveredOrders: numero(f['count']),
      totalAmount: sumar([numero(f['total'])]),
    }));
  }
}
