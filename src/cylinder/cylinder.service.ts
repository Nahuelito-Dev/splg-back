import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { Cylinder, CylinderState } from './entities/cylinder.entity';
import { CylinderMovement } from './entities/cylinder-movement.entity';
import { CreateCylinderDto } from './dto/create-cylinder.dto';
import { TransitionCylinderDto } from './dto/transition-cylinder.dto';
import { assertTransition } from './domain/cylinder-state.machine';
import { Order } from '../order/entities/order.entity';

@Injectable()
export class CylinderService {
  constructor(
    @InjectRepository(Cylinder)
    private readonly cylinderRepository: Repository<Cylinder>,
    @InjectRepository(CylinderMovement)
    private readonly movementRepository: Repository<CylinderMovement>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
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
      distributor_id: distributorId,
      serial: dto.serial,
      gas_cylinder_id: dto.gasCylinderId,
      deposit: dto.deposit ?? 0,
      state: CylinderState.IN_DEPOT,
    });

    let saved: Cylinder;
    try {
      saved = await this.cylinderRepository.save(cylinder);
    } catch (error: any) {
      if (error.code === '23505') {
        throw new ConflictException(
          'El serial ya existe en tu distribuidora',
        );
      }
      throw error;
    }

    await this.movementRepository.save(
      this.movementRepository.create({
        cylinder_id: saved.cylinder_id,
        distributor_id: distributorId,
        from_state: null,
        to_state: CylinderState.IN_DEPOT,
      }),
    );

    return saved;
  }

  /** Lista los envases, scopeados por tenant si se pasa distributorId, filtrando por estado si se pide. */
  async findAll(
    distributorId?: string | null,
    state?: CylinderState,
  ): Promise<Cylinder[]> {
    const where: FindOptionsWhere<Cylinder> = {
      ...(distributorId ? { distributor_id: distributorId } : {}),
      ...(state ? { state } : {}),
    };

    return this.cylinderRepository.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  /** Busca un envase por id, scopeado por tenant si se pasa distributorId. */
  async findOne(id: string, distributorId?: string | null): Promise<Cylinder> {
    const cylinder = await this.cylinderRepository.findOne({
      where: {
        cylinder_id: id,
        ...(distributorId ? { distributor_id: distributorId } : {}),
      },
    });
    if (!cylinder) {
      throw new NotFoundException('Envase no encontrado');
    }
    return cylinder;
  }

  /** Busca un envase por su serial, scopeado por tenant. */
  async findBySerial(
    serial: string,
    distributorId: string,
  ): Promise<Cylinder> {
    const cylinder = await this.cylinderRepository.findOne({
      where: { serial, distributor_id: distributorId },
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
    if (dto.toState === CylinderState.WITH_CUSTOMER && dto.orderId) {
      const order = await this.orderRepository.findOne({
        where: { order_id: dto.orderId },
      });
      customerId = order?.customer_id ?? null;
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
    const order = await this.orderRepository.findOne({
      where: { order_id: orderId },
    });
    if (!order) {
      throw new NotFoundException('Pedido no encontrado');
    }

    const assigned: Cylinder[] = [];
    for (const serial of serials) {
      const cylinder = await this.findBySerial(serial, distributorId);
      cylinder.current_order_id = orderId;
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
        current_order_id: orderId,
        state: CylinderState.DISPATCHED,
        ...(distributorId ? { distributor_id: distributorId } : {}),
      },
    });
    if (cylinders.length === 0) return 0;

    const order = await this.orderRepository.findOne({
      where: { order_id: orderId },
    });
    const customerId = order?.customer_id ?? null;

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
      cylinder.current_customer_id = ctx.customerId ?? null;
    } else if (
      toState === CylinderState.EMPTY_RETURNED ||
      toState === CylinderState.IN_DEPOT
    ) {
      cylinder.current_customer_id = null;
    }

    cylinder.state = toState;
    const saved = await this.cylinderRepository.save(cylinder);

    await this.movementRepository.save(
      this.movementRepository.create({
        cylinder_id: saved.cylinder_id,
        distributor_id: saved.distributor_id,
        from_state: fromState,
        to_state: toState,
        order_id: ctx.orderId ?? null,
        actor_user_id: ctx.actorUserId ?? null,
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
      where: { cylinder_id: id },
      order: { createdAt: 'ASC' },
    });
  }
}
