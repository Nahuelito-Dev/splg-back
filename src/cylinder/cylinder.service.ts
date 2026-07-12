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
    const fromState = cylinder.state;

    assertTransition(fromState, dto.toState);

    if (dto.toState === CylinderState.WITH_CUSTOMER) {
      if (dto.orderId) {
        const order = await this.orderRepository.findOne({
          where: { order_id: dto.orderId },
        });
        cylinder.current_customer_id = order?.customer_id ?? null;
      } else {
        cylinder.current_customer_id = null;
      }
    } else if (
      dto.toState === CylinderState.EMPTY_RETURNED ||
      dto.toState === CylinderState.IN_DEPOT
    ) {
      cylinder.current_customer_id = null;
    }

    cylinder.state = dto.toState;
    const saved = await this.cylinderRepository.save(cylinder);

    await this.movementRepository.save(
      this.movementRepository.create({
        cylinder_id: saved.cylinder_id,
        distributor_id: distributorId,
        from_state: fromState,
        to_state: dto.toState,
        order_id: dto.orderId,
        actor_user_id: actorUserId,
        note: dto.note,
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
