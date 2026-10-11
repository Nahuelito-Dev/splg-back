import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, EntityManager, Repository } from 'typeorm';
import { Cylinder, CylinderState } from './entities/cylinder.entity';
import { CylinderMovement } from './entities/cylinder-movement.entity';
import { CreateCylinderDto } from './dto/create-cylinder.dto';
import { TransitionCylinderDto } from './dto/transition-cylinder.dto';
import { UpdateCylinderDto } from './dto/update-cylinder.dto';
import { assertTransition } from './domain/cylinder-state.machine';
import { OrderLookupService } from '../order/lookup/order-lookup.service';
import { GasCylinderService } from '../gascylinder/gascylinder.service';
import { errorCode } from '../common/errors/error-message';

/** Filtros del listado de envases. */
export interface FiltrosDeEnvases {
  state?: CylinderState;
  orderId?: string;
  /** user_id del cliente. */
  customerUserId?: string;
  /** Sin `limit` no pagina. */
  limit?: number;
  offset?: number;
}

/** Lo que el panel muestra de cada envase: de qué producto es y quién lo tiene. */
const CON_PRODUCTO_Y_CLIENTE = ['gasCylinder', 'currentCustomer'];

@Injectable()
export class CylinderService {
  constructor(
    @InjectRepository(Cylinder)
    private readonly cylinderRepository: Repository<Cylinder>,
    @InjectRepository(CylinderMovement)
    private readonly movementRepository: Repository<CylinderMovement>,
    private readonly orders: OrderLookupService,
    private readonly gasCylinders: GasCylinderService,
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
      serial: dto.serial,
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
    const { state, orderId, customerUserId, limit, offset } = filtros;
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
      where: { serial, distributorId },
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
   */
  async transition(
    id: string,
    dto: TransitionCylinderDto,
    distributorId: string,
    actorUserId?: string,
  ): Promise<Cylinder> {
    if (dto.toState === CylinderState.RETIRED) {
      throw new BadRequestException(
        'La baja del envase va por PATCH /cylinders/:id/retire, con motivo',
      );
    }

    let customerId: string | null = null;
    if (dto.orderId) {
      // El pedido tiene que ser de la misma distribuidora que el envase (H-90).
      const order = await this.orders.findRef(dto.orderId, distributorId);
      if (!order) throw new NotFoundException('Pedido no encontrado');
      if (dto.toState === CylinderState.WITH_CUSTOMER) {
        customerId = order.customerId;
      }
    }

    // Con el envase bloqueado: una transición y una baja simultáneas se
    // serializan y la segunda valida contra el estado que dejó la primera.
    await this.cylinderRepository.manager.transaction(async (manager) => {
      const cylinder = await this.bloquear(manager, id, distributorId);
      await this.recordTransition(
        cylinder,
        dto.toState,
        {
          orderId: dto.orderId,
          actorUserId,
          note: dto.note,
          customerId,
        },
        manager,
      );
    });
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
        Object.assign(cylinder, {
          ...(dto.serial !== undefined && { serial: dto.serial }),
          ...(dto.gasCylinderId !== undefined && {
            gasCylinderId: dto.gasCylinderId,
          }),
          ...(dto.deposit !== undefined && { deposit: dto.deposit }),
          ...(dto.manufacturedAt !== undefined && {
            manufacturedAt: dto.manufacturedAt,
          }),
          ...(dto.lastInspectionAt !== undefined && {
            lastInspectionAt: dto.lastInspectionAt,
          }),
          ...(dto.expiresAt !== undefined && { expiresAt: dto.expiresAt }),
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
   * que, al confirmar la entrega, `onOrderDelivered` los avance solo. Si algún
   * envase no está FILLED, la transición es inválida y lanza 400 (hay que
   * llenarlo antes de despacharlo).
   */
  async assignToOrder(
    orderId: string,
    serials: string[],
    distributorId: string,
    actorUserId?: string,
  ): Promise<Cylinder[]> {
    // Sólo un pedido de la misma distribuidora (H-90).
    const order = await this.orders.findRef(orderId, distributorId);
    if (!order) {
      throw new NotFoundException('Pedido no encontrado');
    }

    const assigned: Cylinder[] = [];
    for (const serial of serials) {
      const cylinder = await this.findBySerial(serial, distributorId);
      cylinder.currentOrderId = orderId;
      const saved = await this.recordTransition(
        cylinder,
        CylinderState.DISPATCHED,
        {
          orderId,
          actorUserId,
          note: `Asignado al pedido ${orderId}`,
        },
      );
      assigned.push(saved);
    }
    return assigned;
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
    const repo = manager
      ? manager.getRepository(Cylinder)
      : this.cylinderRepository;
    const cylinders = await repo.find({
      where: {
        currentOrderId: orderId,
        state: CylinderState.DISPATCHED,
        ...(distributorId ? { distributorId } : {}),
      },
    });
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

    if (toState === CylinderState.WITH_CUSTOMER) {
      cylinder.currentCustomerId = ctx.customerId ?? null;
    } else if (
      toState === CylinderState.EMPTY_RETURNED ||
      toState === CylinderState.IN_DEPOT
    ) {
      cylinder.currentCustomerId = null;
    }

    if (toState === CylinderState.RETIRED) cylinder.currentOrderId = null;

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
