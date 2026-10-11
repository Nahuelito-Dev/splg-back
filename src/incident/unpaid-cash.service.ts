import { Injectable, Logger } from '@nestjs/common';
import { Not } from 'typeorm';
import {
  Incident,
  IncidentMoment,
  IncidentStatus,
  IncidentType,
} from './entities/incident.entity';
import { ReportUnpaidCashDto } from './dto/report-unpaid-cash.dto';
import { CashCollectionUseCase } from '../order/application/cash-collection.use-case';
import { OrderService } from '../order/order.service';
import { AdminGateway } from '../gateways/admin.gateway';
import { errorMessage } from '../common/errors/error-message';
import type { Order } from '../order/entities/order.entity';

const DESCRIPCION_POR_DEFECTO = 'El cliente no pagó el efectivo en la entrega';

/**
 * El chofer informa que el cliente no pagó un pedido en efectivo: el pago pasa
 * a `unpaid` (módulo `order`, bajo lock) y se abre UNA incidencia de cobro
 * impago. Repetirlo no duplica nada: devuelve la incidencia ya abierta. Vive
 * acá y no en `order` porque `incident` ya depende de `order`.
 */
@Injectable()
export class UnpaidCashService {
  private readonly logger = new Logger(UnpaidCashService.name);

  constructor(
    private readonly orders: OrderService,
    private readonly cashCollection: CashCollectionUseCase,
    private readonly adminGateway: AdminGateway,
  ) {}

  async report(
    orderId: string,
    dto: ReportUnpaidCashDto,
    driverUserId: string,
    distributorId: string | null,
  ): Promise<{ order: Order; incident: Incident }> {
    // Pedido de otra distribuidora: 404, igual que el resto de /orders.
    await this.orders.assertDeLaDistribuidora(orderId, distributorId);
    const { order, extra } = await this.cashCollection.markUnpaid(
      orderId,
      driverUserId,
      async (manager, pedido) => {
        const repo = manager.getRepository(Incident);
        const existente = await repo.findOne({
          where: {
            orderId,
            type: IncidentType.UNPAID_COLLECTION,
            status: Not(IncidentStatus.DISCARDED),
          },
        });
        if (existente) return { incident: existente, creada: false };
        const incident = await repo.save(
          repo.create({
            orderId,
            distributorId: pedido.distributorId,
            reportedBy: driverUserId,
            type: IncidentType.UNPAID_COLLECTION,
            description: dto.note?.trim() || DESCRIPCION_POR_DEFECTO,
            photoUrl: null,
            status: IncidentStatus.OPEN,
            moment: IncidentMoment.POST_DELIVERY,
          }),
        );
        return { incident, creada: true };
      },
    );

    // Después del commit y una sola vez: sólo quien la creó avisa.
    if (extra.creada) this.avisarAAdmins(extra.incident);
    return { order, incident: extra.incident };
  }

  /** Best-effort: la incidencia ya está guardada. */
  private avisarAAdmins(incident: Incident): void {
    try {
      this.adminGateway.notifyAdmins(
        'incident:created',
        {
          incidentId: incident.incidentId,
          orderId: incident.orderId,
          type: incident.type,
          description: incident.description,
          createdAt: incident.createdAt,
        },
        incident.distributorId,
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo avisar a los admins de la incidencia ${incident.incidentId}: ${errorMessage(error)}`,
      );
    }
  }
}
