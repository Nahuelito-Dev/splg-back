import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RoleType } from '../common/constants/role-type.enum';
import { conCodigo } from '../common/errors/con-codigo';
import { errorMessage } from '../common/errors/error-message';
import { DeliveryService } from '../delivery/delivery.service';
import { ReleaseOrderUseCase } from '../order/application/release-order.use-case';
import { Order, OrderStatus } from '../order/entities/order.entity';
import {
  FailedDeliveryReason,
  RouteSheetStopsService,
} from '../route-batch/application/route-sheet-stops.service';
import { DeliveryKind, FailedVisitReason } from './domain/nueva-visita';
import { FailedVisitNotifier } from './failed-visit.notifier';
import {
  FailedVisitService,
  ResultadoDeVisita,
  VisitaFallida,
  motivoLegible,
} from './failed-visit.service';

export const FailedDeliveryError = {
  NO_EN_CAMINO: 'ORDER_NOT_ON_THE_WAY',
  ACUERDO_EN_REINTENTO: 'REVISIT_AGREEMENT_NOT_ALLOWED',
} as const;

/** Lo que manda quien no pudo entregar. */
export interface NoPudeEntregar extends VisitaFallida {
  orderId: string;
}

/** El resultado para la app: en qué quedó el pedido y, en una hoja, la próxima parada. */
export interface ResultadoDeNoEntrega extends ResultadoDeVisita {
  deliveryKind: DeliveryKind;
  nextOrderId: string | null;
}

/** El motivo de C5 en el vocabulario de la hoja de ruta. */
const MOTIVO_DE_HOJA: Record<FailedVisitReason, FailedDeliveryReason> = {
  [FailedVisitReason.CUSTOMER_ABSENT]: FailedDeliveryReason.CUSTOMER_ABSENT,
  [FailedVisitReason.ADDRESS_CLOSED]: FailedDeliveryReason.NO_ACCESS,
  [FailedVisitReason.REJECTED]: FailedDeliveryReason.REJECTED,
  [FailedVisitReason.OTHER]: FailedDeliveryReason.OTHER,
};

/**
 * «No pude entregar» (C5), el mismo para todas las entregas. El chofer
 * asignado (o un admin) informa el motivo y dónde está:
 *  - parada de una hoja de ruta en curso: sigue el circuito de la hoja (primer
 *    intento al final del recorrido; segundo, sale de la hoja) y la visita
 *    queda asentada por ella;
 *  - pedido suelto o express en camino: en una sola transacción con el pedido
 *    bloqueado se asienta la visita, se propone la nueva (o queda en el admin) y
 *    el pedido vuelve a pendiente sin chofer por el camino único de liberación
 *    (máquina de estados). El stock reservado y el pago no se tocan.
 * Después se avisa al cliente y al panel.
 */
@Injectable()
export class ReportFailedDeliveryUseCase {
  private readonly logger = new Logger(ReportFailedDeliveryUseCase.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly deliveries: DeliveryService,
    private readonly release: ReleaseOrderUseCase,
    private readonly visitas: FailedVisitService,
    private readonly avisos: FailedVisitNotifier,
    private readonly paradas: RouteSheetStopsService,
  ) {}

  async execute(input: NoPudeEntregar): Promise<ResultadoDeNoEntrega> {
    const esChofer = input.role === RoleType.DELIVERY;
    const esAdmin =
      input.role === RoleType.ADMIN || input.role === RoleType.SUPER_ADMIN;
    if (!esChofer && !esAdmin) {
      throw new ForbiddenException(
        'Sólo el chofer asignado o un administrador informan una entrega fallida',
      );
    }
    this.validar(input, esChofer);

    const pedido = await this.dataSource.manager.findOne(Order, {
      where: { orderId: input.orderId },
    });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
    const deliveryId = esChofer
      ? await this.deliveryIdDelChofer(pedido, input.userId)
      : null;

    const parada = await this.paradaEnCurso(input.orderId);
    if (parada) return this.deHoja(pedido, parada, input, esChofer);
    return this.suelto(input, deliveryId);
  }

  /** Lo que no depende del estado del pedido: corta rápido sin escribir. */
  private validar(input: NoPudeEntregar, esChofer: boolean): void {
    if (
      input.reason === FailedVisitReason.OTHER &&
      (input.note?.trim().length ?? 0) < 3
    ) {
      throw conCodigo(
        BadRequestException,
        400,
        'Contá en una nota por qué no se pudo entregar',
        'VALIDATION',
      );
    }
    if (esChofer && (input.latitude == null || input.longitude == null)) {
      throw conCodigo(
        BadRequestException,
        400,
        'Para informar que no pudiste entregar mandá tu ubicación',
        'VALIDATION',
      );
    }
  }

  private async deliveryIdDelChofer(
    pedido: Order,
    userId: string,
  ): Promise<string> {
    const chofer = await this.deliveries.buscarPorIdOUsuario(userId);
    if (!chofer || pedido.deliveryId !== chofer.deliveryId) {
      throw this.noAsignado();
    }
    return chofer.deliveryId;
  }

  /** La hoja de ruta en curso de la que el pedido es parada activa, si hay. */
  private async paradaEnCurso(
    orderId: string,
  ): Promise<{ sheetId: string; failedAttempts: number } | null> {
    const [fila]: Array<{ sheetId: string; failedAttempts: number }> =
      await this.dataSource.query(
        `SELECT b."batch_id" AS "sheetId", s."failed_attempts" AS "failedAttempts"
           FROM "route_batch_stop" s
           JOIN "route_batch" b ON b."batch_id" = s."batch_id"
          WHERE s."order_id" = $1 AND s."active"
            AND b."kind" = 'planned' AND b."status" = 'assigned'
          LIMIT 1`,
        [orderId],
      );
    return fila
      ? { sheetId: fila.sheetId, failedAttempts: Number(fila.failedAttempts) }
      : null;
  }

  private async deHoja(
    pedido: Order,
    parada: { sheetId: string; failedAttempts: number },
    input: NoPudeEntregar,
    esChofer: boolean,
  ): Promise<ResultadoDeNoEntrega> {
    // En el primer intento el chofer vuelve a pasar hoy: no hay día que acordar.
    if (input.agreed && parada.failedAttempts < 1) {
      throw conCodigo(
        ConflictException,
        409,
        'En el primer intento de la hoja de ruta el pedido vuelve a pasar hoy, al final del recorrido: no se acuerda otro día',
        FailedDeliveryError.ACUERDO_EN_REINTENTO,
      );
    }
    const r = await this.paradas.noEntregada(
      pedido.distributorId,
      parada.sheetId,
      pedido.orderId,
      { userId: input.userId, esChofer },
      { reason: MOTIVO_DE_HOJA[input.reason], note: input.note ?? undefined },
      input,
    );
    // La hoja asienta la visita en la misma transacción que la parada: si no
    // pudo, no cambió nada y el error ya subió.
    return {
      ...r.visita,
      deliveryKind: DeliveryKind.ROUTE_SHEET,
      nextOrderId: r.nextOrderId,
    };
  }

  private async suelto(
    input: NoPudeEntregar,
    deliveryId: string | null,
  ): Promise<ResultadoDeNoEntrega> {
    const { pedido, resultado, choferAnterior } =
      await this.dataSource.transaction(async (manager) => {
        const locked = await manager
          .createQueryBuilder(Order, 'ord')
          .setLock('pessimistic_write', undefined, ['ord'])
          .leftJoinAndSelect('ord.delivery', 'delivery')
          .where('ord.orderId = :id', { id: input.orderId })
          .getOne();
        if (!locked) throw new NotFoundException('Pedido no encontrado');
        if (locked.status !== OrderStatus.ON_THE_WAY) throw this.noEnCamino();
        // Una reasignación en el medio deja afuera al chofer anterior.
        if (deliveryId && locked.deliveryId !== deliveryId) {
          throw this.noAsignado();
        }
        const res = await this.visitas.registrar(manager, locked, input);
        const anterior = await this.release.releaseWithin(manager, locked);
        const guardado = await manager.save(locked);
        return { pedido: guardado, resultado: res, choferAnterior: anterior };
      });

    try {
      await this.release.notifyReleased(pedido, choferAnterior, {
        porEntregaFallida: true,
      });
    } catch (error) {
      this.logger.warn(
        `Pedido ${pedido.orderId}: entrega fallida asentada, pero falló un aviso de la liberación: ${errorMessage(error)}`,
      );
    }
    await this.avisos
      .visitaFallida(pedido, motivoLegible(input))
      .catch((error: unknown) =>
        this.logger.warn(
          `Pedido ${pedido.orderId}: no se avisó la nueva visita: ${errorMessage(error)}`,
        ),
      );
    return {
      ...resultado,
      deliveryKind: resultado.visit.deliveryKind,
      nextOrderId: null,
    };
  }

  private noEnCamino(): ConflictException {
    return conCodigo(
      ConflictException,
      409,
      'El pedido no está en camino: no se puede informar una entrega fallida',
      FailedDeliveryError.NO_EN_CAMINO,
    );
  }

  private noAsignado(): ForbiddenException {
    return new ForbiddenException('Este pedido no está asignado a tu usuario');
  }
}
