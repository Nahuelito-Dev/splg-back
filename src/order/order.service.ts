import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual, Between } from 'typeorm';
import { Order, OrderStatus, PaymentMethod } from './entities/order.entity';
import { transitionOrder } from './domain/order-status.machine';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { OrderMapper } from './order.mapper';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { Delivery } from '../delivery/entities/delivery.entity';
import { RoleType } from '../common/constants/role-type.enum';
import { RealtimeDispatchPort } from './domain/ports/realtime-dispatch.port';
import { OrderRepositoryPort } from './domain/ports/order.repository.port';
import { CreateOrderUseCase } from './application/create-order.use-case';
import { UpdateOrderStatusUseCase } from './application/update-order-status.use-case';
import { CancelOrderUseCase } from './application/cancel-order.use-case';
import { ConfirmDeliveryUseCase } from './application/confirm-delivery.use-case';
import { DispatchOrchestratorService } from './application/dispatch-orchestrator.service';

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,

    @InjectRepository(Delivery)
    private readonly deliveryRepository: Repository<Delivery>,

    // Despacho/tiempo real detrás de un puerto: el service no conoce Redis ni
    // Socket.io (los implementa RealtimeDispatchAdapter en infraestructura).
    private readonly dispatch: RealtimeDispatchPort,
    // Persistencia detrás de un puerto (adapter TypeORM en infraestructura).
    private readonly orders: OrderRepositoryPort,
    // Casos de uso (application layer): el service es la fachada del módulo y
    // delega en ellos la lógica de cada operación de escritura del pedido.
    private readonly createOrderUseCase: CreateOrderUseCase,
    private readonly updateOrderStatusUseCase: UpdateOrderStatusUseCase,
    private readonly cancelOrderUseCase: CancelOrderUseCase,
    private readonly confirmDeliveryUseCase: ConfirmDeliveryUseCase,
    // Orquestador de despacho: para el rechazo explícito de una oferta (CU-016),
    // que cierra la oferta del chofer y re-ofrece al siguiente de inmediato (en
    // vez de esperar a que expire por timeout).
    private readonly dispatchOrchestrator: DispatchOrchestratorService,
  ) {}

  /**
   * CU-016: el chofer rechaza/ignora una oferta de pedido. Cierra su oferta
   * activa como REJECTED y re-ofrece el pedido al siguiente chofer más cercano
   * de inmediato. Best-effort: si el pedido ya no es re-ofertable (lo tomó otro,
   * se canceló), es un no-op silencioso.
   */
  async rejectOffer(orderId: string, driverId: string) {
    const order = await this.orders.findByIdFull(orderId);
    if (!order) return { rejected: false };
    await this.dispatchOrchestrator.onDriverRejected(order, driverId);
    return { rejected: true };
  }

  /**
   * Crear pedido. Delega en CreateOrderUseCase (application layer). OrderService
   * queda como fachada del módulo; el flujo transaccional vive en el use-case.
   */
  async create(createOrderDto: CreateOrderDto, distributorId?: string | null) {
    return this.createOrderUseCase.execute(createOrderDto, distributorId);
  }

  async findAll(paginationDto: PaginationDto, distributorId?: string | null) {
    const { limit = 10, offset = 0 } = paginationDto;
    return this.orders.findAllPaginated(limit, offset, distributorId);
  }

  async findOne(id: string) {
    // Delega en el puerto de repositorio. Devuelve la entidad (uso interno por
    // updateStatus/cancel); getOne() mapea a DTO para el controller.
    const order = await this.orders.findByIdFull(id);
    if (!order) throw new NotFoundException(`Order with ID: ${id} not found`);
    return order;
  }

  async getOne(
    id: string,
    distributorId?: string | null,
  ): Promise<OrderResponseDto> {
    const order = await this.findOne(id);
    // Aislamiento: si hay tenant en contexto (staff, o customer con empresa
    // elegida), el pedido debe ser de esa distribuidora. Evita leer por PK un
    // pedido de otra empresa (IDOR cross-tenant).
    if (
      distributorId &&
      order.distributor_id &&
      order.distributor_id !== distributorId
    ) {
      throw new NotFoundException(`Order with ID: ${id} not found`);
    }
    return OrderMapper.toDto(order);
  }

  async findAvailableOrders(
    paginationDto: PaginationDto,
    distributorId?: string | null,
  ) {
    const { limit = 10, offset = 0 } = paginationDto;
    return this.orders.findAvailable(limit, offset, distributorId);
  }

  async findByCustomer(
    customerId: string,
    paginationDto: PaginationDto,
    distributorId?: string | null,
  ) {
    const { limit = 10, offset = 0 } = paginationDto;
    return this.orders.findByCustomer(customerId, limit, offset, distributorId);
  }

  async findByDelivery(
    deliveryId: string,
    paginationDto: PaginationDto,
    distributorId?: string | null,
  ) {
    const { limit = 10, offset = 0 } = paginationDto;
    return this.orders.findByDelivery(deliveryId, limit, offset, distributorId);
  }

  /**
   * Avanza el estado de un pedido. Delega en UpdateOrderStatusUseCase
   * (validación de transición + efectos de estado + side-effects de tiempo real).
   */
  async updateStatus(id: string, status: OrderStatus, deliveryId?: string) {
    return this.updateOrderStatusUseCase.execute(id, status, deliveryId);
  }

  /**
   * Devuelve el código secreto de la prueba de entrega con QR, para que el
   * chofer lo renderice en su app. Ownership: un chofer solo puede ver el
   * código de un pedido asignado a ÉL MISMO; admin puede ver cualquiera.
   */
  async getDeliveryCode(orderId: string, userId: string, role: RoleType) {
    const order = await this.findOne(orderId);

    if (role === RoleType.DELIVERY) {
      const delivery = await this.deliveryRepository.findOne({
        where: { user_id: userId },
      });
      if (!delivery || order.delivery_id !== delivery.delivery_id) {
        throw new ForbiddenException(
          'Este pedido no está asignado a tu usuario',
        );
      }
    }

    if (!order.deliveryCode) {
      throw new BadRequestException(
        'El pedido todavía no tiene código de entrega (debe estar aceptado)',
      );
    }

    return { orderId: order.order_id, deliveryCode: order.deliveryCode };
  }

  /**
   * Confirma la entrega (el cliente escanea el QR del chofer). Delega en
   * ConfirmDeliveryUseCase: valida ownership + código secreto y dispara la
   * transición ON_THE_WAY → DELIVERED reutilizando UpdateOrderStatusUseCase.
   */
  async confirmDelivery(
    orderId: string,
    code: string,
    userId: string,
    role: RoleType,
  ) {
    return this.confirmDeliveryUseCase.execute(orderId, code, userId, role);
  }

  async assignDelivery(orderId: string, deliveryId: string) {
    const order = await this.findOne(orderId);
    const delivery = await this.deliveryRepository.findOne({
      where: { delivery_id: deliveryId },
    });
    if (!delivery) throw new NotFoundException('Repartidor no encontrado');
    if (!delivery.isActive)
      throw new BadRequestException('El repartidor no está activo');
    order.delivery_id = deliveryId;
    transitionOrder(order, OrderStatus.ACCEPTED);
    order.acceptedAt = new Date();
    await this.orderRepository.save(order);
    return order;
  }

  async updateLocation(id: string, lat: string, lng: string) {
    const order = await this.findOne(id);
    order.deliveryLatitude = lat;
    order.deliveryLongitude = lng;
    await this.orderRepository.save(order);
    return order;
  }

  /**
   * KPIs del dashboard. Scopeado por distribuidora (un admin de empresa solo ve
   * lo suyo; super_admin sin tenant ve el consolidado). Usa agregados SQL
   * (SUM/COUNT) en vez de cargar las órdenes a memoria.
   */
  async getOrderStats(distributorId?: string | null) {
    const dist = distributorId ? { distributor_id: distributorId } : {};

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);

    const delivered = (from: Date, to: Date) => ({
      status: OrderStatus.DELIVERED,
      deliveredAt: Between(from, to),
      ...dist,
    });

    const [
      todaySales,
      weekSales,
      monthSales,
      totalSales,
      deliveredToday,
      pending,
      accepted,
      onTheWay,
      activeDeliveries,
      cash,
      mercadopago,
    ] = await Promise.all([
      this.orderRepository.sum('totalAmount', delivered(today, tomorrow)),
      this.orderRepository.sum('totalAmount', delivered(weekStart, weekEnd)),
      this.orderRepository.sum('totalAmount', delivered(monthStart, monthEnd)),
      this.orderRepository.sum('totalAmount', {
        status: OrderStatus.DELIVERED,
        ...dist,
      }),
      this.orderRepository.count({ where: delivered(today, tomorrow) }),
      this.orderRepository.count({ where: { status: OrderStatus.PENDING, ...dist } }),
      this.orderRepository.count({ where: { status: OrderStatus.ACCEPTED, ...dist } }),
      this.orderRepository.count({ where: { status: OrderStatus.ON_THE_WAY, ...dist } }),
      this.deliveryRepository.count({
        where: { isActive: true, validated: true, ...dist },
      }),
      this.orderRepository.count({
        where: {
          status: OrderStatus.DELIVERED,
          paymentMethod: PaymentMethod.CASH,
          deliveredAt: MoreThanOrEqual(monthStart),
          ...dist,
        },
      }),
      this.orderRepository.count({
        where: {
          status: OrderStatus.DELIVERED,
          paymentMethod: PaymentMethod.MERCADOPAGO,
          deliveredAt: MoreThanOrEqual(monthStart),
          ...dist,
        },
      }),
    ]);

    const todaySalesN = todaySales ?? 0;

    return {
      ordersSummary: {
        pending,
        accepted,
        onTheWay,
        deliveredToday,
      },
      sales: {
        today: todaySalesN,
        week: weekSales ?? 0,
        month: monthSales ?? 0,
        total: totalSales ?? 0,
      },
      performance: {
        activeDeliveries,
        avgOrderValue: deliveredToday > 0 ? todaySalesN / deliveredToday : 0,
        ordersPerDay: deliveredToday,
      },
      paymentMethods: { cash, mercadopago },
    };
  }

  /**
   * Cancela (customer/admin) o libera a PENDING (driver) un pedido. Delega en
   * CancelOrderUseCase (política por actor + restitución de stock + avisos).
   */
  async cancelOrder(
    orderId: string,
    userId: string,
    role: 'customer' | 'driver' | 'admin' | 'superadmin',
    reason?: string,
  ) {
    return this.cancelOrderUseCase.execute(orderId, userId, role, reason);
  }

  async notifyDriverArrived(orderId: string) {
    const order = await this.findOne(orderId);

    if (order.status !== OrderStatus.ON_THE_WAY) {
      throw new BadRequestException(
        'El pedido debe estar en camino para avisar llegada',
      );
    }

    this.dispatch.notifyCustomer(order.customer_id, 'order:arrived', {
      orderId: order.order_id,
      message: '👋 ¡El repartidor está afuera!',
      driverName: order.delivery?.user?.full_name || 'El repartidor',
    });

    return { message: 'Cliente notificado' };
  }

  /**
   * Ventas de los últimos 7 días para el gráfico del dashboard. Scopeado por
   * distribuidora, en UNA sola query agregada (date_trunc + GROUP BY) en vez de
   * 7 queries secuenciales.
   */
  async getSalesChartData(distributorId?: string | null) {
    const start = new Date();
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const qb = this.orderRepository
      .createQueryBuilder('order')
      .select(`date_trunc('day', order.deliveredAt)`, 'day')
      .addSelect('SUM(order.totalAmount)', 'total')
      .where('order.status = :status', { status: OrderStatus.DELIVERED })
      .andWhere('order.deliveredAt BETWEEN :start AND :end', { start, end });

    if (distributorId) {
      qb.andWhere('order.distributor_id = :distributorId', { distributorId });
    }

    const rows = await qb.groupBy('day').getRawMany();

    // Mapa día(YYYY-MM-DD) → total, para rellenar los días sin ventas con 0.
    const byDay = new Map<string, number>();
    for (const r of rows) {
      const key = new Date(r.day).toISOString().split('T')[0];
      byDay.set(key, Number(r.total) || 0);
    }

    const chartData: { name: string; date: string; sales: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const key = d.toISOString().split('T')[0];
      const dayName = d.toLocaleDateString('es-ES', { weekday: 'short' });
      chartData.push({
        name: dayName.charAt(0).toUpperCase() + dayName.slice(1),
        date: key,
        sales: byDay.get(key) ?? 0,
      });
    }

    return chartData;
  }
}

