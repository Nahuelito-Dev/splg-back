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
import { PaymentStatus } from '../order/entities/order.entity';
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
   * además, sólo reporta sobre el que tiene asignado (404 si es ajeno, 410 si lo
   * tuvo y ya no).
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
      await this.orderService.assertPedidoPropioDelChofer(
        order,
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
    const cambios: Partial<Incident> = {};
    if (dto.description !== undefined) cambios.description = dto.description;
    if (dto.type !== undefined) cambios.type = dto.type;
    // Actualización condicional (sólo mientras siga abierta) y sólo de los
    // campos editados: no pisa una resolución hecha en paralelo.
    await this.cerrarOEditar(incident, cambios);
    return this.findDetail(id, distributorId);
  }

  /**
   * UPDATE ... WHERE status = 'open': el cambio se aplica sólo si nadie cerró la
   * incidencia entre la lectura y la escritura; si no, 409.
   */
  private async cerrarOEditar(
    incident: Incident,
    cambios: Partial<Incident>,
  ): Promise<void> {
    if (Object.keys(cambios).length === 0) return;
    const { affected } = await this.incidentRepository.update(
      { incidentId: incident.incidentId, status: IncidentStatus.OPEN },
      cambios,
    );
    if (!affected) {
      throw new ConflictException(
        'La incidencia cambió mientras la editabas: recargala y reintentá',
      );
    }
    Object.assign(incident, cambios);
  }

  /**
   * Cierra la incidencia: resuelta (default) o descartada, siempre con nota
   * (el motivo del descarte). El controller exige la distribuidora (el super
   * admin elige una con `X-Distributor`).
   * Descartar sólo una incidencia abierta; una descartada o ya resuelta no se
   * vuelve a tocar. Una de cobro impago no se resuelve por acá mientras el
   * pedido siga `unpaid`, ni se descarta: se resuelve el cobro del pedido (409).
   * El cierre es un UPDATE condicional a `open`: si otro admin (o
   * `resolve-unpaid`) la cerró en paralelo, 409 y no se pisa su resolución.
   */
  async resolve(
    id: string,
    dto: ResolveIncidentDto,
    distributorId?: string | null,
  ): Promise<Incident> {
    const incident = await this.findOne(id, distributorId);
    const destino = dto.status ?? IncidentStatus.RESOLVED;
    if (incident.status === IncidentStatus.RESOLVED) {
      throw new ConflictException('La incidencia ya está resuelta');
    }
    if (incident.status === IncidentStatus.DISCARDED) {
      throw new ConflictException(
        'Sólo se descarta una incidencia abierta, y una descartada no se modifica',
      );
    }
    // La de cobro impago la cierra el cobro del pedido, nunca la puerta
    // genérica (ni resuelta ni descartada) mientras el pedido siga `unpaid`.
    if (incident.type === IncidentType.UNPAID_COLLECTION) {
      const order = await this.orderService.findById(incident.orderId);
      if (order?.paymentStatus === PaymentStatus.UNPAID) {
        throw new ConflictException(
          'La incidencia de cobro impago se cierra resolviendo el cobro del pedido: PATCH /orders/:id/payment/resolve-unpaid',
        );
      }
    }
    await this.cerrarOEditar(incident, {
      status: destino,
      resolutionNote: dto.resolutionNote,
      resolvedAt: new Date(),
    });
    return incident;
  }
}
