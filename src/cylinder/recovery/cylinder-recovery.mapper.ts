import { ProposalStatus } from '../../common/enums/proposal-status.enum';
import { OrderRecoveryRef } from '../../order/lookup/order-lookup.service';
import { CylinderMovement } from '../entities/cylinder-movement.entity';
import { CylinderRecoveryCase } from '../entities/cylinder-recovery-case.entity';
import {
  CylinderRecoveryNotice,
  RecoveryNoticeKind,
} from '../entities/cylinder-recovery-notice.entity';
import {
  RecoveryCaseDetailDto,
  RecoveryCaseDto,
  RecoveryMovementDto,
  RecoveryNoticeDto,
  RecoveryPickupDto,
  RecoveryRiskDto,
} from './dto/recovery-response.dto';

/** Lo que el caso toma de fuera de sus avisos: el número de cada hoja y el riesgo de cada cliente. */
export interface ExtrasDelCaso {
  hojas?: ReadonlyMap<string, number | null>;
  riesgos?: ReadonlyMap<string, RecoveryRiskDto>;
}

const MS_POR_DIA = 24 * 60 * 60 * 1000;

export class CylinderRecoveryMapper {
  static aviso(
    n: CylinderRecoveryNotice,
    hojas: ReadonlyMap<string, number | null> = new Map(),
  ): RecoveryNoticeDto {
    return {
      noticeId: n.noticeId,
      step: n.step,
      kind: n.kind,
      status: n.status,
      orderId: n.orderId,
      sentAt: n.sentAt,
      expiresAt: n.expiresAt,
      respondedAt: n.respondedAt,
      responseNote: n.responseNote,
      routeBatchId: n.routeBatchId ?? null,
      opportunistic: Boolean(n.routeBatchId),
      routeSheetNumber: n.routeBatchId
        ? (hojas.get(n.routeBatchId) ?? null)
        : null,
    };
  }

  /** La oferta de retiro que sigue en pie (pendiente o aceptada), si la hay. */
  static retiroVigente(
    avisos: CylinderRecoveryNotice[],
    pedidos: Map<string, OrderRecoveryRef>,
    hojas: ReadonlyMap<string, number | null> = new Map(),
  ): RecoveryPickupDto | null {
    const oferta = [...avisos]
      .reverse()
      .find(
        (a) =>
          a.kind === RecoveryNoticeKind.PICKUP_OFFER &&
          (a.status === ProposalStatus.PENDING ||
            a.status === ProposalStatus.ACCEPTED),
      );
    if (!oferta || !oferta.orderId || !oferta.status) return null;
    const pedido = pedidos.get(oferta.orderId);
    return {
      noticeId: oferta.noticeId,
      status: oferta.status,
      orderId: oferta.orderId,
      scheduledDate: pedido?.scheduledDate ?? null,
      orderStatus: pedido?.status ?? null,
      expiresAt: oferta.expiresAt,
      opportunistic: Boolean(oferta.routeBatchId),
      routeSheetNumber: oferta.routeBatchId
        ? (hojas.get(oferta.routeBatchId) ?? null)
        : null,
    };
  }

  static caso(
    c: CylinderRecoveryCase,
    avisos: CylinderRecoveryNotice[],
    pedidos: Map<string, OrderRecoveryRef>,
    ahora: Date,
    extras: ExtrasDelCaso = {},
  ): RecoveryCaseDto {
    const fin = c.closedAt ?? ahora;
    const ultimo = avisos.filter(
      (a) => a.kind !== RecoveryNoticeKind.PICKUP_OFFER,
    );
    return {
      caseId: c.caseId,
      status: c.status,
      step: c.step,
      depositAmount: c.depositAmount,
      deliveredAt: c.deliveredAt,
      daysOut: Math.max(
        0,
        Math.floor((fin.getTime() - c.deliveredAt.getTime()) / MS_POR_DIA),
      ),
      stepDueAt: c.stepDueAt,
      openedAt: c.openedAt,
      exhaustedAt: c.exhaustedAt,
      closedAt: c.closedAt,
      customer: {
        userId: c.userId,
        fullName: c.user?.fullName ?? null,
        email: c.user?.email ?? null,
        phoneNumber: c.user?.phoneNumber ?? null,
      },
      cylinder: {
        cylinderId: c.cylinderId,
        serial: c.cylinder?.serial ?? '',
        state: c.cylinder.state,
        product: c.cylinder?.gasCylinder?.type ?? null,
      },
      lastNotice: ultimo.length
        ? CylinderRecoveryMapper.aviso(ultimo[ultimo.length - 1], extras.hojas)
        : null,
      pickup: CylinderRecoveryMapper.retiroVigente(
        avisos,
        pedidos,
        extras.hojas,
      ),
      risk: extras.riesgos?.get(c.userId),
    };
  }

  static movimiento(m: CylinderMovement): RecoveryMovementDto {
    return {
      movementId: m.movementId,
      fromState: m.fromState,
      toState: m.toState,
      orderId: m.orderId,
      note: m.note,
      createdAt: m.createdAt,
    };
  }

  static detalle(
    c: CylinderRecoveryCase,
    avisos: CylinderRecoveryNotice[],
    pedidos: Map<string, OrderRecoveryRef>,
    historial: CylinderMovement[],
    resolvio: { fullName: string | null } | null,
    ahora: Date,
    extras: ExtrasDelCaso = {},
  ): RecoveryCaseDetailDto {
    return {
      ...CylinderRecoveryMapper.caso(c, avisos, pedidos, ahora, extras),
      notices: avisos.map((a) => CylinderRecoveryMapper.aviso(a, extras.hojas)),
      history: historial.map((m) => CylinderRecoveryMapper.movimiento(m)),
      resolution:
        c.closedAt && (c.resolvedByUserId || c.resolutionNote)
          ? {
              resolvedByUserId: c.resolvedByUserId,
              resolvedByName: resolvio?.fullName ?? null,
              note: c.resolutionNote,
            }
          : null,
    };
  }
}
