import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { Incident, IncidentStatus } from './entities/incident.entity';
import { CreateIncidentDto } from './dto/create-incident.dto';
import { ResolveIncidentDto } from './dto/resolve-incident.dto';
import { OrderService } from '../order/order.service';

@Injectable()
export class IncidentService {
  constructor(
    @InjectRepository(Incident)
    private readonly incidentRepository: Repository<Incident>,
    private readonly orderService: OrderService,
  ) {}

  /**
   * Registra una incidencia sobre un pedido. El `distributor_id` se
   * denormaliza de la order (no se confía en el body). `reportedByUserId`
   * sale del token (normalmente el chofer que entrega el pedido).
   * Con distribuidora en contexto, el pedido tiene que ser de ella; un chofer,
   * además, sólo reporta sobre el que tiene asignado.
   */
  async create(
    dto: CreateIncidentDto,
    reportedByUserId: string,
    distributorId: string | null,
    esChofer: boolean,
  ): Promise<Incident> {
    const order = await this.orderService.findById(dto.orderId);
    // El pedido de otra distribuidora no existe para quien reporta.
    if (!order || (distributorId && order.distributor_id !== distributorId)) {
      throw new NotFoundException('Pedido no encontrado');
    }
    // El chofer reporta sobre el pedido que tiene asignado.
    if (esChofer) {
      await this.orderService.assertAsignadoAlChofer(
        order.delivery_id,
        reportedByUserId,
      );
    }

    const incident = this.incidentRepository.create({
      order_id: order.order_id,
      distributor_id: order.distributor_id,
      reported_by: reportedByUserId,
      type: dto.type,
      description: dto.description,
      photo_url: dto.photoUrl ?? null,
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
      // Historial: el chofer, el cliente o la dirección dados de baja siguen
      // apareciendo en lo que ya pasó (H-74).
      withDeleted: true,
      relations: ['order', 'order.customer'],
      order: { createdAt: 'DESC' },
    });
  }

  /** Incidencias de un pedido puntual, scopeadas por tenant si se pasa distributorId. */
  async findByOrder(
    orderId: string,
    distributorId?: string | null,
  ): Promise<Incident[]> {
    // Pedido inexistente o de otra distribuidora: el mismo 404. Una lista
    // vacía para uno y un 404 para el otro revelaría que el ajeno existe.
    const order = await this.orderService.findById(orderId);
    if (!order || (distributorId && order.distributor_id !== distributorId)) {
      throw new NotFoundException('Pedido no encontrado');
    }
    return this.incidentRepository.find({
      where: {
        order_id: orderId,
        ...(distributorId ? { distributor_id: distributorId } : {}),
      },
      order: { createdAt: 'DESC' },
    });
  }

  /** Busca una incidencia por id, scopeada por tenant si se pasa distributorId. */
  async findOne(id: string, distributorId?: string | null): Promise<Incident> {
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
