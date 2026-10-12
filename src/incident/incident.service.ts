import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import {
  Incident,
  IncidentStatus,
  IncidentType,
} from './entities/incident.entity';
import { CreateIncidentDto } from './dto/create-incident.dto';
import { UpdateIncidentDto } from './dto/update-incident.dto';
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
    if (dto.type === IncidentType.UNPAID_COLLECTION) {
      throw new BadRequestException(
        'La incidencia de cobro impago se crea informando el impago: PATCH /orders/:id/payment/unpaid',
      );
    }
    const order = await this.orderService.findById(dto.orderId);
    // El pedido de otra distribuidora no existe para quien reporta.
    if (!order || (distributorId && order.distributorId !== distributorId)) {
      throw new NotFoundException('Pedido no encontrado');
    }
    // El chofer reporta sobre el pedido que tiene asignado.
    if (esChofer) {
      await this.orderService.assertAsignadoAlChofer(
        order.deliveryId,
        reportedByUserId,
      );
    }

    const incident = this.incidentRepository.create({
      orderId: order.orderId,
      distributorId: order.distributorId,
      reportedBy: reportedByUserId,
      type: dto.type,
      description: dto.description,
      status: IncidentStatus.OPEN,
    });

    return this.incidentRepository.save(incident);
  }

  /** Lista todas las incidencias, scopeadas por tenant si se pasa distributorId. */
  async findAll(distributorId?: string | null): Promise<Incident[]> {
    const where: FindOptionsWhere<Incident> = {
      ...(distributorId ? { distributorId } : {}),
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
    if (!order || (distributorId && order.distributorId !== distributorId)) {
      throw new NotFoundException('Pedido no encontrado');
    }
    return this.incidentRepository.find({
      where: {
        orderId,
        ...(distributorId ? { distributorId } : {}),
      },
      order: { createdAt: 'DESC' },
    });
  }

  /** Busca una incidencia por id, scopeada por tenant si se pasa distributorId. */
  async findOne(id: string, distributorId?: string | null): Promise<Incident> {
    const incident = await this.incidentRepository.findOne({
      where: {
        incidentId: id,
        ...(distributorId ? { distributorId } : {}),
      },
    });
    if (!incident) {
      throw new NotFoundException('Incidencia no encontrada');
    }
    return incident;
  }

  /** Ficha de la incidencia: con su pedido y el cliente del pedido. */
  async findDetail(
    id: string,
    distributorId?: string | null,
  ): Promise<Incident> {
    const incident = await this.incidentRepository.findOne({
      where: {
        incidentId: id,
        ...(distributorId ? { distributorId } : {}),
      },
      withDeleted: true,
      relations: ['order', 'order.customer'],
    });
    if (!incident) {
      throw new NotFoundException('Incidencia no encontrada');
    }
    return incident;
  }

  /** Edita descripción y tipo mientras la incidencia está abierta. */
  async update(
    id: string,
    dto: UpdateIncidentDto,
    distributorId?: string | null,
  ): Promise<Incident> {
    const incident = await this.findOne(id, distributorId);
    if (incident.status !== IncidentStatus.OPEN) {
      throw new ConflictException('Sólo se edita una incidencia abierta');
    }
    if (
      dto.type !== undefined &&
      dto.type !== incident.type &&
      (dto.type === IncidentType.UNPAID_COLLECTION ||
        incident.type === IncidentType.UNPAID_COLLECTION)
    ) {
      throw new BadRequestException(
        'El tipo cobro impago no se asigna ni se cambia a mano: lo fija el informe de impago',
      );
    }
    if (dto.description !== undefined) incident.description = dto.description;
    if (dto.type !== undefined) incident.type = dto.type;
    await this.incidentRepository.save(incident);
    return this.findDetail(id, distributorId);
  }

  /**
   * Cierra la incidencia: resuelta (default) o descartada, siempre con nota
   * (el motivo del descarte). `distributorId` opcional: sin él (super admin
   * sin `X-Distributor`) se cierra cross-tenant, igual que en `claims.resolve`.
   * Descartar sólo una incidencia abierta; una descartada no se vuelve a tocar.
   */
  async resolve(
    id: string,
    dto: ResolveIncidentDto,
    distributorId?: string | null,
  ): Promise<Incident> {
    const incident = await this.findOne(id, distributorId);
    const destino = dto.status ?? IncidentStatus.RESOLVED;
    if (
      incident.status === IncidentStatus.DISCARDED ||
      (destino === IncidentStatus.DISCARDED &&
        incident.status !== IncidentStatus.OPEN)
    ) {
      throw new ConflictException(
        'Sólo se descarta una incidencia abierta, y una descartada no se modifica',
      );
    }
    incident.status = destino;
    incident.resolutionNote = dto.resolutionNote;
    incident.resolvedAt = new Date();
    return this.incidentRepository.save(incident);
  }
}
