import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { normalizarSerial } from './dto/serial-de-envase';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Brackets, EntityManager, Repository } from 'typeorm';
import { Cylinder, CylinderState } from './entities/cylinder.entity';
import { CylinderMovement } from './entities/cylinder-movement.entity';
import { CreateCylinderDto } from './dto/create-cylinder.dto';
import { TransitionCylinderDto } from './dto/transition-cylinder.dto';
import { UpdateCylinderDto } from './dto/update-cylinder.dto';
import { assertTransition } from './domain/cylinder-state.machine';
import {
  EstadoDeVigencia,
  FiltroDeVigencia,
  estaVencido,
} from './domain/cylinder-vigencia';
import { EnvasesVencidosException } from './cylinder-vencido.exception';
import {
  DespachoBloqueadoEvent,
  EVENTO_DESPACHO_BLOQUEADO,
} from './events/despacho-bloqueado.event';
import {
  OrderDespachoRef,
  OrderLookupService,
} from '../order/lookup/order-lookup.service';
import { GasCylinderService } from '../gascylinder/gascylinder.service';
import { DeliveryService } from '../delivery/delivery.service';
import { OrderStatus } from '../order/entities/order.entity';
import { RoleType } from '../common/constants/role-type.enum';
import { errorCode } from '../common/errors/error-message';

/** Filtros del listado de envases. */
export interface FiltrosDeEnvases {
  state?: CylinderState;
  orderId?: string;
  /** user_id del cliente. */
  customerUserId?: string;
  gasCylinderId?: string;
  /** Vigencia de la revisión (CU-135 paso 5: buscar un reemplazo). */
  vigencia?: FiltroDeVigencia;
  /** Sin `limit` no pagina. */
  limit?: number;
  offset?: number;
}

/** Pedidos a los que todavía se les pueden cargar envases en el camión. */
const PEDIDO_DESPACHABLE: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.PENDING,
  OrderStatus.ACCEPTED,
  OrderStatus.ON_THE_WAY,
]);

const ESTADO_DEL_PEDIDO: Readonly<Record<OrderStatus, string>> = {
  [OrderStatus.RESERVED]: 'reservado a futuro',
  [OrderStatus.PENDING]: 'pendiente',
  [OrderStatus.ACCEPTED]: 'aceptado',
  [OrderStatus.ON_THE_WAY]: 'en camino',
  [OrderStatus.DELIVERED]: 'entregado',
  [OrderStatus.CANCELLED]: 'cancelado',
};

/** Lo que el panel muestra de cada envase: de qué producto es y quién lo tiene. */
const CON_PRODUCTO_Y_CLIENTE = ['gasCylinder', 'currentCustomer'];

/** Serial en su forma canónica (recortado, en mayúsculas); vacío no es válido. */
function serialNormalizado(serial: string): string {
  const normalizado = normalizarSerial(serial);
  if (normalizado.trim() === '') {
    throw new BadRequestException('El serial no puede estar vacío');
  }
  return normalizado;
}

@Injectable()
export class CylinderService {
  constructor(
    @InjectRepository(Cylinder)
    private readonly cylinderRepository: Repository<Cylinder>,
    @InjectRepository(CylinderMovement)
    private readonly movementRepository: Repository<CylinderMovement>,
    private readonly orders: OrderLookupService,
    private readonly gasCylinders: GasCylinderService,
    private readonly eventos: EventEmitter2,
    private readonly deliveries: DeliveryService,
  ) {}

  /**
   * Da de alta un envase físico en IN_DEPOT. El serial es único por
   * distribuidora: dos empresas pueden tener envases con el mismo serial de
   * fábrica, por eso el índice único es compuesto (distributor_id, serial).
   */
  async create(
    dto: CreateCylinderDto,
    distributorId: string,
  ): Promise<Cylinder> {
    // El producto tiene que existir y ser de la misma distribuidora (404).
    if (dto.gasCylinderId) {
      await this.gasCylinders.findOne(dto.gasCylinderId, distributorId);
    }
    const cylinder = this.cylinderRepository.create({
      distributorId,
      serial: serialNormalizado(dto.serial),
      gasCylinderId: dto.gasCylinderId ?? null,
      deposit: dto.deposit ?? 0,
      state: CylinderState.IN_DEPOT,
    });

    let saved: Cylinder;
    try {
      saved = await this.cylinderRepository.save(cylinder);
    } catch (error) {
      if (errorCode(error) === '23505') {
        throw new ConflictException('El serial ya existe en tu distribuidora');
      }
      throw error;
    }

    await this.movementRepository.save(
      this.movementRepository.create({
        cylinderId: saved.cylinderId,
        distributorId,
        fromState: null,
        toState: CylinderState.IN_DEPOT,
      }),
    );

    return saved;
  }

  /**
   * Lista los envases, scopeados por tenant si se pasa distributorId.
   *
   * Filtros (se combinan con AND):
   *  - `state`: estado físico actual.
   *  - `customerUserId`: id de usuario del cliente; los envases que tiene HOY en su
   *    poder (`current_customer_id`).
   *  - `orderId`: los envases que salieron en ese pedido: los que lo tienen como
   *    `current_order_id` o que registraron algún movimiento con ese `order_id`.
   *    El movimiento es append-only, así que un pedido ya entregado (o cuyo
   *    envase ya volvió vacío o se reasignó a otro pedido) sigue mostrando sus
   *    series.
   *
   * Cada envase trae `lastMovementAt`: la fecha de su último movimiento.
   * Devuelve la página y el total sin paginar.
   */
  async findAll(
    distributorId?: string | null,
    filtros: FiltrosDeEnvases = {},
  ): Promise<[Cylinder[], number]> {
    const {
      state,
      orderId,
      customerUserId,
      gasCylinderId,
      vigencia,
      limit,
      offset,
    } = filtros;
    const qb = this.cylinderRepository
      .createQueryBuilder('cylinder')
      .leftJoinAndSelect('cylinder.gasCylinder', 'gasCylinder')
      .leftJoinAndSelect('cylinder.currentCustomer', 'currentCustomer')
      .addSelect(
        `(SELECT MAX(ult."createdAt") FROM cylinder_movement ult ` +
          `WHERE ult.cylinder_id = cylinder.cylinder_id)`,
        'ultimo_movimiento',
      )
      .orderBy('cylinder.createdAt', 'DESC')
      .addOrderBy('cylinder.cylinderId', 'ASC');

    if (distributorId) {
      qb.andWhere('cylinder.distributorId = :distributorId', { distributorId });
    }
    if (state) qb.andWhere('cylinder.state = :state', { state });
    if (customerUserId) {
      qb.andWhere('cylinder.currentCustomerId = :customerUserId', {
        customerUserId,
      });
    }
    if (gasCylinderId) {
      qb.andWhere('cylinder.gasCylinderId = :gasCylinderId', { gasCylinderId });
    }
    // El mismo reloj (el de Node) que usa el bloqueo del despacho.
    const ahora = new Date();
    if (vigencia === EstadoDeVigencia.VIGENTE) {
      qb.andWhere('cylinder.expiresAt > :ahora', { ahora });
    } else if (vigencia === EstadoDeVigencia.VENCIDO) {
      qb.andWhere('cylinder.expiresAt <= :ahora', { ahora });
    } else if (vigencia === EstadoDeVigencia.SIN_ACREDITAR) {
      qb.andWhere('cylinder.expiresAt IS NULL');
    } else if (vigencia === 'dispatchable') {
      qb.andWhere(
        '(cylinder.expiresAt IS NULL OR cylinder.expiresAt > :ahora)',
        { ahora },
      );
    }
    if (orderId) {
      qb.andWhere(
        new Brackets((b) => {
          b.where('cylinder.currentOrderId = :orderId').orWhere(
            `EXISTS (SELECT 1 FROM cylinder_movement mov ` +
              `WHERE mov.cylinder_id = cylinder.cylinder_id ` +
              `AND mov.order_id = :orderId)`,
          );
        }),
        { orderId },
      );
    }

    const total = await qb.getCount();
    // Las uniones son many-to-one: limit/offset (no take/skip) mantienen una
    // fila por envase y alineadas las filas crudas con las entidades.
    if (limit !== undefined) qb.limit(limit).offset(offset ?? 0);

    const { entities, raw } = await qb.getRawAndEntities<{
      cylinder_cylinder_id: string;
      ultimo_movimiento: Date | string | null;
    }>();
    const ultimoPorEnvase = new Map(
      raw.map((r) => [r.cylinder_cylinder_id, r.ultimo_movimiento]),
    );
    for (const cylinder of entities) {
      const fecha = ultimoPorEnvase.get(cylinder.cylinderId);
      cylinder.lastMovementAt = fecha ? new Date(fecha) : null;
    }
    return [entities, total];
  }

  /** Busca un envase por id, scopeado por tenant si se pasa distributorId. */
  async findOne(id: string, distributorId?: string | null): Promise<Cylinder> {
    const cylinder = await this.cylinderRepository.findOne({
      where: {
        cylinderId: id,
        ...(distributorId ? { distributorId } : {}),
      },
      relations: CON_PRODUCTO_Y_CLIENTE,
    });
    if (!cylinder) {
      throw new NotFoundException('Envase no encontrado');
    }
    return cylinder;
  }

  /** Busca un envase por su serial, scopeado por tenant. */
  async findBySerial(serial: string, distributorId: string): Promise<Cylinder> {
    const cylinder = await this.cylinderRepository.findOne({
      where: { serial: normalizarSerial(serial), distributorId },
    });
    if (!cylinder) {
      throw new NotFoundException('Envase no encontrado');
    }
    return cylinder;
  }

  /**
   * Ejecuta una transición de estado válida sobre el envase, registrando la
   * auditoría en `CylinderMovement`. Efectos secundarios sobre
   * `current_customer_id`:
   *  - WITH_CUSTOMER: se toma el `customer_id` del pedido (si viene orderId).
   *  - EMPTY_RETURNED / IN_DEPOT: se limpia (el envase ya no está con nadie).
   * y sobre `current_order_id`:
   *  - DISPATCHED / WITH_CUSTOMER: queda el pedido de la transición.
   *  - IN_DEPOT / RETIRED: se limpia (el envase vuelve a estar libre).
   *  - EMPTY_RETURNED: conserva el pedido con el que salió.
   *
   * Con `orderId` el pedido tiene que ser de la distribuidora y, si actúa un
   * chofer, suyo (404). Despachar exige además un pedido despachable (409), el
   * mismo control que `assignToOrder`.
   */
  async transition(
    id: string,
    dto: TransitionCylinderDto,
    distributorId: string,
    actorUserId?: string,
    role?: RoleType,
  ): Promise<Cylinder> {
    if (dto.toState === CylinderState.RETIRED) {
      throw new BadRequestException(
        'La baja del envase va por PATCH /cylinders/:id/retire, con motivo',
      );
    }

    if (dto.toState === CylinderState.WITH_CUSTOMER && !dto.orderId) {
      throw new BadRequestException(
        'Entregar el envase al cliente (with_customer) requiere indicar el pedido (orderId)',
      );
    }

    const propio =
      role === RoleType.DELIVERY && actorUserId
        ? await this.deliveries.buscarPorIdOUsuario(actorUserId)
        : null;

    // Orden de locks igual al de la confirmación de la entrega: primero el/los
    // pedidos (FOR SHARE, en orden de id) y después el envase. Con el pedido
    // bloqueado una entrega o reasignación concurrente espera y la validación
    // de estado y dueño vale hasta el commit.
    try {
      await this.cylinderRepository.manager.transaction(async (manager) => {
        const visto = await manager.getRepository(Cylinder).findOne({
          where: { cylinderId: id, distributorId },
          select: { cylinderId: true, currentOrderId: true },
        });
        if (!visto) throw new NotFoundException('Envase no encontrado');

        const ids = [
          ...new Set(
            [dto.orderId, visto.currentOrderId].filter((v): v is string => !!v),
          ),
        ].sort();
        const pedidos = new Map<string, OrderDespachoRef>();
        for (const orderId of ids) {
          // El pedido tiene que ser de la misma distribuidora que el envase (H-90).
          const pedido = await this.orders.findParaDespacho(
            orderId,
            distributorId,
            manager,
          );
          if (pedido) pedidos.set(orderId, pedido);
        }
        const cylinder = await this.bloquear(manager, id, distributorId);
        if (cylinder.currentOrderId !== visto.currentOrderId) {
          throw new ConflictException(
            'El envase cambió de pedido mientras se procesaba: reintentá',
          );
        }

        const pedido = dto.orderId ? pedidos.get(dto.orderId) : undefined;
        if (dto.orderId && !pedido) {
          throw new NotFoundException('Pedido no encontrado');
        }
        if (role === RoleType.DELIVERY) {
          this.asegurarEnvaseDelChofer(
            cylinder,
            dto.orderId,
            pedidos,
            propio?.deliveryId ?? null,
          );
        }
        if (pedido) {
          // Un chofer sólo mueve envases en el contexto de sus propios pedidos.
          this.asegurarPedidoDelChoferYa(
            pedido,
            propio?.deliveryId ?? null,
            role,
          );
          if (dto.toState === CylinderState.DISPATCHED) {
            this.asegurarPedidoDespachable(pedido);
          }
        }
        await this.recordTransition(
          cylinder,
          dto.toState,
          {
            orderId: dto.orderId,
            actorUserId,
            note: dto.note,
            customerId:
              dto.toState === CylinderState.WITH_CUSTOMER
                ? (pedido?.customerId ?? null)
                : null,
          },
          manager,
        );
      });
    } catch (error) {
      this.avisarSiHayVencidos(error, distributorId, dto.orderId ?? null);
      throw error;
    }
    return this.findOne(id, distributorId);
  }

  /** Lee el envase de la distribuidora con lock pesimista (`FOR UPDATE`). */
  private async bloquear(
    manager: EntityManager,
    id: string,
    distributorId: string,
  ): Promise<Cylinder> {
    const cylinder = await manager
      .createQueryBuilder(Cylinder, 'cylinder')
      .setLock('pessimistic_write')
      .where('cylinder.cylinderId = :id', { id })
      .andWhere('cylinder.distributorId = :distributorId', { distributorId })
      .getOne();
    if (!cylinder) throw new NotFoundException('Envase no encontrado');
    return cylinder;
  }

  /**
   * Edita los datos maestros del envase (serial, producto, depósito, fechas).
   * El estado no se toca. Un envase dado de baja ya no se edita.
   */
  async update(
    id: string,
    dto: UpdateCylinderDto,
    distributorId: string,
  ): Promise<Cylinder> {
    if (dto.gasCylinderId) {
      await this.gasCylinders.findOne(dto.gasCylinderId, distributorId);
    }
    try {
      await this.cylinderRepository.manager.transaction(async (manager) => {
        const cylinder = await this.bloquear(manager, id, distributorId);
        if (cylinder.state === CylinderState.RETIRED) {
          throw new ConflictException(
            'El envase está dado de baja y no se edita',
          );
        }
        if (
          dto.manufacturedAt !== undefined &&
          cylinder.expiresAt &&
          dto.manufacturedAt.getTime() > cylinder.expiresAt.getTime()
        ) {
          throw new BadRequestException(
            'La fecha de fabricación no puede ser posterior al vencimiento del envase',
          );
        }
        Object.assign(cylinder, {
          ...(dto.serial !== undefined && {
            serial: serialNormalizado(dto.serial),
          }),
          ...(dto.gasCylinderId !== undefined && {
            gasCylinderId: dto.gasCylinderId,
          }),
          ...(dto.deposit !== undefined && { deposit: dto.deposit }),
          ...(dto.manufacturedAt !== undefined && {
            manufacturedAt: dto.manufacturedAt,
          }),
        });
        await manager.save(cylinder);
      });
    } catch (error) {
      if (errorCode(error) === '23505') {
        throw new ConflictException('El serial ya existe en tu distribuidora');
      }
      throw error;
    }
    return this.findOne(id, distributorId);
  }

  /**
   * Da de baja el envase (estado terminal RETIRED). Sólo desde IN_DEPOT o
   * EMPTY_RETURNED, lo valida la máquina de estados. El motivo queda en el
   * movimiento. El registro no se borra.
   */
  async retire(
    id: string,
    reason: string,
    distributorId: string,
    actorUserId?: string,
  ): Promise<Cylinder> {
    await this.cylinderRepository.manager.transaction(async (manager) => {
      const cylinder = await this.bloquear(manager, id, distributorId);
      await this.recordTransition(
        cylinder,
        CylinderState.RETIRED,
        { actorUserId, note: `Baja: ${reason}` },
        manager,
      );
    });
    return this.findOne(id, distributorId);
  }

  /**
   * Asigna una lista de envases (por serial) a un pedido y los despacha
   * (FILLED → DISPATCHED). Se usa cuando el chofer/admin carga en el camión los
   * envases que salen a repartir para ese pedido. Deja `current_order_id` para
   * que, al confirmar la entrega, `onOrderDelivered` los avance solo.
   *
   * Es atómica: con los envases bloqueados se valida todo antes de escribir y
   * una falla en cualquiera deja a todos como estaban. Un envase con la
   * revisión vencida rechaza la asignación completa (409 con la lista de
   * seriales, CU-135); uno sin vencimiento cargado pasa y queda anotado. Si
   * algún envase no está FILLED, la transición es inválida y lanza 400.
   *
   * El pedido tiene que admitir la carga (pendiente, aceptado o en camino): uno
   * entregado, cancelado o reservado a futuro es 409. Un chofer sólo carga a
   * pedidos que tiene asignados; uno ajeno o sin chofer no existe para él (404),
   * el mismo criterio que el resto de las operaciones del chofer sobre pedidos.
   */
  async assignToOrder(
    orderId: string,
    serials: string[],
    distributorId: string,
    actorUserId?: string,
    role?: RoleType,
  ): Promise<Cylinder[]> {
    if (new Set(serials).size !== serials.length) {
      throw new BadRequestException('Hay seriales repetidos');
    }
    const propio =
      role === RoleType.DELIVERY && actorUserId
        ? await this.deliveries.buscarPorIdOUsuario(actorUserId)
        : null;

    try {
      return await this.cylinderRepository.manager.transaction(
        async (manager) => {
          // Primero el pedido, bloqueado (mismo orden que la confirmación de la
          // entrega: pedido y después envases), y sólo uno de la misma
          // distribuidora (H-90).
          const order = await this.orders.findParaDespacho(
            orderId,
            distributorId,
            manager,
          );
          if (!order) throw new NotFoundException('Pedido no encontrado');
          this.asegurarPedidoDelChoferYa(
            order,
            propio?.deliveryId ?? null,
            role,
          );
          this.asegurarPedidoDespachable(order);
          const cylinders = await this.bloquearPorSerial(
            manager,
            serials,
            distributorId,
          );
          // Primero la máquina de estados (400): un despacho inválido no es
          // un bloqueo por vencimiento.
          for (const cylinder of cylinders) {
            assertTransition(cylinder.state, CylinderState.DISPATCHED);
          }
          const ahora = new Date();
          const vencidos = cylinders
            .filter((c) => estaVencido(c.expiresAt, ahora))
            .map((c) => c.serial);
          if (vencidos.length > 0) throw new EnvasesVencidosException(vencidos);

          const assigned: Cylinder[] = [];
          for (const cylinder of cylinders) {
            const sinFecha = cylinder.expiresAt === null;
            assigned.push(
              await this.recordTransition(
                cylinder,
                CylinderState.DISPATCHED,
                {
                  orderId,
                  actorUserId,
                  note:
                    `Asignado al pedido ${orderId}` +
                    (sinFecha ? ' (sin revisión registrada)' : ''),
                },
                manager,
              ),
            );
          }
          return assigned;
        },
      );
    } catch (error) {
      this.avisarSiHayVencidos(error, distributorId, orderId);
      throw error;
    }
  }

  /** Un chofer sólo opera sobre pedidos asignados a él: el ajeno no existe para él (404). */
  private asegurarPedidoDelChoferYa(
    order: OrderDespachoRef,
    deliveryId: string | null,
    role?: RoleType,
  ): void {
    if (role !== RoleType.DELIVERY) return;
    if (!deliveryId || order.deliveryId !== deliveryId) {
      throw new NotFoundException('Pedido no encontrado');
    }
  }

  /**
   * Reglas del chofer sobre un envase, con el envase y los pedidos bloqueados:
   *  - si el envase ya está atado a un pedido, ese pedido tiene que ser suyo
   *    (si no, el envase no existe para él: 404) y un `orderId` distinto es 409;
   *  - un envase sin pedido sólo se mueve en el contexto de un pedido suyo
   *    (`orderId`); las tareas de depósito son del admin (403).
   */
  private asegurarEnvaseDelChofer(
    cylinder: Cylinder,
    orderId: string | undefined,
    pedidos: Map<string, OrderDespachoRef>,
    deliveryId: string | null,
  ): void {
    if (cylinder.currentOrderId) {
      const actual = pedidos.get(cylinder.currentOrderId);
      if (!deliveryId || !actual || actual.deliveryId !== deliveryId) {
        throw new NotFoundException('Envase no encontrado');
      }
      if (orderId && orderId !== cylinder.currentOrderId) {
        throw new ConflictException(
          'El envase está asignado a otro pedido: no coincide con el pedido indicado',
        );
      }
    } else if (!orderId) {
      throw new ForbiddenException(
        'Un chofer mueve envases sólo en el contexto de uno de sus pedidos (orderId)',
      );
    }
  }

  /** Sólo se cargan envases a pedidos pendientes, aceptados o en camino (409). */
  private asegurarPedidoDespachable(order: OrderDespachoRef): void {
    if (!PEDIDO_DESPACHABLE.has(order.status)) {
      throw new ConflictException(
        `El pedido está ${ESTADO_DEL_PEDIDO[order.status]}: no se le pueden asignar envases`,
      );
    }
  }

  /** Un despacho rechazado por vencimiento se avisa al panel; el rechazo no depende del aviso. */
  private avisarSiHayVencidos(
    error: unknown,
    distributorId: string,
    orderId: string | null,
  ): void {
    if (!(error instanceof EnvasesVencidosException)) return;
    this.eventos.emit(
      EVENTO_DESPACHO_BLOQUEADO,
      new DespachoBloqueadoEvent(distributorId, orderId, error.serials),
    );
  }

  /**
   * Bloquea los envases de la distribuidora, en el orden pedido. Si alguno no
   * existe o es de otra distribuidora, 404 sin revelar cuál.
   */
  private async bloquearPorSerial(
    manager: EntityManager,
    serials: string[],
    distributorId: string,
  ): Promise<Cylinder[]> {
    // La búsqueda compara la forma canónica en SQL (`upper(btrim(serial))`, la
    // del índice `UQ_cylinder_serial_normalizado`): un envase guardado como
    // `sn-1 ` se encuentra con `SN-1` aunque la fila no se haya normalizado.
    const canonicos = serials.map(normalizarSerial);
    // Orden fijo por serial: dos asignaciones cruzadas no se bloquean entre sí.
    const encontrados = await manager
      .createQueryBuilder(Cylinder, 'cylinder')
      .setLock('pessimistic_write')
      .where(
        'upper(btrim(cylinder.serial)) IN (SELECT upper(btrim(s)) FROM unnest(CAST(:serials AS text[])) AS s)',
        { serials: serials },
      )
      .andWhere('cylinder.distributorId = :distributorId', { distributorId })
      .orderBy('upper(btrim(cylinder.serial))', 'ASC')
      .addOrderBy('cylinder.cylinderId', 'ASC')
      .getMany();
    if (encontrados.length !== serials.length) {
      throw new NotFoundException('Envase no encontrado');
    }
    const porSerial = new Map(
      encontrados.map((c) => [normalizarSerial(c.serial), c]),
    );
    // Seriales únicos y todos encontrados: cada uno está en el mapa.
    return canonicos.map((serial) => porSerial.get(serial) as Cylinder);
  }

  /**
   * Hook del ciclo de vida del pedido: al pasar el pedido a DELIVERED, avanza
   * todos los envases despachados en ese pedido (DISPATCHED → WITH_CUSTOMER) y
   * los deja a nombre del cliente. Idempotente y no-op si no hay envases
   * asignados (distribuidoras que no usan el módulo de envases no se ven
   * afectadas). Devuelve cuántos envases avanzó.
   */
  async onOrderDelivered(
    orderId: string,
    distributorId?: string | null,
    manager?: EntityManager,
  ): Promise<number> {
    if (!manager) {
      return this.cylinderRepository.manager.transaction((m) =>
        this.onOrderDelivered(orderId, distributorId, m),
      );
    }
    // Se relee con el envase bloqueado: entre la lectura y el guardado alguien
    // pudo devolverlo al depósito o despacharlo a otro pedido, y guardar la
    // entidad vieja lo pisaría.
    const consulta = manager
      .createQueryBuilder(Cylinder, 'cylinder')
      .setLock('pessimistic_write')
      .where('cylinder.currentOrderId = :orderId', { orderId })
      .andWhere('cylinder.state = :state', { state: CylinderState.DISPATCHED });
    if (distributorId) {
      consulta.andWhere('cylinder.distributorId = :distributorId', {
        distributorId,
      });
    }
    const cylinders = await consulta
      .orderBy('cylinder.serial', 'ASC')
      .getMany();
    if (cylinders.length === 0) return 0;

    const order = await this.orders.findRef(orderId, distributorId);
    const customerId = order?.customerId ?? null;

    for (const cylinder of cylinders) {
      await this.recordTransition(
        cylinder,
        CylinderState.WITH_CUSTOMER,
        {
          orderId,
          note: 'Entregado (auto al confirmar la entrega del pedido)',
          customerId,
        },
        manager,
      );
    }
    return cylinders.length;
  }

  /**
   * Núcleo de una transición: valida contra la máquina de estados, aplica los
   * efectos sobre `current_customer_id`, persiste el envase y registra el
   * movimiento append-only. Asume que `cylinder` ya está cargado (y que
   * cualquier campo extra como `current_order_id` ya fue seteado por el caller).
   */
  private async recordTransition(
    cylinder: Cylinder,
    toState: CylinderState,
    ctx: {
      orderId?: string | null;
      actorUserId?: string | null;
      note?: string | null;
      customerId?: string | null;
    },
    manager?: EntityManager,
  ): Promise<Cylinder> {
    const cylinders = manager
      ? manager.getRepository(Cylinder)
      : this.cylinderRepository;
    const movements = manager
      ? manager.getRepository(CylinderMovement)
      : this.movementRepository;
    const fromState = cylinder.state;
    assertTransition(fromState, toState);
    // Toda puerta al despacho (asignar, transición suelta, chofer) pasa por acá.
    if (
      toState === CylinderState.DISPATCHED &&
      estaVencido(cylinder.expiresAt)
    ) {
      throw new EnvasesVencidosException([cylinder.serial]);
    }

    if (toState === CylinderState.WITH_CUSTOMER) {
      cylinder.currentCustomerId = ctx.customerId ?? null;
    } else if (
      toState === CylinderState.EMPTY_RETURNED ||
      toState === CylinderState.IN_DEPOT
    ) {
      cylinder.currentCustomerId = null;
    }

    if (toState === CylinderState.DISPATCHED) {
      cylinder.currentOrderId = ctx.orderId ?? null;
    } else if (toState === CylinderState.WITH_CUSTOMER) {
      cylinder.currentOrderId = ctx.orderId ?? cylinder.currentOrderId;
    } else if (
      toState === CylinderState.IN_DEPOT ||
      toState === CylinderState.RETIRED
    ) {
      cylinder.currentOrderId = null;
    }

    cylinder.state = toState;
    const saved = await cylinders.save(cylinder);

    await movements.save(
      movements.create({
        cylinderId: saved.cylinderId,
        distributorId: saved.distributorId,
        fromState,
        toState,
        orderId: ctx.orderId ?? null,
        actorUserId: ctx.actorUserId ?? null,
        note: ctx.note ?? null,
      }),
    );

    return saved;
  }

  /** Historial de movimientos del envase, ordenado cronológicamente. */
  async getHistory(
    id: string,
    distributorId?: string | null,
  ): Promise<CylinderMovement[]> {
    // Valida existencia (y tenant) antes de listar el historial.
    await this.findOne(id, distributorId);

    return this.movementRepository.find({
      where: { cylinderId: id },
      order: { createdAt: 'ASC' },
    });
  }
}
