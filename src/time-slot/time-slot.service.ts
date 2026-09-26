import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, FindOptionsWhere, Not, Repository } from 'typeorm';
import { TimeSlot } from './entities/time-slot.entity';
import { CreateTimeSlotDto } from './dto/create-time-slot.dto';
import { DistributorService } from '../distributor/distributor.service';
import { Order, OrderStatus } from '../order/entities/order.entity';
import { SlotAvailabilityDto } from './dto/time-slot-response.dto';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SlotAvailability = SlotAvailabilityDto;

@Injectable()
export class TimeSlotService {
  constructor(
    @InjectRepository(TimeSlot)
    private readonly timeSlotRepository: Repository<TimeSlot>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    private readonly distributorService: DistributorService,
  ) {}

  /**
   * Resuelve un `distributor_id` a partir de un slug o uuid (o null si no se
   * pasó nada). Usado por los endpoints públicos, donde el tenant llega por
   * query `?distributor=` (el guard no corre en rutas @Public).
   */
  async resolveDistributor(slugOrId?: string): Promise<string | null> {
    if (!slugOrId) return null;
    const distributor = UUID_RE.test(slugOrId)
      ? await this.distributorService.assertActive(slugOrId)
      : await this.distributorService.findBySlug(slugOrId);
    return distributor.distributor_id;
  }

  async create(
    createTimeSlotDto: CreateTimeSlotDto,
    distributorId: string,
  ): Promise<TimeSlot> {
    const timeSlot = this.timeSlotRepository.create({
      ...createTimeSlotDto,
      distributor_id: distributorId,
    });
    return await this.timeSlotRepository.save(timeSlot);
  }

  /**
   * Lista las franjas activas. Prioridad de tenant:
   *  - `distributorSlug` (query `?distributor=`, lo usa la app cliente por slug),
   *  - si no, `distributorId` (el tenant del admin autenticado, @CurrentDistributor).
   * Solo un super_admin sin ninguno de los dos ve las de todas las empresas.
   */
  async findAll(
    distributorSlug?: string,
    distributorId?: string | null,
  ): Promise<TimeSlot[]> {
    const effective = distributorSlug
      ? await this.resolveDistributor(distributorSlug)
      : (distributorId ?? null);

    const where: FindOptionsWhere<TimeSlot> = { isActive: true };
    if (effective) where.distributor_id = effective;

    return await this.timeSlotRepository.find({
      where,
      order: { startTime: 'ASC' },
    });
  }

  /**
   * `distributorId` opcional: si viene, la franja debe pertenecer a ese
   * tenant (evita que un admin lea/borre franjas de otra distribuidora).
   */
  async findOne(id: string, distributorId?: string | null): Promise<TimeSlot> {
    const where: FindOptionsWhere<TimeSlot> = { time_slot_id: id };
    if (distributorId) where.distributor_id = distributorId;

    const timeSlot = await this.timeSlotRepository.findOne({ where });
    if (!timeSlot) throw new NotFoundException('Time slot not found');
    return timeSlot;
  }

  async remove(id: string, distributorId: string): Promise<TimeSlot> {
    const timeSlot = await this.findOne(id, distributorId);
    timeSlot.isActive = false;
    return await this.timeSlotRepository.save(timeSlot);
  }

  /** Pedidos ya agendados a una franja en una fecha (no cancelados). */
  private countBooked(
    timeSlotId: string,
    date: string,
    distributorId?: string | null,
  ): Promise<number> {
    const where: FindOptionsWhere<Order> = {
      time_slot_id: timeSlotId,
      scheduled_date: date,
      status: Not(OrderStatus.CANCELLED),
    };
    if (distributorId) where.distributor_id = distributorId;
    return this.orderRepository.count({ where });
  }

  /**
   * Disponibilidad de todas las franjas activas de una distribuidora para una
   * fecha: capacidad, reservados y cupos libres. Base del agendamiento (el
   * cliente elige día + franja con cupo). Soporta same-day (fecha = hoy).
   */
  async getAvailability(
    date: string,
    distributor?: string,
  ): Promise<SlotAvailability[]> {
    const distributorId = await this.resolveDistributor(distributor);
    const where: FindOptionsWhere<TimeSlot> = { isActive: true };
    if (distributorId) where.distributor_id = distributorId;

    const slots = await this.timeSlotRepository.find({
      where,
      order: { startTime: 'ASC' },
    });

    const result: SlotAvailability[] = [];
    for (const slot of slots) {
      const booked = await this.countBooked(
        slot.time_slot_id,
        date,
        distributorId,
      );
      result.push({
        timeSlotId: slot.time_slot_id,
        name: slot.name,
        startTime: slot.startTime,
        endTime: slot.endTime,
        capacity: slot.capacity,
        booked,
        remaining: Math.max(0, slot.capacity - booked),
      });
    }
    return result;
  }

  /**
   * Valida que una franja tenga cupo para una fecha antes de agendar un pedido.
   * Lanza 400 si la franja no existe/está inactiva, la fecha es pasada, o no
   * quedan cupos. La usa CreateOrderUseCase cuando el pedido trae scheduledDate.
   */
  async assertSlotAvailable(
    timeSlotId: string,
    date: string,
    distributorId?: string | null,
  ): Promise<void> {
    const slot = await this.timeSlotRepository.findOne({
      where: {
        time_slot_id: timeSlotId,
        isActive: true,
        ...(distributorId ? { distributor_id: distributorId } : {}),
      },
    });
    if (!slot) {
      throw new BadRequestException('Franja horaria inválida o inactiva');
    }

    // No agendar en el pasado (compara sólo la fecha, permite same-day = hoy).
    const today = new Date().toISOString().slice(0, 10);
    if (date < today) {
      throw new BadRequestException('No se puede agendar en una fecha pasada');
    }

    const booked = await this.countBooked(timeSlotId, date, distributorId);
    if (booked >= slot.capacity) {
      throw new BadRequestException(
        `La franja "${slot.name}" del ${date} está completa`,
      );
    }
  }

  /**
   * Igual que `assertSlotAvailable` pero DENTRO de una transacción y con lock
   * pesimista sobre la fila de la franja. Serializa las reservas concurrentes
   * de la MISMA franja+fecha: la 2ª transacción espera a que la 1ª commitee
   * (liberando el lock) antes de contar, así el conteo ve el pedido recién
   * insertado y no se supera `capacity` bajo carga. Debe llamarse con el
   * `EntityManager` de la transacción que también inserta el pedido, para que
   * el lock se sostenga hasta el commit.
   */
  async assertSlotAvailableTx(
    manager: EntityManager,
    timeSlotId: string,
    date: string,
    distributorId?: string | null,
  ): Promise<void> {
    const slot = await manager.findOne(TimeSlot, {
      where: {
        time_slot_id: timeSlotId,
        isActive: true,
        ...(distributorId ? { distributor_id: distributorId } : {}),
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!slot) {
      throw new BadRequestException('Franja horaria inválida o inactiva');
    }

    const today = new Date().toISOString().slice(0, 10);
    if (date < today) {
      throw new BadRequestException('No se puede agendar en una fecha pasada');
    }

    const where: FindOptionsWhere<Order> = {
      time_slot_id: timeSlotId,
      scheduled_date: date,
      status: Not(OrderStatus.CANCELLED),
    };
    if (distributorId) where.distributor_id = distributorId;
    const booked = await manager.count(Order, { where });
    if (booked >= slot.capacity) {
      throw new BadRequestException(
        `La franja "${slot.name}" del ${date} está completa`,
      );
    }
  }
}
