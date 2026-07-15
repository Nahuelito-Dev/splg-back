import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { Incident, IncidentStatus } from './entities/incident.entity';
import { CreateIncidentDto } from './dto/create-incident.dto';
import { ResolveIncidentDto } from './dto/resolve-incident.dto';
import { Order } from '../order/entities/order.entity';

@Injectable()
export class IncidentService {
  constructor(
    @InjectRepository(Incident)
    private readonly incidentRepository: Repository<Incident>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
  ) {}

  /**
   * Registra una incidencia sobre un pedido. El `distributor_id` se
   * denormaliza de la order (no se confía en el body). `reportedByUserId`
   * sale del token (normalmente el chofer que entrega el pedido).
   */
  async create(
    dto: CreateIncidentDto,
    reportedByUserId: string,
  ): Promise<Incident> {
    const order = await this.orderRepository.findOne({
      where: { order_id: dto.orderId },
    });
    if (!order) {
      throw new NotFoundException('Pedido no encontrado');
    }

    const incident = this.incidentRepository.create({
      order_id: order.order_id,
      distributor_id: order.distributor_id,
      reported_by: reportedByUserId,
      type: dto.type,
      description: dto.description,
      photo_url: dto.photoUrl,
      status: IncidentStatus.OPEN,
    });

    return this.incidentRepository.save(incident);
  }

  /** Lista todas las incidencias, scopeadas por tenant si se pasa distributorId. */
  async findAll(distributorId?: string | null): Promise<Incident[]> {
    const where: FindOptionsWhere<Incident> = {
      ...(distributorId ? { distributor_id: distributorId } : {}),
    };

    return this.incidentRepository.find({
      where,
      // Trae el pedido y su cliente para que el panel muestre a quién afecta la
      // incidencia sin llamadas extra (findAll es admin-only).
      relations: ['order', 'order.customer'],
      order: { createdAt: 'DESC' },
    });
  }

  /** Incidencias de un pedido puntual, scopeadas por tenant si se pasa distributorId. */
  async findByOrder(
    orderId: string,
    distributorId?: string | null,
  ): Promise<Incident[]> {
    return this.incidentRepository.find({
      where: {
        order_id: orderId,
        ...(distributorId ? { distributor_id: distributorId } : {}),
      },
      order: { createdAt: 'DESC' },
    });
  }

  /** Busca una incidencia por id, scopeada por tenant si se pasa distributorId. */
  async findOne(
    id: string,
    distributorId?: string | null,
  ): Promise<Incident> {
    const incident = await this.incidentRepository.findOne({
      where: {
        incident_id: id,
        ...(distributorId ? { distributor_id: distributorId } : {}),
      },
    });
    if (!incident) {
      throw new NotFoundException('Incidencia no encontrada');
    }
    return incident;
  }

  /** Marca la incidencia como resuelta con su nota de resolución. */
  async resolve(
    id: string,
    dto: ResolveIncidentDto,
    distributorId: string,
  ): Promise<Incident> {
    const incident = await this.findOne(id, distributorId);

    incident.status = IncidentStatus.RESOLVED;
    incident.resolution_note = dto.resolutionNote;
    incident.resolvedAt = new Date();

    return this.incidentRepository.save(incident);
  }
}
