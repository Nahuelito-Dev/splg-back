import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { Cylinder, CylinderState } from './entities/cylinder.entity';
import { CylinderMovement } from './entities/cylinder-movement.entity';
import { CreateCylinderDto } from './dto/create-cylinder.dto';
import { TransitionCylinderDto } from './dto/transition-cylinder.dto';
import { assertTransition } from './domain/cylinder-state.machine';
import { OrderLookupService } from '../order/lookup/order-lookup.service';
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
    const cylinder = await this.findOne(id, distributorId);

    let customerId: string | null = null;
    if (dto.orderId) {
      // El pedido tiene que ser de la misma distribuidora que el envase (H-90).
      const order = await this.orders.findRef(dto.orderId, distributorId);
      if (!order) throw new NotFoundException('Pedido no encontrado');
      if (dto.toState === CylinderState.WITH_CUSTOMER) {
        customerId = order.customerId;
      }
    }

    return this.recordTransition(cylinder, dto.toState, {
      orderId: dto.orderId,
      actorUserId,
      note: dto.note,
      customerId,
    });
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
  ): Promise<number> {
    const cylinders = await this.cylinderRepository.find({
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
      await this.recordTransition(cylinder, CylinderState.WITH_CUSTOMER, {
        orderId,
        note: 'Entregado (auto al confirmar la entrega del pedido)',
        customerId,
      });
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
  ): Promise<Cylinder> {
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

    cylinder.state = toState;
    const saved = await this.cylinderRepository.save(cylinder);

    await this.movementRepository.save(
      this.movementRepository.create({
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
