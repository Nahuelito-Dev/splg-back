import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, Not } from 'typeorm';
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
import { EventEmitter2 } from '@nestjs/event-emitter';
import { avisarIncidenciaAAdmins } from './aviso-de-incidencia';
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
    private readonly events: EventEmitter2,
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
      (manager, pedido) =>
        this.abrirIncidencia(
          manager,
          pedido,
          driverUserId,
          dto.note?.trim() || DESCRIPCION_POR_DEFECTO,
        ),
      distributorId,
    );

    // Después del commit y una sola vez: sólo quien la creó avisa.
    if (extra.creada) this.avisarAAdmins(extra.incident);
    return { order, incident: extra.incident };
  }

  /**
   * El administrador informa el impago de un pedido entregado en efectivo cuyo
   * chofer no lo hizo. Mismo efecto que `report` (pago `unpaid` + una
   * incidencia), con motivo obligatorio en el historial. La incidencia queda
   * reportada por el admin.
   */
  async reportByAdmin(
    orderId: string,
    reason: string,
    adminUserId: string,
    distributorId: string,
  ): Promise<{ order: Order; incident: Incident }> {
    await this.orders.assertDeLaDistribuidora(orderId, distributorId);
    const { order, extra } = await this.cashCollection.registerUnpaidByAdmin(
      orderId,
      adminUserId,
      reason,
      (manager, pedido) =>
        this.abrirIncidencia(
          manager,
          pedido,
          adminUserId,
          `${DESCRIPCION_POR_DEFECTO} (informado por un administrador: ${reason})`,
        ),
      distributorId,
    );
    if (extra.creada) this.avisarAAdmins(extra.incident);
    return { order, incident: extra.incident };
  }

  /** La incidencia de cobro impago del pedido: la existente o una nueva. */
  private async abrirIncidencia(
    manager: EntityManager,
    pedido: Order,
    reportedBy: string,
    description: string,
  ): Promise<{ incident: Incident; creada: boolean }> {
    const repo = manager.getRepository(Incident);
    const existente = await repo.findOne({
      where: {
        orderId: pedido.orderId,
        type: IncidentType.UNPAID_COLLECTION,
        status: Not(IncidentStatus.DISCARDED),
      },
    });
    if (existente) return { incident: existente, creada: false };
    const incident = await repo.save(
      repo.create({
        orderId: pedido.orderId,
        distributorId: pedido.distributorId,
        reportedBy,
        type: IncidentType.UNPAID_COLLECTION,
        description,
        photoUrl: null,
        status: IncidentStatus.OPEN,
        moment: IncidentMoment.POST_DELIVERY,
      }),
    );
    return { incident, creada: true };
  }

  private avisarAAdmins(incident: Incident): void {
    avisarIncidenciaAAdmins(
      this.adminGateway,
      incident,
      this.logger,
      this.events,
    );
  }
}
