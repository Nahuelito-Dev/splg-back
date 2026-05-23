import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  DataSource,
  IsNull,
  MoreThanOrEqual,
  Between,
} from 'typeorm';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
} from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { OrderMapper } from './order.mapper';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { GasCylinder } from '../gascylinder/entities/gascylinder.entity';
import { User } from '../users/entities/user.entity';
import { Delivery } from '../delivery/entities/delivery.entity';
import { UserAddress } from '../user-addres/entities/user-addres.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { DriversGateway } from '../gateways/drivers.gateway';
import { RedisService } from '../redis/redis.service';
import { CustomersGateway } from '../gateways/customers.gateway';

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,

    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,

    @InjectRepository(GasCylinder)
    private readonly gasCylinderRepository: Repository<GasCylinder>,

    @InjectRepository(User)
    private readonly userRepository: Repository<User>,

    @InjectRepository(Delivery)
    private readonly deliveryRepository: Repository<Delivery>,

    @InjectRepository(UserAddress)
    private readonly userAddressRepository: Repository<UserAddress>,

    private readonly dataSource: DataSource,
    private readonly notificationService: NotificationsService,

    private readonly driversGateway: DriversGateway,
    private readonly customersGateway: CustomersGateway,
    private readonly redisService: RedisService,
  ) {}

  async create(createOrderDto: CreateOrderDto) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const customer = await this.userRepository.findOne({
        where: { user_id: createOrderDto.customerId },
        relations: ['customer'],
      });

      if (!customer || !customer.customer) {
        throw new NotFoundException('Cliente no encontrado');
      }

      const address = await this.userAddressRepository.findOne({
        where: {
          address_id: createOrderDto.addressId,
          user_id: createOrderDto.customerId,
        },
      });

      if (!address) {
        throw new NotFoundException('Dirección no encontrada');
      }

      let totalAmount = new Decimal(0);
      const orderItems: OrderItem[] = [];

      for (const itemDto of createOrderDto.items) {
        // SELECT ... FOR UPDATE: serializa la lectura de stock con cualquier
        // otra transacción concurrente sobre la misma garrafa. Evita oversell.
        const gasCylinder = await queryRunner.manager
          .createQueryBuilder(GasCylinder, 'gc')
          .setLock('pessimistic_write')
          .where('gc.gas_cylinder_id = :id', {
            id: itemDto.gasCylinderId,
          })
          .getOne();

        if (!gasCylinder) {
          throw new NotFoundException(
            `Garrafa no encontrada: ${itemDto.gasCylinderId}`,
          );
        }

        if (gasCylinder.stock < itemDto.quantity) {
          throw new BadRequestException(
            `Stock insuficiente para ${gasCylinder.type}`,
          );
        }

        // --- Pricing Logic Start (Decimal.js) ---
        let unitPrice = new Decimal(gasCylinder.price); // Trust DB price

        // Apply Promotions
        if (gasCylinder.promotions && gasCylinder.promotions.length > 0) {
          const applicablePromo = gasCylinder.promotions
            .sort((a, b) => b.quantity - a.quantity)
            .find((p) => itemDto.quantity >= p.quantity);

          if (applicablePromo) {
            const discountFactor = new Decimal(1).minus(
              new Decimal(applicablePromo.discountPercentage).dividedBy(100),
            );
            unitPrice = unitPrice.times(discountFactor);
          }
        }

        const quantity = new Decimal(itemDto.quantity);
        const subtotal = quantity.times(unitPrice);

        // Accumulate total with Decimal precision
        totalAmount = totalAmount.plus(subtotal);
        // --- Pricing Logic End ---

        const orderItem = this.orderItemRepository.create({
          gas_cylinder_id: itemDto.gasCylinderId,
          quantity: itemDto.quantity,
          unitPrice: unitPrice.toNumber(),
          subtotal: subtotal.toNumber(),
        });

        orderItems.push(orderItem);

        gasCylinder.stock -= itemDto.quantity;
        await queryRunner.manager.save(gasCylinder);
      }

      // --- Payment Method Surcharge Logic ---
      if (createOrderDto.paymentMethod === PaymentMethod.TRANSFER) {
        // totalAmount * 1.1
        totalAmount = totalAmount.times(1.1);
      }

      // Determine Payment Type
      const paymentType =
        createOrderDto.paymentMethod === PaymentMethod.CASH
          ? PaymentType.CASH
          : PaymentType.ONLINE;

      const order = this.orderRepository.create({
        customer_id: createOrderDto.customerId,
        address_id: createOrderDto.addressId,
        status: OrderStatus.PENDING,
        paymentMethod: createOrderDto.paymentMethod as PaymentMethod,
        paymentType: paymentType, // Save the determined type
        time_slot_id: createOrderDto.timeSlotId, // Save the time slot
        paymentStatus: PaymentStatus.PENDING,
        totalAmount: totalAmount.toNumber(),
        notes: createOrderDto.notes,
        deliveryLatitude: address.latitude,
        deliveryLongitude: address.longitude,
        items: orderItems,
      });

      const savedOrder = await queryRunner.manager.save(order);

      // Items are saved automatically due to cascade: true in Order entity

      await queryRunner.commitTransaction();

      // Matching Logic
      try {
        const nearbyDrivers = await this.redisService.getNearbyDrivers(
          Number(address.latitude),
          Number(address.longitude),
          5,
        );

        if (nearbyDrivers.length > 0) {
          this.customersGateway.notifyCustomer(
            createOrderDto.customerId,
            'order:driver-found',
            {
              message: `Se encontraron ${nearbyDrivers.length} choferes cercanos. Contactando...`,
            },
          );

          const driverPayload = {
            event: 'NEW_ORDER',
            orderId: savedOrder.order_id,
            totalAmount: savedOrder.totalAmount,
            paymentMethod: savedOrder.paymentMethod,
            distance: 'Cerca de tu ubicación',
            earnings: 1500,
            pickup: {
              lat: -34.6037,
              lng: -58.3816,
            },
            delivery: {
              lat: address.latitude,
              lng: address.longitude,
              address: address.street,
            },
            items: createOrderDto.items,
          };

          for (const driverId of nearbyDrivers) {
            this.driversGateway.notifyNewOrder(driverId, driverPayload);
          }
        }
      } catch (wsError) {
        // Silently fail websocket errors to not disrupt order creation
      }

      try {
        await this.notificationService.sendOrderConfirmation(
          createOrderDto.customerId,
          savedOrder.order_id,
          createOrderDto.notificationToken,
        );
      } catch (notifError) {
        // Ignore notification errors
      }

      return await this.findOne(savedOrder.order_id);
    } catch (error: any) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }

      // Ahora TypeScript te dejará acceder a .status sin quejarse
      if (error.status === 404 || error.status === 400) {
        throw error;
      }

      throw new InternalServerErrorException('Error al crear el pedido');
    } finally {
      await queryRunner.release();
    }
  }

  async findAll(paginationDto: PaginationDto) {
    const { limit = 10, offset = 0 } = paginationDto;
    const [orders, total] = await this.orderRepository.findAndCount({
      take: limit,
      skip: offset,
      relations: [
        'customer',
        'customer.customer',
        'delivery',
        'delivery.user',
        'items',
        'items.gasCylinder',
        'address',
        'timeSlot',
      ],
      order: { createdAt: 'DESC' },
    });
    return {
      orders,
      total,
      limit,
      offset,
    };
  }

  async findOne(id: string) {
    const order = await this.orderRepository.findOne({
      where: { order_id: id },
      relations: [
        'customer',
        'customer.customer',
        'delivery',
        'delivery.user',
        'items',
        'items.gasCylinder',
        'address',
        'timeSlot',
      ],
    });
    if (!order) throw new NotFoundException(`Order with ID: ${id} not found`);
    return order; // Note: Internal findOne returns Entity for re-use, validation etc.
    // However, if called from controller, we might want DTO.
    // BUT findOne is used internally by updateStatus etc.
    // SO: We should keep findOne returning Entity, and Controller maps it.
    // OR create findOneDto.
    // Let's modify the Controller to map it, or create a specific getOne method.
    // Actually, looking at 'create' above return, I mapped it.
    // Let's refactor findOne to return Entity (as it does) and add getOne returning DTO.
  }

  async getOne(id: string): Promise<OrderResponseDto> {
    const order = await this.findOne(id);
    return OrderMapper.toDto(order);
  }

  async findAvailableOrders(paginationDto: PaginationDto) {
    const { limit = 10, offset = 0 } = paginationDto;
    const [orders, total] = await this.orderRepository.findAndCount({
      where: { status: OrderStatus.PENDING, delivery_id: IsNull() },
      take: limit,
      skip: offset,
      relations: [
        'customer',
        'customer.customer',
        'items',
        'items.gasCylinder',
        'address',
        'timeSlot',
      ],
      order: { createdAt: 'ASC' },
    });
    return {
      orders,
      total,
      limit,
      offset,
    };
  }

  async findByCustomer(customerId: string, paginationDto: PaginationDto) {
    const { limit = 10, offset = 0 } = paginationDto;
    const [orders, total] = await this.orderRepository.findAndCount({
      where: { customer_id: customerId },
      take: limit,
      skip: offset,
      relations: [
        'delivery',
        'delivery.user',
        'items',
        'items.gasCylinder',
        'address',
        'timeSlot',
      ],
      order: { createdAt: 'DESC' },
    });
    return {
      orders,
      total,
      limit,
      offset,
    };
  }

  async findByDelivery(deliveryId: string, paginationDto: PaginationDto) {
    const { limit = 10, offset = 0 } = paginationDto;
    const [orders, total] = await this.orderRepository.findAndCount({
      where: { delivery_id: deliveryId },
      take: limit,
      skip: offset,
      relations: [
        'customer',
        'customer.customer',
        'items',
        'items.gasCylinder',
        'address',
        'timeSlot',
      ],
      order: { createdAt: 'DESC' },
    });
    return {
      orders,
      total,
      limit,
      offset,
    };
  }

  async updateStatus(id: string, status: OrderStatus, deliveryId?: string) {
    const order = await this.findOne(id);

    if (status === OrderStatus.ACCEPTED && !deliveryId) {
      throw new BadRequestException(
        'Se requiere un repartidor para aceptar el pedido',
      );
    }

    order.status = status;

    let deliveryUser: User | null = null;
    switch (status) {
      case OrderStatus.ACCEPTED:
        if (!deliveryId || deliveryId.trim() === '') {
          throw new BadRequestException('Delivery ID is required');
        }

        const delivery = await this.deliveryRepository.findOne({
          where: [{ delivery_id: deliveryId }, { user_id: deliveryId }],
          relations: ['user'],
        });

        if (!delivery) {
          throw new NotFoundException(
            `Repartidor no encontrado con ID: ${deliveryId}`,
          );
        }

        if (!delivery.isActive) {
          throw new BadRequestException('El repartidor no está activo');
        }

        order.delivery_id = delivery.delivery_id;
        order.acceptedAt = new Date();
        deliveryUser = delivery.user;
        break;

      case OrderStatus.ON_THE_WAY:
        order.onTheWayAt = new Date();
        if (order.delivery_id) {
          const existingDelivery = await this.deliveryRepository.findOne({
            where: { delivery_id: order.delivery_id },
            relations: ['user'],
          });
          deliveryUser = existingDelivery?.user || null;
        }
        break;

      case OrderStatus.DELIVERED:
        order.deliveredAt = new Date();
        if (order.paymentMethod === PaymentMethod.CASH) {
          order.paymentStatus = PaymentStatus.PAID;
        }
        break;
    }

    await this.orderRepository.save(order);

    try {
      const eventPayload = {
        orderId: order.order_id,
        status: order.status,
        updatedAt: new Date(),
        paymentStatus: order.paymentStatus,
        driver: deliveryUser
          ? {
              name: deliveryUser.full_name,
              phone: deliveryUser.phone_number,
            }
          : null,
      };

      const eventMap = {
        [OrderStatus.ACCEPTED]: 'order:accepted',
        [OrderStatus.ON_THE_WAY]: 'order:on-the-way',
        [OrderStatus.DELIVERED]: 'order:delivered',
        [OrderStatus.CANCELLED]: 'order:cancelled',
      };

      const eventName = eventMap[status];

      if (eventName) {
        this.customersGateway.notifyCustomer(
          order.customer_id,
          eventName,
          eventPayload,
        );
      }
    } catch (wsError) {
      // Ignore websocket errors
    }

    const customer = await this.userRepository.findOne({
      where: { user_id: order.customer_id },
      relations: ['customer'],
    });

    if (customer && customer.customer) {
      try {
        await this.notificationService.sendOrderConfirmation(
          order.customer_id,
          order.order_id,
          customer.customer.notification_token,
        );
      } catch (error) {
        // Ignore notification errors
      }
    }

    return order;
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

  async cancelOrder(
    orderId: string,
    userId: string,
    role: 'customer' | 'driver' | 'admin' | 'superadmin',
    reason?: string,
  ) {
    const order = await this.findOne(orderId);

    if (
      order.status === OrderStatus.DELIVERED ||
      order.status === OrderStatus.CANCELLED
    ) {
      throw new BadRequestException(
        'No se puede cancelar un pedido finalizado',
      );
    }

    const previousDriverId = order.delivery_id;
    let shouldReturnStock = false;

    if (role === 'customer') {
      if (order.status === OrderStatus.ON_THE_WAY) {
        throw new BadRequestException(
          'El pedido ya está en camino. Contacte al soporte.',
        );
      }
      if (order.customer_id !== userId) {
        throw new BadRequestException('No autorizado');
      }
      order.status = OrderStatus.CANCELLED;
      shouldReturnStock = true;
    } else if (role === 'driver') {
      order.status = OrderStatus.PENDING;
      order.delivery_id = null;
      order.acceptedAt = null;
      order.onTheWayAt = null;
    } else if (role === 'admin') {
      order.status = OrderStatus.CANCELLED;
      shouldReturnStock = true;
    }

    if (order.status === OrderStatus.CANCELLED) {
      order.cancellationReason = reason || `Cancelado por ${role}`;
    }

    if (shouldReturnStock) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        for (const item of order.items) {
          // SELECT ... FOR UPDATE en la restitución: previene que otra
          // transacción de creación lea stock obsoleto mientras devolvemos.
          const cylinder = await queryRunner.manager
            .createQueryBuilder(GasCylinder, 'gc')
            .setLock('pessimistic_write')
            .where('gc.gas_cylinder_id = :id', {
              id: item.gas_cylinder_id,
            })
            .getOne();
          if (cylinder) {
            cylinder.stock += item.quantity;
            await queryRunner.manager.save(cylinder);
          }
        }
        await queryRunner.commitTransaction();
      } catch (e) {
        await queryRunner.rollbackTransaction();
        throw e;
      } finally {
        await queryRunner.release();
      }
    }

    await this.orderRepository.save(order);

    const payload = {
      orderId: order.order_id,
      status: order.status,
      reason: order.cancellationReason,
    };

    if (role === 'driver') {
      this.customersGateway.notifyCustomer(
        order.customer_id,
        'order:searching-driver',
        payload,
      );
    } else {
      this.customersGateway.notifyCustomer(
        order.customer_id,
        'order:cancelled',
        payload,
      );
    }

    if (previousDriverId && role !== 'driver') {
      this.driversGateway.notifyOrderCancelled(previousDriverId, {
        ...payload,
        message: 'El cliente canceló el pedido. No es necesario ir.',
      });
    }

    return order;
  }

  async notifyDriverArrived(orderId: string) {
    const order = await this.findOne(orderId);

    if (order.status !== OrderStatus.ON_THE_WAY) {
      throw new BadRequestException(
        'El pedido debe estar en camino para avisar llegada',
      );
    }

    this.customersGateway.notifyCustomer(order.customer_id, 'order:arrived', {
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

