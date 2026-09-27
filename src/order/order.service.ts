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
import { QueryOrdersDto } from './dto/query-orders.dto';
import { DeliveryService } from '../delivery/delivery.service';
import { RoleType } from '../common/constants/role-type.enum';
import { RealtimeDispatchPort } from './domain/ports/realtime-dispatch.port';
import { OrderRepositoryPort } from './domain/ports/order.repository.port';
import { CreateOrderUseCase } from './application/create-order.use-case';
import { UpdateOrderStatusUseCase } from './application/update-order-status.use-case';
import { CancelOrderUseCase } from './application/cancel-order.use-case';
import { ConfirmDeliveryUseCase } from './application/confirm-delivery.use-case';
import { NotificationPort } from './domain/ports/notification.port';
import { DispatchOrchestratorService } from './application/dispatch-orchestrator.service';
import { generateDeliveryCode } from './domain/delivery-code.util';

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,

    private readonly deliveries: DeliveryService,

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
    // Push al cliente detrás del puerto (adapter → NotificationsService →
    // Firebase): el service no conoce FCM.
    private readonly notifications: NotificationPort,
  ) {}

  /**
   * Un chofer solo puede operar sobre pedidos asignados a ÉL MISMO; admin y
   * super_admin pasan sin restricción. Se resuelve el `delivery_id` a partir
   * del `user_id` autenticado porque el pedido guarda el primero y el token
   * trae el segundo.
   */
  private async assertPedidoDelChofer(
    order: Order,
    userId: string,
    role: RoleType,
  ) {
    if (role !== RoleType.DELIVERY) return;

    const delivery = await this.deliveries.buscarPorIdOUsuario(userId);
    if (!delivery || order.deliveryId !== delivery.deliveryId) {
      throw new ForbiddenException('Este pedido no está asignado a tu usuario');
    }
  }

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

  async findAll(queryDto: QueryOrdersDto, distributorId?: string | null) {
    const { limit = 10, offset = 0, term, status, from, to } = queryDto;
    return this.orders.findAllPaginated(limit, offset, distributorId, {
      term,
      status,
      from,
      to,
    });
  }

  /**
   * El pedido sin relaciones, o null. Para los módulos que sólo necesitan
   * saber que existe y de qué distribuidora es (incidencias, calificaciones).
   */
  findById(id: string): Promise<Order | null> {
    return this.orders.findById(id);
  }

  /**
   * Aislamiento entre distribuidoras: con una distribuidora en contexto, el
   * pedido tiene que ser de ella. Lo ajeno responde 404, como si no existiera.
   * Sin contexto (super admin sin "ver como", cliente sin X-Distributor) no
   * acota: el dueño del pedido lo controla cada caso de uso.
   */
  async assertDeLaDistribuidora(
    id: string,
    distributorId: string | null,
  ): Promise<void> {
    if (!distributorId) return;
    const order = await this.orders.findById(id);
    if (order && order.distributorId !== distributorId) {
      throw new NotFoundException(`Order with ID: ${id} not found`);
    }
  }

  /**
   * Un chofer sólo consulta sus propios pedidos: `deliveryId` tiene que ser su
   * perfil de repartidor. Acepta el `delivery_id` o el `user_id`, igual que el
   * resto de los endpoints del chofer.
   */
  async assertEsElChofer(deliveryId: string, userId: string): Promise<void> {
    const propio = await this.deliveries.buscarPorIdOUsuario(userId);
    if (
      !propio ||
      (propio.deliveryId !== deliveryId && propio.userId !== deliveryId)
    ) {
      throw new ForbiddenException('Sólo podés ver tus propios pedidos');
    }
  }

  /**
   * El chofer que opera sobre un pedido tiene que ser el que lo tiene
   * asignado. Un pedido sin chofer tampoco es suyo.
   */
  async assertAsignadoAlChofer(
    deliveryIdDelPedido: string | null,
    userId: string,
  ): Promise<void> {
    const propio = await this.deliveries.buscarPorIdOUsuario(userId);
    if (
      !propio ||
      !deliveryIdDelPedido ||
      propio.deliveryId !== deliveryIdDelPedido
    ) {
      throw new ForbiddenException('Este pedido no está asignado a tu usuario');
    }
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
    customerUserId?: string | null,
  ): Promise<OrderResponseDto> {
    const order = await this.findOne(id);
    // Aislamiento: si hay tenant en contexto (staff, o customer con empresa
    // elegida), el pedido debe ser de esa distribuidora. Evita leer por PK un
    // pedido de otra empresa (IDOR cross-tenant).
    if (
      distributorId &&
      order.distributorId &&
      order.distributorId !== distributorId
    ) {
      throw new NotFoundException(`Order with ID: ${id} not found`);
    }
    // Ownership de cliente: un CUSTOMER solo puede leer SUS pedidos (evita IDOR
    // customer-a-customer dentro de la misma distribuidora). 404 para no
    // revelar que el pedido existe.
    if (customerUserId && order.customerId !== customerUserId) {
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
  async updateStatus(
    id: string,
    status: OrderStatus,
    deliveryId?: string,
    role?: RoleType,
  ) {
    return this.updateOrderStatusUseCase.execute(id, status, deliveryId, role);
  }

  /**
   * Devuelve el código secreto de la prueba de entrega con QR, para que el
   * chofer lo renderice en su app. Ownership: un chofer solo puede ver el
   * código de un pedido asignado a ÉL MISMO; admin puede ver cualquiera.
   */
  async getDeliveryCode(orderId: string, userId: string, role: RoleType) {
    const order = await this.findOne(orderId);

    await this.assertPedidoDelChofer(order, userId, role);

    if (!order.deliveryCode) {
      throw new BadRequestException(
        'El pedido todavía no tiene código de entrega (debe estar aceptado)',
      );
    }

    return { orderId: order.orderId, deliveryCode: order.deliveryCode };
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

  /**
   * Asignación MANUAL del admin (`PATCH /orders/:id/assign/:deliveryId`).
   * Exige habilitado + validado, igual que aceptar una oferta. NO exige que
   * esté en línea: es un acto explícito del admin, no una búsqueda por el
   * radar.
   */
  async assignDelivery(orderId: string, deliveryId: string) {
    const order = await this.findOne(orderId);
    const delivery = await this.deliveries.findById(deliveryId);
    // El chofer tiene que ser de la misma distribuidora que el pedido.
    if (!delivery || delivery.distributorId !== order.distributorId) {
      throw new NotFoundException('Repartidor no encontrado');
    }
    this.deliveries.assertElegibleParaAsignacion(delivery);
    order.deliveryId = deliveryId;
    transitionOrder(order, OrderStatus.ACCEPTED);
    order.acceptedAt = new Date();
    // Igual que cuando el chofer acepta la oferta: sin este código el cliente
    // no puede confirmar la entrega con el QR. Si se reasigna, el código nuevo
    // deja sin efecto el del chofer anterior.
    order.deliveryCode = generateDeliveryCode();
    await this.orderRepository.save(order);

    this.dispatch.notifyAdmins('order:accepted', {
      orderId: order.orderId,
      status: order.status,
      totalAmount: order.totalAmount,
    });
    // Se relee para que la respuesta traiga el chofer nuevo, no el anterior.
    return this.findOne(orderId);
  }

  /**
   * El chofer del pedido reporta su posición. Va al radar, como la que manda
   * por socket, y no al pedido: antes pisaba el punto de entrega y el despacho
   * pasaba a buscar choferes cerca del chofer en vez de cerca del cliente (H-91).
   */
  async updateLocation(id: string, lat: string, lng: string, userId: string) {
    const order = await this.findOne(id);
    await this.assertPedidoDelChofer(order, userId, RoleType.DELIVERY);
    await this.dispatch.reportDriverLocation(userId, Number(lat), Number(lng));
    return order;
  }

  /**
   * KPIs del dashboard. Scopeado por distribuidora (un admin de empresa solo ve
   * lo suyo; super_admin sin tenant ve el consolidado). Usa agregados SQL
   * (SUM/COUNT) en vez de cargar las órdenes a memoria.
   *
   * `sales.week` es la semana calendario (domingo a sábado), no los últimos 7
   * días. `paymentMethods.cash`/`.mercadopago` son del mes en curso (desde el
   * día 1), igual que `sales.month`.
   */
  async getOrderStats(distributorId?: string | null) {
    const dist = distributorId ? { distributorId } : {};

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
      enabledDeliveries,
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
      this.orderRepository.count({
        where: { status: OrderStatus.PENDING, ...dist },
      }),
      this.orderRepository.count({
        where: { status: OrderStatus.ACCEPTED, ...dist },
      }),
      this.orderRepository.count({
        where: { status: OrderStatus.ON_THE_WAY, ...dist },
      }),
      this.deliveries.contarEnLinea(distributorId),
      this.deliveries.contarHabilitados(distributorId),
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
        enabledDeliveries,
        avgOrderValue: deliveredToday > 0 ? todaySalesN / deliveredToday : 0,
        // Deprecado: duplica deliveredToday exacto (ver el DTO). Se mantiene
        // por contrato, no se borra.
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

  async notifyDriverArrived(orderId: string, userId: string, role: RoleType) {
    const order = await this.findOne(orderId);

    await this.assertPedidoDelChofer(order, userId, role);

    if (order.status !== OrderStatus.ON_THE_WAY) {
      throw new BadRequestException(
        'El pedido debe estar en camino para avisar llegada',
      );
    }

    const driverName = order.delivery?.user?.fullName || 'El repartidor';

    this.dispatch.notifyCustomer(order.customerId, 'order:arrived', {
      orderId: order.orderId,
      message: '👋 ¡El repartidor está afuera!',
      driverName,
    });

    // Push además del socket: si el cliente tiene la app cerrada el socket no
    // le llega. Best-effort, no bloquea la respuesta al chofer.
    await this.notifications.sendArrivalPushToCustomer(
      order.customerId,
      order.orderId,
      driverName,
    );

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
      qb.andWhere('order.distributorId = :distributorId', { distributorId });
    }

    const rows = await qb
      .groupBy('day')
      .getRawMany<{ day: Date | string; total: string | null }>();

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
