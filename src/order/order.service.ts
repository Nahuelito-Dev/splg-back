import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual, Between } from 'typeorm';
import { Order, OrderStatus, PaymentMethod } from './entities/order.entity';
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
  ) {}

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
    order.status = OrderStatus.ACCEPTED;
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

  async getOrderStats() {
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

    const todayOrders = await this.orderRepository.find({
      where: {
        status: OrderStatus.DELIVERED,
        deliveredAt: Between(today, tomorrow),
      },
    });

    const weekOrders = await this.orderRepository.find({
      where: {
        status: OrderStatus.DELIVERED,
        deliveredAt: Between(weekStart, weekEnd),
      },
    });

    const monthOrders = await this.orderRepository.find({
      where: {
        status: OrderStatus.DELIVERED,
        deliveredAt: Between(monthStart, monthEnd),
      },
    });

    const todaySales = todayOrders.reduce(
      (sum, order) => sum + order.totalAmount,
      0,
    );
    const weekSales = weekOrders.reduce(
      (sum, order) => sum + order.totalAmount,
      0,
    );
    const monthSales = monthOrders.reduce(
      (sum, order) => sum + order.totalAmount,
      0,
    );

    const totalSalesResult = await this.orderRepository
      .createQueryBuilder('order')
      .select('SUM(order.totalAmount)', 'total')
      .where('order.status = :status', { status: OrderStatus.DELIVERED })
      .getRawOne();

    const pendingOrders = await this.orderRepository.count({
      where: { status: OrderStatus.PENDING },
    });

    const acceptedOrders = await this.orderRepository.count({
      where: { status: OrderStatus.ACCEPTED },
    });

    const onTheWayOrders = await this.orderRepository.count({
      where: { status: OrderStatus.ON_THE_WAY },
    });

    const activeDeliveries = await this.deliveryRepository.count({
      where: { isActive: true, validated: true },
    });

    return {
      ordersSummary: {
        pending: pendingOrders,
        accepted: acceptedOrders,
        onTheWay: onTheWayOrders,
        deliveredToday: todayOrders.length,
      },
      sales: {
        today: todaySales,
        week: weekSales,
        month: monthSales,
        total: parseFloat(totalSalesResult?.total || '0'),
      },
      performance: {
        activeDeliveries: activeDeliveries,
        avgOrderValue:
          todayOrders.length > 0 ? todaySales / todayOrders.length : 0,
        ordersPerDay: todayOrders.length,
      },
      paymentMethods: {
        cash: await this.orderRepository.count({
          where: {
            status: OrderStatus.DELIVERED,
            paymentMethod: PaymentMethod.CASH,
            deliveredAt: MoreThanOrEqual(monthStart),
          },
        }),
        mercadopago: await this.orderRepository.count({
          where: {
            status: OrderStatus.DELIVERED,
            paymentMethod: PaymentMethod.MERCADOPAGO,
            deliveredAt: MoreThanOrEqual(monthStart),
          },
        }),
      },
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

  async getSalesChartData() {
    // CORRECCIÓN 1: Tipar el array de fechas explícitamente
    const days: Date[] = [];

    // Generar últimos 7 días
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d); // Ahora funciona porque sabe que es Date[]
    }

    // CORRECCIÓN 2: Tipar la estructura del objeto de salida
    const chartData: { name: string; date: string; sales: number }[] = [];

    for (const date of days) {
      // Definir inicio y fin del día (00:00:00 a 23:59:59)
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);

      const end = new Date(date);
      end.setHours(23, 59, 59, 999);

      // Sumar total de pedidos ENTREGADOS en ese rango
      const total = await this.orderRepository.sum('totalAmount', {
        status: OrderStatus.DELIVERED,
        deliveredAt: Between(start, end),
      });

      // Formato para el gráfico (Ej: "Lun", "Mar")
      const dayName = start.toLocaleDateString('es-ES', { weekday: 'short' });

      chartData.push({
        name: dayName.charAt(0).toUpperCase() + dayName.slice(1),
        date: start.toISOString().split('T')[0],
        sales: Number(total) || 0, // Aseguramos que sea número (TypeORM a veces devuelve string en sumas)
      });
    }

    return chartData;
  }
}

