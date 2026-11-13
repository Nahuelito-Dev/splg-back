import { esperaPagoOnline, mensajeDeEspera } from './domain/espera-pago-online';
import { OrderItem } from './entities/order-item.entity';
import { TruckLoadGatePort } from './domain/ports/truck-load-gate.port';
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  And,
  DataSource,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import {
  soloVentaCobrada,
  ventaCobradaWhere,
} from '../common/utils/venta-cobrada';
import {
  Order,
  OrderDeliveryMode,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from './entities/order.entity';
import { transitionOrder } from './domain/order-status.machine';
import { CreateOrderDto } from './dto/create-order.dto';
import { DriverDeOrderDto, OrderResponseDto } from './dto/order-response.dto';
import {
  HistorialDeEstadoActorDto,
  OrderStatusHistoryEntryDto,
} from './dto/order-status-history-response.dto';
import type { CancelledBy } from './application/cancel-order.use-case';
import { marcarRespuestaIncompleta } from '../common/interceptors/respuesta-incompleta';
import { ubicacionVigente } from '../common/utils/ubicacion-vigente';
import { errorMessage } from '../common/errors/error-message';
import { ahoraDeLaBase } from '../common/utils/ahora-de-la-base';
import { DriverRatingPort } from './domain/ports/driver-rating.port';
import { OrderMapper } from './order.mapper';
import {
  diaArgentino,
  lunesDeLaSemana,
  inicioDelDiaArgentino,
  primerDiaDelMes,
  primerDiaDelMesSiguiente,
  sumarDias,
  truncarEnArgentinaSql,
} from '../common/utils/dias-argentina';
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
import { DispatchSettingsService } from '../distributor/dispatch-settings.service';
import { DispatchOfferRepositoryPort } from './domain/ports/dispatch-offer.repository.port';
import { DispatchOfferStatus } from './entities/dispatch-offer.entity';
import {
  generateDeliveryCode,
  MAX_INTENTOS_CODIGO_ENTREGA,
} from './domain/delivery-code.util';
import { bloquearChoferVigente } from '../common/locks/chofer-lock';
import { FleetDispatchLockService } from '../fleet/fleet-dispatch-lock.service';
import { RedisService } from '../redis/redis.service';
import type { PushDeLlegada } from './domain/ports/notification.port';

/** Respuesta del aviso «Llegué» (también la de un aviso repetido). */
const AVISO_DE_LLEGADA = { message: 'Cliente notificado' } as const;
/** Cuánto dura la marca de «ya avisé la llegada» de un pedido y chofer. */
const ARRIVAL_MARK_TTL_SECONDS = 6 * 60 * 60;
/** Tope de cada operación de Redis de la marca de llegada. */
const ARRIVAL_MARK_TIMEOUT_MS = 500;
/**
 * Marca «enviando»: el turno de avisar. Vence sola si el proceso muere a
 * mitad del aviso; es mayor que el tope de FCM (5 s por omisión) más la
 * lectura del token.
 */
const ARRIVAL_SENDING_TTL_SECONDS = 15;
/** Valor de la marca cuando el push salió (dura `ARRIVAL_MARK_TTL_SECONDS`). */
const MARCA_ENVIADO = 'sent';
/** Cuánto espera un toque a que se resuelva el aviso que está enviando otro. */
const ARRIVAL_WAIT_MAX_MS = 8_000;
const ARRIVAL_WAIT_STEP_MS = 250;

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

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
    // Para distinguir, en `rejectOffer`, una oferta real del despacho
    // automático de una asignación MANUAL (H-55): esta última no crea fila.
    private readonly dispatchOffers: DispatchOfferRepositoryPort,
    // Push al cliente detrás del puerto (adapter → NotificationsService →
    // Firebase): el service no conoce FCM.
    private readonly notifications: NotificationPort,
    // Para el lock pesimista de `assignDelivery` (segunda revisión, punto 2):
    // mismo patrón que `CancelOrderUseCase`/`ReleaseOrderUseCase`.
    private readonly dataSource: DataSource,
    // Gate único de bloqueo de flota (CU-136 a CU-138), compartido con
    // `UpdateOrderStatusUseCase` y el despacho automático: la asignación
    // manual tampoco puede darle un pedido a un chofer inhabilitado.
    private readonly fleetGate: FleetDispatchLockService,
    // D5: con control de carga activo, el administrador tampoco asigna un pedido
    // a un chofer sin la carga del día abierta.
    private readonly truckLoadGate: TruckLoadGatePort,
    // Calificación del chofer para mostrarla en el pedido del cliente.
    private readonly driverRatings: DriverRatingPort,
    // CU-171: la asignación manual avisa al chofer con la misma ventana del despacho.
    private readonly dispatchSettings: DispatchSettingsService,
    // «Llegué» v2: marca de aviso ya enviado (un segundo toque no re-notifica).
    private readonly redis: RedisService,
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
   * CU-016: el chofer rechaza/ignora una oferta de pedido. Dos caminos según
   * cómo llegó el pedido a él:
   *  - Oferta REAL del despacho automático (hay una fila `OFFERED` de ESTE
   *    chofer): cierra la oferta como REJECTED y re-ofrece al siguiente
   *    chofer más cercano de inmediato.
   *  - Asignación MANUAL del admin (H-55): el chofer la recibe con el MISMO
   *    evento de socket que una oferta (`server:new-order-request`), pero no
   *    hay ninguna fila `OFFERED` suya que cerrar — ya está ACCEPTED directo.
   *
   * Segunda revisión, punto 1 (decisión de nahue, cambia la tanda anterior):
   * la app del chofer manda este mismo `/reject` TANTO si el chofer lo
   * rechaza activamente COMO si deja vencer el aviso a los 30s sin tocarlo
   * (mismo timeout visual que una oferta real, aunque esto no es una oferta:
   * del lado del servidor no hay nada que expire). Si liberáramos el pedido
   * en este caso, cualquier demora del chofer en responder deshace una
   * asignación que un ADMIN decidió a mano. En vez de eso: el pedido NO
   * cambia, y se avisa a los admins de la distribuidora (`order:assignment-
   * declined`) para que decida un humano (reasignar a otro chofer, insistir,
   * lo que corresponda). El rechazo en sí queda registrado por el audit log
   * global de toda escritura (`AuditInterceptor`, CU-153) — no hace falta un
   * registro aparte.
   *
   * Un `/reject` TARDÍO sobre un pedido que YA fue aceptado por una oferta
   * real (de este chofer o de otro, lo que sea que haya pasado mientras
   * tanto) tampoco tiene efecto: `hasActiveOffer(orderId, driverId)` ya no
   * encuentra una oferta `OFFERED` suya (se cerró como `ACCEPTED` al
   * aceptarse), y `onDriverRejected` es un no-op si no hay nada que cerrar.
   *
   * Un pedido que no existe es 404. Que el chofer ya no tenga una oferta
   * vigente (otro la tomó, venció) no es un error: `{ rejected: true }` sin
   * efecto.
   */
  async rejectOffer(orderId: string, driverId: string) {
    const order = await this.orders.findByIdFull(orderId);
    if (!order) throw new NotFoundException('Pedido no encontrado');

    // Punto 5 (segunda revisión): la oferta activa tiene que ser DE ESTE
    // chofer. Una oferta OFFERED de OTRO chofer para el mismo pedido (una
    // carrera del despacho automático que se cruzó con esta asignación
    // manual) no cuenta como "yo tengo una oferta real": seguiría siendo la
    // asignación manual de este chofer.
    const esAsignacionManualSuya =
      order.status === OrderStatus.ACCEPTED &&
      order.delivery?.userId === driverId &&
      !(await this.dispatchOffers.hasActiveOffer(orderId, driverId));

    if (esAsignacionManualSuya) {
      this.dispatch.notifyAdmins(
        'order:assignment-declined',
        {
          orderId: order.orderId,
          driverId,
          driverName: order.delivery?.user?.fullName ?? null,
          distributorId: order.distributorId,
        },
        order.distributorId,
      );
      return { rejected: true };
    }

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
    const {
      limit = 10,
      offset = 0,
      term,
      status,
      paymentStatus,
      from,
      to,
      deliveredFrom,
      deliveredTo,
      sort,
      order,
    } = queryDto;
    // Mismo criterio que /reports: un rango invertido es un error, no un listado vacío.
    if (from && to && from > to) {
      throw new BadRequestException('«Desde» no puede ser posterior a «Hasta»');
    }
    if (deliveredFrom && deliveredTo && deliveredFrom > deliveredTo) {
      throw new BadRequestException(
        '«Entregado desde» no puede ser posterior a «Entregado hasta»',
      );
    }
    return this.orders.findAllPaginated(limit, offset, distributorId, {
      term,
      status,
      paymentStatus,
      from,
      to,
      deliveredFrom,
      deliveredTo,
      sort,
      order,
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
      throw new NotFoundException('Pedido no encontrado');
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
   * El chofer que opera sobre un pedido tiene que ser el que lo tiene asignado.
   * Mismo criterio que la lectura: un pedido ajeno, o sin chofer, no existe para
   * él (404); si lo tuvo y ya no es suyo, 410.
   */
  async assertPedidoPropioDelChofer(
    order: Order,
    userId: string,
  ): Promise<void> {
    const propio = await this.deliveries.buscarPorIdOUsuario(userId);
    if (propio && order.deliveryId && propio.deliveryId === order.deliveryId) {
      return;
    }
    if (await this.dispatchOffers.hasHeldOrder(order.orderId, userId)) {
      throw new GoneException('Este pedido ya no está asignado a tu usuario');
    }
    throw new NotFoundException('Pedido no encontrado');
  }

  /**
   * Lo que hace falta para trazar la ruta de UN pedido: su destino (la dirección
   * de entrega), su distribuidora y el chofer. Sólo lo pide el cliente dueño
   * (con el pedido en camino) o el chofer asignado (aceptado o en camino); si es
   * de otro, 404 sin revelar que existe; si no está en esos estados, 403. 409 si la dirección no tiene punto.
   */
  async datosParaLaRuta(
    orderId: string,
    userId: string,
    role: RoleType,
  ): Promise<{
    distributorId: string;
    choferUserId: string | null;
    destino: { lat: number; lng: number };
  }> {
    const order = await this.orderRepository.findOne({
      where: { orderId },
      relations: { address: true, delivery: true },
    });
    let esSuyo = false;
    if (order && role === RoleType.CUSTOMER) {
      esSuyo = order.customerId === userId;
    } else if (order && role === RoleType.DELIVERY) {
      const chofer = await this.deliveries.buscarPorIdOUsuario(userId);
      esSuyo = !!chofer && order.deliveryId === chofer.deliveryId;
    }
    if (!order || !esSuyo) {
      throw new NotFoundException('Pedido no encontrado');
    }
    // El cliente sólo desde que el chofer sale: la ruta nace en la posición del
    // chofer y antes de eso esa posición no es suya (puede estar entregando otro).
    const estadosPermitidos =
      role === RoleType.CUSTOMER
        ? [OrderStatus.ON_THE_WAY]
        : [OrderStatus.ACCEPTED, OrderStatus.ON_THE_WAY];
    if (!estadosPermitidos.includes(order.status)) {
      throw new ForbiddenException(
        role === RoleType.CUSTOMER
          ? 'La ruta está disponible cuando el chofer sale con tu pedido'
          : 'Sólo se calcula la ruta de un pedido activo (aceptado o en camino)',
      );
    }
    const punto = order.address?.location;
    if (!punto) {
      throw new ConflictException(
        'La dirección de entrega del pedido no tiene coordenadas',
      );
    }
    const [lng, lat] = punto.coordinates;
    return {
      distributorId: order.distributorId,
      choferUserId: order.delivery?.userId ?? null,
      destino: { lat, lng },
    };
  }

  async findOne(id: string) {
    // Delega en el puerto de repositorio. Devuelve la entidad (uso interno por
    // updateStatus/cancel); getOne() mapea a DTO para el controller.
    const order = await this.orders.findByIdFull(id);
    if (!order) throw new NotFoundException('Pedido no encontrado');
    return order;
  }

  async getOne(
    id: string,
    distributorId?: string | null,
    customerUserId?: string | null,
    choferUserId?: string | null,
    incluirChofer = false,
  ): Promise<OrderResponseDto> {
    const order = await this.pedidoLegible(
      id,
      distributorId,
      customerUserId,
      choferUserId,
    );
    const dto = OrderMapper.toDto(order);
    // Quién recibe es un dato de un tercero: un chofer lo ve sólo cuando el
    // pedido es suyo, no mientras lo mira como oferta o desde el pool.
    if (choferUserId && order.delivery?.userId !== choferUserId) {
      dto.receiver = null;
    }
    if (order.status === OrderStatus.CANCELLED) {
      dto.cancelledBy = await this.quienCancelo(order.orderId);
    } else if (
      order.paymentMethod === PaymentMethod.MERCADOPAGO &&
      (order.paymentStatus === PaymentStatus.PENDING ||
        order.paymentStatus === PaymentStatus.FAILED) &&
      !order.depositPaid &&
      !choferUserId
    ) {
      // El enlace de pago se genera al crear el pedido (o la seña de una
      // reserva) y se guarda en el registro de cobros: la lectura lo devuelve
      // mientras se pueda pagar con él (pendiente, o un intento rechazado con el
      // checkout sin vencer), para recuperarlo si se perdió la respuesta del alta
      // y para que el comprador reintente.
      dto.paymentUrl =
        (await this.createOrderUseCase.enlaceDeCobroPendiente(order.orderId)) ??
        undefined;
    }
    if (incluirChofer) dto.driver = await this.datosDelChofer(order);
    return dto;
  }

  /**
   * 404 si quien pregunta no puede leer el pedido (mismas reglas que el detalle).
   * Para las lecturas que cuelgan del pedido y viven en otro módulo (el estado de su pago).
   */
  async assertLegible(
    id: string,
    distributorId?: string | null,
    customerUserId?: string | null,
  ): Promise<void> {
    await this.pedidoLegible(id, distributorId, customerUserId);
  }

  /**
   * El pedido, si quien pregunta puede leerlo (misma regla para el detalle y
   * para su historial de estados): del tenant en contexto, del cliente dueño o
   * del chofer que lo tiene, lo ofertado o el pool. Lo ajeno es 404 (410 para
   * el chofer que lo tuvo).
   */
  private async pedidoLegible(
    id: string,
    distributorId?: string | null,
    customerUserId?: string | null,
    choferUserId?: string | null,
  ): Promise<Order> {
    const order = await this.findOne(id);
    // Aislamiento: si hay tenant en contexto (staff, o customer con empresa
    // elegida), el pedido debe ser de esa distribuidora. Evita leer por PK un
    // pedido de otra empresa (IDOR cross-tenant).
    if (
      distributorId &&
      order.distributorId &&
      order.distributorId !== distributorId
    ) {
      throw new NotFoundException('Pedido no encontrado');
    }
    // Ownership de cliente: un CUSTOMER solo puede leer SUS pedidos (evita IDOR
    // customer-a-customer dentro de la misma distribuidora). 404 para no
    // revelar que el pedido existe.
    if (customerUserId && order.customerId !== customerUserId) {
      throw new NotFoundException('Pedido no encontrado');
    }
    // Un chofer solo lee lo que es suyo, lo que se le ofreció o lo que está en
    // el pool que ve en `GET /orders/available`. Lo demás es 404.
    if (choferUserId && !(await this.puedeLeerElChofer(order, choferUserId))) {
      // Si el chofer TUVO el pedido (se lo liberó el admin, lo reasignaron, el
      // control de carga lo sacó del pool), la app necesita salir de la
      // pantalla: 410 "ya no es tuyo" en vez de un 404 que la deja con el
      // pedido viejo. Un pedido que nunca tuvo sigue siendo 404.
      if (await this.dispatchOffers.hasHeldOrder(order.orderId, choferUserId)) {
        throw new GoneException('Este pedido ya no está asignado a tu usuario');
      }
      throw new NotFoundException('Pedido no encontrado');
    }
    return order;
  }

  /**
   * Historial de estados del pedido, del más viejo al más nuevo. Lo lee quien
   * puede leer el pedido. El nombre de quien hizo cada cambio sólo se muestra
   * al staff (`verNombres`).
   */
  async getStatusHistory(
    id: string,
    distributorId?: string | null,
    customerUserId?: string | null,
    choferUserId?: string | null,
    verNombres = false,
  ): Promise<OrderStatusHistoryEntryDto[]> {
    await this.pedidoLegible(id, distributorId, customerUserId, choferUserId);
    const filas: Array<{
      history_id: string;
      from_status: OrderStatus | null;
      to_status: OrderStatus;
      reason: string | null;
      changed_at: Date;
      user_id: string | null;
      full_name: string | null;
      type: string | null;
    }> = await this.orderRepository.manager.query(
      `SELECT h.history_id, h.from_status, h.to_status, h.reason, h.changed_at,
              h.changed_by_user_id AS user_id, u.full_name, r.type
         FROM order_status_history h
         LEFT JOIN "user" u ON u.user_id = h.changed_by_user_id
         LEFT JOIN role r ON r.role_id = u.role_id
        WHERE h.order_id = $1
        ORDER BY h.changed_at ASC, h.history_id ASC`,
      [id],
    );
    return filas.map((fila) => {
      const entrada = new OrderStatusHistoryEntryDto();
      entrada.id = fila.history_id;
      entrada.fromStatus = fila.from_status
        ? OrderMapper.mapStatus(fila.from_status)
        : null;
      entrada.toStatus = OrderMapper.mapStatus(fila.to_status);
      entrada.isNote = fila.from_status === fila.to_status;
      entrada.reason = fila.reason;
      entrada.changedAt = fila.changed_at;
      if (fila.user_id) {
        const actor = new HistorialDeEstadoActorDto();
        actor.userId = fila.user_id;
        actor.role = fila.type;
        actor.fullName = verNombres ? fila.full_name : null;
        entrada.changedBy = actor;
      } else {
        entrada.changedBy = null;
      }
      return entrada;
    });
  }

  /**
   * Quién canceló el pedido, sacado de la última transición a `cancelled` del
   * historial de estados: el rol del usuario que la hizo, o `system` si no hubo
   * usuario (cron, webhook). `null` si no hay fila (pedido anterior al historial).
   */
  private async quienCancelo(orderId: string): Promise<CancelledBy | null> {
    const filas: Array<{ user_id: string | null; type: string | null }> =
      await this.orderRepository.manager.query(
        `SELECT h.changed_by_user_id AS user_id, r.type
           FROM order_status_history h
           LEFT JOIN "user" u ON u.user_id = h.changed_by_user_id
           LEFT JOIN role r ON r.role_id = u.role_id
          WHERE h.order_id = $1 AND h.to_status = 'cancelled'
          ORDER BY h.changed_at DESC LIMIT 1`,
        [orderId],
      );
    const fila = filas[0];
    if (!fila) return null;
    if (!fila.user_id) return 'system';
    switch (fila.type) {
      case RoleType.CUSTOMER:
        return 'customer';
      case RoleType.ADMIN:
      case RoleType.SUPER_ADMIN:
        return 'admin';
      case RoleType.DELIVERY:
        return 'driver';
      default:
        return 'system';
    }
  }

  /**
   * Nombre, teléfono y calificación del chofer (y su ubicación, sólo en camino), mientras el pedido está activo
   * y tiene chofer. Cerrado (entregado/cancelado) o sin chofer: `null`, así el
   * teléfono no queda expuesto cuando ya no hace falta.
   */
  private async datosDelChofer(order: Order): Promise<DriverDeOrderDto | null> {
    const activo =
      order.status === OrderStatus.ACCEPTED ||
      order.status === OrderStatus.ON_THE_WAY;
    const chofer = order.delivery;
    if (!activo || !chofer?.user) return null;
    const calificacion = await this.driverRatings.resumen(chofer.userId);
    const dto = new DriverDeOrderDto();
    dto.userId = chofer.userId;
    dto.fullName = chofer.user.fullName ?? null;
    dto.phoneNumber = chofer.user.phoneNumber ?? null;
    dto.ratingAverage = calificacion.average;
    dto.ratingCount = calificacion.count;
    // Best-effort: sin radar (Redis caído) el pedido se lee igual, sin posición.
    // Sólo en camino y siendo ESTE el pedido que lleva: antes (aceptado) el
    // chofer puede estar entregando otro y su posición no es de este cliente.
    dto.location =
      order.status === OrderStatus.ON_THE_WAY
        ? ubicacionVigente(
            await this.dispatch
              .lastDriverLocation(chofer.userId, order.orderId)
              .catch(() => null),
          )
        : null;
    return dto;
  }

  /**
   * Un pedido es legible por el chofer si lo tiene asignado, si tiene una oferta
   * de despacho vigente para él, o si está en el pool de disponibles de su
   * distribuidora (pendiente, sin chofer y con la carga del día en regla).
   */
  private async puedeLeerElChofer(
    order: Order,
    userId: string,
  ): Promise<boolean> {
    const chofer = await this.deliveries.buscarPorIdOUsuario(userId);
    if (!chofer) return false;
    if (order.deliveryId && order.deliveryId === chofer.deliveryId) return true;
    if (await this.dispatchOffers.hasActiveOffer(order.orderId, userId)) {
      return true;
    }
    const enElPool =
      order.status === OrderStatus.PENDING &&
      !order.deliveryId &&
      Boolean(order.distributorId) &&
      order.distributorId === chofer.distributorId;
    if (!enElPool) return false;
    const motivo = await this.truckLoadGate.motivoParaNoRecibir(
      order.distributorId,
      userId,
    );
    return motivo === null;
  }

  /** Distribuidoras con pedidos pendientes sin chofer. */
  distribuidorasConPedidosDisponibles(): Promise<string[]> {
    return this.orders.findDistributorsWithAvailable();
  }

  /**
   * Pedidos pendientes sin chofer. Los express (CU-149) no están en el pool del
   * chofer: se ofrecen de a uno a las motos; sólo el despacho los pide
   * (`incluirExpress`) para no dejarlos sin oferta.
   */
  async findAvailableOrders(
    paginationDto: PaginationDto,
    distributorId?: string | null,
    incluirExpress = false,
  ) {
    const { limit = 10, offset = 0 } = paginationDto;
    return this.orders.findAvailable(
      limit,
      offset,
      distributorId,
      incluirExpress,
    );
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
   * El pedido en curso del chofer (ver `OrderRepositoryPort.findCurrentOfDelivery`):
   * el que va en camino; si no, el aceptado más antiguo (con uno en camino y otro
   * en espera, el de espera aparece al entregar el primero); y si no hay activos,
   * el entregado en efectivo de hoy con el cobro pendiente. Un cobro pendiente
   * nunca tapa a un pedido activo. `null` si no tiene ninguno.
   */
  async findCurrentOfDriver(
    driverUserId: string,
    distributorId: string,
  ): Promise<OrderResponseDto | null> {
    const chofer = await this.deliveries.buscarPorIdOUsuario(driverUserId);
    if (!chofer) return null;
    const order = await this.orders.findCurrentOfDelivery(
      chofer.deliveryId,
      distributorId,
      inicioDelDiaArgentino(diaArgentino()) as Date,
    );
    return order ? OrderMapper.toDto(order) : null;
  }

  /**
   * Avanza el estado de un pedido. Delega en UpdateOrderStatusUseCase
   * (validación de transición + efectos de estado + side-effects de tiempo real).
   * `actorUserId` sale SIEMPRE del token: lo necesita el caso `status: cancelled`,
   * que delega en CancelOrderUseCase con la misma identidad que usa `/cancel`.
   */
  async updateStatus(
    id: string,
    status: OrderStatus,
    deliveryId?: string,
    role?: RoleType,
    actorUserId?: string,
    reason?: string,
  ) {
    return this.updateOrderStatusUseCase.execute(
      id,
      status,
      deliveryId,
      role,
      actorUserId,
      reason,
    );
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

    return {
      orderId: order.orderId,
      deliveryCode: order.deliveryCode,
      attempts: order.deliveryCodeAttempts,
      blocked: order.deliveryCodeAttempts >= MAX_INTENTOS_CODIGO_ENTREGA,
    };
  }

  /**
   * El chofer asignado (o un admin) genera un código de entrega nuevo cuando el
   * del pedido quedó bloqueado por intentos o se filtró: reemplaza al viejo y
   * vuelve los intentos a 0. Sólo con el pedido en camino.
   */
  async regenerateDeliveryCode(
    orderId: string,
    userId: string,
    role: RoleType,
  ) {
    const order = await this.findOne(orderId);
    await this.assertPedidoDelChofer(order, userId, role);
    if (order.status !== OrderStatus.ON_THE_WAY) {
      throw new ConflictException(
        'El código sólo se cambia con el pedido en camino',
      );
    }
    const deliveryCode = generateDeliveryCode();
    if (!(await this.orders.replaceDeliveryCode(order.orderId, deliveryCode))) {
      throw new ConflictException(
        'El código sólo se cambia con el pedido en camino',
      );
    }
    return {
      orderId: order.orderId,
      deliveryCode,
      attempts: 0,
      blocked: false,
    };
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
    reason?: string,
  ) {
    return this.confirmDeliveryUseCase.execute(
      orderId,
      code,
      userId,
      role,
      reason,
    );
  }

  /**
   * Asignación MANUAL del admin (`PATCH /orders/:id/assign/:deliveryId`).
   * Exige habilitado + validado y sin bloqueo de flota (CU-136 a CU-138),
   * igual que aceptar una oferta. NO exige que esté en línea: es un acto
   * explícito del admin, no una búsqueda por el radar.
   */
  async assignDelivery(
    orderId: string,
    deliveryId: string,
    distributorId?: string | null,
    opciones: { soloSiLibre?: boolean } = {},
  ) {
    const delivery = await this.deliveries.findById(deliveryId);
    if (!delivery) {
      throw new NotFoundException('Repartidor no encontrado');
    }

    // Segunda revisión, punto 2: mismo lock pesimista que cancelar/liberar
    // (`FOR UPDATE OF "ord"`, ver `CancelOrderUseCase`/`ReleaseOrderUseCase`)
    // — si el pedido se está cancelando en paralelo, esta asignación lo ve
    // DENTRO del lock (con el dato fresco) y `transitionOrder` corta con 400
    // en vez de pisar una cancelación ya confirmada.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let order: Order;
    let previousDriverUserId: string | null;
    let ofertasRetiradas: string[];
    try {
      const consulta = queryRunner.manager
        .createQueryBuilder(Order, 'ord')
        .setLock('pessimistic_write', undefined, ['ord'])
        .leftJoinAndSelect('ord.delivery', 'delivery')
        .where('ord.orderId = :id', { id: orderId });
      // Con distribuidora en contexto el lock no toma el pedido de otra: 404.
      if (distributorId) {
        consulta.andWhere('ord.distributorId = :distributorId', {
          distributorId,
        });
      }
      // Los renglones se leen DESPUÉS del lock y aparte: un SELECT con JOIN que
      // esperó el lock re-lee el pedido pero no los renglones que una edición
      // cambió en el medio (READ COMMITTED), y el `save` con cascade
      // desvincularía los renglones nuevos.
      const locked = await consulta.getOne();

      if (!locked) {
        throw new NotFoundException('Pedido no encontrado');
      }
      locked.items = await queryRunner.manager.find(OrderItem, {
        where: { orderId: locked.orderId },
      });
      // El chofer tiene que ser de la misma distribuidora que el pedido. Antes
      // que cualquier otro chequeo: lo ajeno es 404 sin revelar nada de su
      // habilitación ni de su flota.
      if (delivery.distributorId !== locked.distributorId) {
        throw new NotFoundException('Repartidor no encontrado');
      }
      // Con `soloSiLibre` (el lote de recorrido, M4) la asignación no le saca el
      // pedido a otro chofer ni a un admin que ya lo tomó: sólo asigna un pedido
      // pendiente y sin chofer, o repite la asignación al mismo chofer.
      if (opciones.soloSiLibre) {
        const libre =
          locked.status === OrderStatus.PENDING && !locked.deliveryId;
        const yaEsSuyo =
          locked.status === OrderStatus.ACCEPTED &&
          locked.deliveryId === delivery.deliveryId;
        if (!libre && !yaEsSuyo) {
          throw new ConflictException('El pedido ya no está disponible');
        }
      }
      // Repetir la asignación al MISMO chofer (reintento, doble clic) no
      // regenera el código de entrega: el QR que ya tiene el chofer sigue
      // sirviendo.
      if (
        locked.status === OrderStatus.ACCEPTED &&
        locked.deliveryId === delivery.deliveryId
      ) {
        order = locked;
        previousDriverUserId = null;
        ofertasRetiradas = [];
        await queryRunner.commitTransaction();
        return await this.releerAsignado(order);
      }
      // Un pedido de Mercado Pago no sale hasta que se apruebe el pago (salvo
      // la reserva con seña paga). Sólo en los estados que se asignan: uno
      // cerrado sigue respondiendo la transición inválida.
      if (
        (locked.status === OrderStatus.PENDING ||
          locked.status === OrderStatus.ACCEPTED) &&
        esperaPagoOnline(locked)
      ) {
        throw new ConflictException(mensajeDeEspera(locked));
      }
      this.deliveries.assertElegibleParaAsignacion(delivery);
      // Con el chofer bloqueado (el mismo lock que `ponerEnUso`, la baja y la
      // aceptación): el vehículo que se lee abajo no cambia hasta el commit,
      // y una baja que ganó la carrera se ve acá.
      if (
        !(await bloquearChoferVigente(queryRunner.manager, delivery.deliveryId))
      ) {
        throw new NotFoundException('Repartidor no encontrado');
      }
      await this.truckLoadGate.assertPuedeAsignar(
        locked.distributorId,
        delivery.deliveryId,
        queryRunner.manager,
      );
      // CU-136 a CU-138: mismo gate que usan `UpdateOrderStatusUseCase` y el
      // despacho automático. Si algo está vencido, 400 con el detalle.
      await this.fleetGate.assertChoferHabilitado(
        delivery.userId,
        locked.distributorId,
      );
      // Un pedido express (CU-149) sólo lo lleva un chofer con una moto en uso.
      if (locked.deliveryMode === OrderDeliveryMode.EXPRESS) {
        await this.fleetGate.assertEnMoto(
          delivery.userId,
          locked.distributorId,
        );
      }
      // Snapshot del vehículo en uso (decisión de nahue del 30/09): a esta
      // altura el chofer ya pasó el gate, así que si tiene vehículo, no viene
      // inhabilitado.
      const vehiculo = await this.fleetGate.vehiculoEnUsoDelChofer(
        delivery.userId,
        locked.distributorId,
      );
      locked.vehicleCarId = vehiculo?.carId ?? null;
      locked.vehiclePatent = vehiculo?.patent ?? null;
      locked.vehicleBrand = vehiculo?.brand ?? null;
      locked.vehicleModel = vehiculo?.model ?? null;

      // Punto 7: si se reasigna de un chofer A a otro B, A se tiene que
      // enterar (ver el aviso best-effort después del commit).
      previousDriverUserId = locked.delivery?.userId ?? null;

      locked.deliveryId = deliveryId;
      // `order.delivery` (la relación @ManyToOne) y `order.deliveryId` (la
      // columna) apuntan a la MISMA columna `delivery_id`. Si se reasigna de
      // un chofer A a otro B y sólo se pisa `deliveryId`, TypeORM prioriza el
      // valor de la relación —que el lock ya había cargado con A— al
      // guardar, y la columna real queda con A (verificado contra la base el
      // 30/09: mismo bug que `releaseDriverAssignment`, ver su comentario).
      // Las dos tienen que quedar en sincro.
      locked.delivery = delivery;
      transitionOrder(locked, OrderStatus.ACCEPTED);
      locked.acceptedAt = await ahoraDeLaBase(queryRunner.manager);
      // Igual que cuando el chofer acepta la oferta: sin este código el
      // cliente no puede confirmar la entrega con el QR. Si se reasigna, el
      // código nuevo deja sin efecto el del chofer anterior.
      locked.deliveryCode = generateDeliveryCode();

      order = await queryRunner.manager.save(locked);
      // Punto 5: la asignación a mano resuelve el pedido ella sola; cualquier
      // oferta automática en curso para OTRO chofer se retira en la misma
      // transacción, así no hay dos choferes creyendo que el pedido es suyo.
      ofertasRetiradas = await this.dispatchOffers.withdrawOtherActiveOffers(
        queryRunner.manager,
        orderId,
        delivery.userId,
        DispatchOfferStatus.SUPERSEDED,
      );
      await queryRunner.commitTransaction();
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }

    // Desde acá la asignación está confirmada: nada de lo que sigue puede tirar
    // el request (el reintento regeneraría el código y el QR del chofer).
    try {
      // Best-effort, DESPUÉS del commit.
      // A los choferes a quienes se les retiró la oferta se les avisa por el
      // mismo evento con que la app descarta una oferta que ya no está vigente.
      for (const driverUserId of ofertasRetiradas) {
        this.dispatch.notifyDriverOrderCancelled(driverUserId, {
          orderId: order.orderId,
          message: 'El pedido ya fue asignado: la oferta ya no está vigente',
        });
      }
      // El chofer asignado queda registrado como quien lo tuvo (ACCEPTED): si lo
      // libera, el despacho no se lo vuelve a ofrecer.
      await this.dispatchOrchestrator
        .onOrderAssigned(orderId, delivery.userId)
        .catch(() => undefined);

      // Punto 7: aviso al chofer anterior si hubo reasignación de A a B (por
      // `user_id`, nunca por `deliveryId`: son ids distintos — ver
      // `DriversGateway.handleDriverJoin`).
      if (previousDriverUserId && previousDriverUserId !== delivery.userId) {
        this.dispatch.stopTracking(previousDriverUserId);
        this.dispatch.notifyDriverOrderCancelled(previousDriverUserId, {
          orderId: order.orderId,
          status: order.status,
          message: 'Este pedido se reasignó a otro chofer.',
        });
      }

      this.dispatch.notifyAdmins(
        'order:accepted',
        {
          orderId: order.orderId,
          status: order.status,
          totalAmount: order.totalAmount,
        },
        order.distributorId,
      );
      // H-55: el despacho automático avisa al chofer por socket
      // (`server:new-order-request`, el mismo evento que ya escucha la app);
      // la asignación manual no avisaba nada, así que el chofer no se enteraba
      // hasta refrescar. Mismo evento, mismo payload que offerToNextDriver
      // (ver DispatchOrchestratorService): el chofer lo ve como una oferta y
      // puede "aceptarla" (no-op idempotente, ya está asignado). Si la rechaza
      // o deja vencer el aviso, el pedido NO se libera solo: queda igual
      // asignado y se avisa a los admins para que decidan (segunda revisión,
      // punto 1 — ver `OrderService.rejectOffer`).
      const { offerTtlSeconds } = await this.dispatchSettings.obtener(
        order.distributorId,
      );
      this.dispatch.notifyDriverNewOrder(delivery.userId, {
        event: 'NEW_ORDER',
        orderId: order.orderId,
        totalAmount: order.totalAmount,
        paymentMethod: order.paymentMethod,
        expiresAt: new Date(Date.now() + offerTtlSeconds * 1000).toISOString(),
        items: order.items,
        // Ya está asignado: la app lo abre como entrega, no como una oferta que se
        // acepta o se deja vencer. Las versiones viejas lo ignoran y siguen igual.
        assigned: true,
      });
    } catch (error) {
      this.logger.error(
        `Pedido ${orderId} asignado, pero falló un efecto posterior: ${errorMessage(error)}`,
      );
    }
    // Se relee para que la respuesta traiga el chofer nuevo, no el anterior.
    return this.releerAsignado(order);
  }

  /** El pedido releído; si la relectura falla, el recién asignado (ya confirmado). */
  private async releerAsignado(order: Order): Promise<Order> {
    try {
      return await this.findOne(order.orderId);
    } catch (error) {
      this.logger.error(
        `No se pudo releer el pedido ${order.orderId}: ${errorMessage(error)}`,
      );
      marcarRespuestaIncompleta();
      return order;
    }
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

    const hoy = diaArgentino();
    const today = inicioDelDiaArgentino(hoy) as Date;
    const tomorrow = inicioDelDiaArgentino(sumarDias(hoy, 1)) as Date;

    const inicioSemana = lunesDeLaSemana(hoy);
    const weekStart = inicioDelDiaArgentino(inicioSemana) as Date;
    const weekEnd = inicioDelDiaArgentino(sumarDias(inicioSemana, 7)) as Date;

    const monthStart = inicioDelDiaArgentino(primerDiaDelMes(hoy)) as Date;
    const monthEnd = inicioDelDiaArgentino(
      primerDiaDelMesSiguiente(hoy),
    ) as Date;

    const delivered = (from: Date, to: Date) => ({
      status: OrderStatus.DELIVERED,
      deliveredAt: And(MoreThanOrEqual(from), LessThan(to)),
      ...dist,
    });
    // Las ventas son lo entregado y COBRADO (ver `venta-cobrada.ts`).
    const cobrado = (from: Date, to: Date) =>
      ventaCobradaWhere(delivered(from, to));

    const [
      todaySales,
      weekSales,
      monthSales,
      totalSales,
      deliveredToday,
      cobradosHoy,
      pending,
      accepted,
      onTheWay,
      activeDeliveries,
      enabledDeliveries,
      cash,
      mercadopago,
    ] = await Promise.all([
      this.orderRepository.sum('totalAmount', cobrado(today, tomorrow)),
      this.orderRepository.sum('totalAmount', cobrado(weekStart, weekEnd)),
      this.orderRepository.sum('totalAmount', cobrado(monthStart, monthEnd)),
      this.orderRepository.sum(
        'totalAmount',
        ventaCobradaWhere({ status: OrderStatus.DELIVERED, ...dist }),
      ),
      this.orderRepository.count({ where: delivered(today, tomorrow) }),
      this.orderRepository.count({ where: cobrado(today, tomorrow) }),
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
        avgOrderValue: cobradosHoy > 0 ? todaySalesN / cobradosHoy : 0,
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

    return this.notificarLlegada(order);
  }

  /**
   * V2: controla la cercanía al destino antes de avisar al cliente.
   *
   * Orden: pedido de la distribuidora (404, en el controller) → existe (404) →
   * es del chofer (403) → en camino (409) → ya avisado (200 sin re-notificar)
   * → dentro del radio (409 `ARRIVAL_TOO_FAR`) → aviso.
   *
   * Un solo aviso, pero que llegue: el primer aviso deja una marca en Redis por
   * pedido y chofer y los toques siguientes responden lo mismo sin volver a
   * notificar. La marca sólo queda si el push salió: si no salió (FCM falló o
   * no confirmó, o el cliente no tiene token) se borra y el próximo toque
   * vuelve a avisar. Cada operación de la marca tiene un tope corto; si Redis
   * no responde a tiempo se avisa igual.
   */
  async notifyDriverArrivedWithDistance(
    orderId: string,
    userId: string,
    role: RoleType,
    latitude: number,
    longitude: number,
  ) {
    const order = await this.findOne(orderId);
    await this.assertPedidoDelChofer(order, userId, role);

    if (order.status !== OrderStatus.ON_THE_WAY) {
      throw new ConflictException({
        statusCode: 409,
        message: 'El pedido debe estar en camino para avisar llegada',
        error: 'Conflict',
        code: 'ORDER_NOT_ON_THE_WAY',
      });
    }

    const marca = `order:arrived:${order.orderId}:${order.deliveryId ?? ''}`;
    if ((await this.leerMarca(marca)) === MARCA_ENVIADO) {
      return { ...AVISO_DE_LLEGADA };
    }

    const { arrivalRadiusMeters } = await this.dispatchSettings.obtener(
      order.distributorId,
    );
    const destino = order.deliveryPoint ?? order.address?.location ?? null;
    if (arrivalRadiusMeters > 0 && destino) {
      const [destinoLongitude, destinoLatitude] = destino.coordinates;
      // Se compara la distancia real; sólo la respuesta va redondeada.
      const distancia = this.distanciaEnMetros(
        latitude,
        longitude,
        destinoLatitude,
        destinoLongitude,
      );
      if (distancia > arrivalRadiusMeters) {
        const distanceMeters = Math.round(distancia);
        throw new ConflictException({
          statusCode: 409,
          message: `Todavía estás a ${distanceMeters} m del domicilio. Marcá «Llegué» cuando estés en la puerta.`,
          error: 'Conflict',
          code: 'ARRIVAL_TOO_FAR',
          distanceMeters,
          radiusMeters: arrivalRadiusMeters,
        });
      }
    } else if (arrivalRadiusMeters > 0) {
      this.logger.warn(
        `Pedido ${order.orderId}: se permite marcar llegada sin controlar distancia porque no tiene ubicación de entrega`,
      );
    }

    // Un solo aviso, pero que llegue: el turno de avisar se toma con SET NX
    // («enviando», TTL corto). El que encuentra a otro enviando espera a ver
    // si salió (→ no avisa) o si la marca se borró porque falló (→ avisa él).
    const turno = await this.tomarTurnoDeAviso(marca);
    if (turno === 'ya_salio') return { ...AVISO_DE_LLEGADA };

    let push: PushDeLlegada = 'failed';
    try {
      push = await this.avisarLlegada(order);
    } finally {
      if (push === 'sent') {
        await this.conTope(
          this.redis.setex(marca, ARRIVAL_MARK_TTL_SECONDS, MARCA_ENVIADO),
          undefined,
          `guardar ${marca}`,
        );
      } else {
        this.logger.warn(
          `Pedido ${order.orderId}: el push de llegada no salió (${push}); el próximo «Llegué» vuelve a avisar`,
        );
        // Sólo se borra la marca propia: si se avisó sin turno (Redis no
        // respondió o se agotó la espera) la marca es de otro.
        if (turno === 'mio') {
          await this.conTope(
            this.redis.del(marca),
            undefined,
            `borrar ${marca}`,
          );
        }
      }
    }
    return { ...AVISO_DE_LLEGADA };
  }

  private leerMarca(marca: string): Promise<string | null> {
    return this.conTope(this.redis.get(marca), null, `leer ${marca}`);
  }

  /**
   * - `mio`: tomó la marca «enviando» (o Redis no responde: fail-open).
   * - `ya_salio`: otro toque ya avisó y el push salió.
   * - `sin_turno`: otro está enviando y no se resolvió dentro de la espera;
   *   se avisa igual (mejor un aviso de más que ninguno).
   */
  private async tomarTurnoDeAviso(
    marca: string,
  ): Promise<'mio' | 'ya_salio' | 'sin_turno'> {
    const limite = Date.now() + ARRIVAL_WAIT_MAX_MS;
    for (;;) {
      const tomada = await this.conTope(
        this.redis.setIfAbsent(marca, ARRIVAL_SENDING_TTL_SECONDS),
        true,
        `tomar ${marca}`,
      );
      if (tomada) return 'mio';
      const estado = await this.leerMarca(marca);
      if (estado === MARCA_ENVIADO) return 'ya_salio';
      if (Date.now() >= limite) {
        this.logger.warn(
          `${marca}: otro aviso sigue enviándose tras ${ARRIVAL_WAIT_MAX_MS} ms; se avisa igual`,
        );
        return 'sin_turno';
      }
      // «enviando»: se espera; null: se borró (el otro falló) y se reintenta
      // tomarla en la vuelta siguiente.
      await new Promise((r) => setTimeout(r, ARRIVAL_WAIT_STEP_MS));
    }
  }

  /**
   * Una operación de Redis del «Llegué» con tope: con Redis desconectado
   * ioredis encola el comando y la promesa puede tardar mucho. Si falla o no
   * responde en `ARRIVAL_MARK_TIMEOUT_MS`, devuelve `siFalla` (el aviso sigue).
   */
  private async conTope<T>(
    operacion: Promise<T>,
    siFalla: T,
    que: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const vencido = new Promise<'vencido'>((resolve) => {
      timer = setTimeout(() => resolve('vencido'), ARRIVAL_MARK_TIMEOUT_MS);
    });
    try {
      const r = await Promise.race([operacion, vencido]);
      if (r === 'vencido') {
        this.logger.warn(
          `Redis no respondió en ${ARRIVAL_MARK_TIMEOUT_MS} ms al ${que}: se sigue`,
        );
        operacion.catch(() => undefined);
        return siFalla;
      }
      return r;
    } catch (error) {
      this.logger.warn(`No se pudo ${que}: ${String(error)}`);
      return siFalla;
    } finally {
      clearTimeout(timer);
    }
  }

  private distanciaEnMetros(
    latitudeA: number,
    longitudeA: number,
    latitudeB: number,
    longitudeB: number,
  ): number {
    const aRad = (latitudeA * Math.PI) / 180;
    const bRad = (latitudeB * Math.PI) / 180;
    const deltaLatitud = ((latitudeB - latitudeA) * Math.PI) / 180;
    const deltaLongitud = ((longitudeB - longitudeA) * Math.PI) / 180;
    const senoLatitud = Math.sin(deltaLatitud / 2);
    const senoLongitud = Math.sin(deltaLongitud / 2);
    const h =
      senoLatitud * senoLatitud +
      Math.cos(aRad) * Math.cos(bRad) * senoLongitud * senoLongitud;
    return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  private async notificarLlegada(order: Order) {
    await this.avisarLlegada(order);
    return { ...AVISO_DE_LLEGADA };
  }

  /** Socket + push al cliente; devuelve si el push salió. */
  private async avisarLlegada(order: Order): Promise<PushDeLlegada> {
    const driverName = order.delivery?.user?.fullName || 'El repartidor';

    this.dispatch.notifyCustomer(order.customerId, 'order:arrived', {
      orderId: order.orderId,
      message: '👋 ¡El repartidor está afuera!',
      driverName,
    });

    // Push además del socket: si el cliente tiene la app cerrada el socket no
    // le llega. Nunca lanza; devuelve si salió.
    return this.notifications.sendArrivalPushToCustomer(
      order.customerId,
      order.orderId,
      driverName,
    );
  }

  /**
   * Ventas de los últimos 7 días para el gráfico del dashboard. Scopeado por
   * distribuidora, en UNA sola query agregada (date_trunc + GROUP BY) en vez de
   * 7 queries secuenciales.
   */
  async getSalesChartData(distributorId?: string | null) {
    const hoy = diaArgentino();
    const start = inicioDelDiaArgentino(sumarDias(hoy, -6)) as Date;
    const end = inicioDelDiaArgentino(sumarDias(hoy, 1)) as Date;

    const qb = this.orderRepository
      .createQueryBuilder('order')
      .select(truncarEnArgentinaSql('day', 'order.deliveredAt'), 'day')
      .addSelect('SUM(order.totalAmount)', 'total')
      .where('order.status = :status', { status: OrderStatus.DELIVERED })
      .andWhere('order.deliveredAt >= :start AND order.deliveredAt < :end', {
        start,
        end,
      });
    soloVentaCobrada(qb, 'order');

    if (distributorId) {
      qb.andWhere('order.distributorId = :distributorId', { distributorId });
    }

    const rows = await qb
      .groupBy('day')
      .getRawMany<{ day: Date | string; total: string | null }>();

    // Mapa día(YYYY-MM-DD) → total, para rellenar los días sin ventas con 0.
    const byDay = new Map<string, number>();
    for (const r of rows) {
      byDay.set(diaArgentino(new Date(r.day)), Number(r.total) || 0);
    }

    const chartData: { name: string; date: string; sales: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const key = sumarDias(hoy, -i);
      const dayName = new Date(`${key}T12:00:00Z`).toLocaleDateString('es-ES', {
        weekday: 'short',
        timeZone: 'UTC',
      });
      chartData.push({
        name: dayName.charAt(0).toUpperCase() + dayName.slice(1),
        date: key,
        sales: byDay.get(key) ?? 0,
      });
    }

    return chartData;
  }
}
