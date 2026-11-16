import {
  MpReconciliationDetailResponseDto,
  MpReconciliationItemResponseDto,
  MpReconciliationResponseDto,
  MpSummaryDto,
} from './dto/mp-reconciliation.dto';
import { brechaNeta, totalDeDiferencias } from './domain/reconciliation';
import { MpReconciliationStatus } from './domain/mp-reconciliation.enums';
import { MpReconciliationItem } from './entities/mp-reconciliation-item.entity';
import {
  MpReconciliation,
  MpReconciliationSummary,
} from './entities/mp-reconciliation.entity';

export class MpReconciliationMapper {
  /** El super admin ve además el total de lo que no es de ninguna distribuidora. */
  static resumen(
    resumen: MpReconciliationSummary | null,
    verCuenta: boolean,
  ): MpSummaryDto | null {
    if (!resumen) return null;
    const dto = new MpSummaryDto();
    dto.rows = resumen.rows;
    dto.mp = resumen.mp;
    dto.cash = resumen.cash;
    dto.differences = resumen.differences;
    dto.differenceCount = totalDeDiferencias(resumen.differences);
    dto.netGap = brechaNeta(resumen.mp.net, resumen.cash.net);
    dto.alreadyApplied = resumen.alreadyApplied;
    dto.unreadableRows = resumen.unreadableRows;
    if (verCuenta && resumen.account) dto.account = resumen.account;
    return dto;
  }

  static corrida(
    c: MpReconciliation,
    verCuenta: boolean,
  ): MpReconciliationResponseDto {
    const dto = new MpReconciliationResponseDto();
    dto.reconciliationId = c.reconciliationId;
    dto.distributorId = c.distributorId;
    dto.from = c.fromDate;
    dto.to = c.toDate;
    dto.status = c.status;
    dto.failureReason =
      c.status === MpReconciliationStatus.FAILED ? c.failureReason : null;
    dto.statusNote =
      c.status !== MpReconciliationStatus.REQUESTED
        ? null
        : (c.failureReason ??
          (c.lastCheckedAt
            ? 'Mercado Pago todavía no generó el reporte: se vuelve a consultar solo.'
            : 'Todavía no se consultó a Mercado Pago.'));
    dto.summary = MpReconciliationMapper.resumen(c.summary, verCuenta);
    dto.hasReport = !!c.reportAttachmentId;
    dto.readyAt = c.readyAt;
    dto.lastCheckedAt = c.lastCheckedAt;
    dto.createdAt = c.createdAt;
    dto.includesAccountLevel = c.includeAccountLevel;
    return dto;
  }

  static item(i: MpReconciliationItem): MpReconciliationItemResponseDto {
    const dto = new MpReconciliationItemResponseDto();
    dto.itemId = i.itemId;
    dto.kind = i.kind;
    dto.sourceId = i.sourceId;
    dto.paymentId = i.paymentId;
    dto.orderId = i.orderId;
    dto.occurredAt = i.occurredAt;
    dto.mpDescription = i.mpDescription;
    dto.mpAmount = i.mpAmount;
    dto.ledgerAmount = i.ledgerAmount;
    dto.difference = i.difference;
    dto.extraAmount = i.extraAmount;
    dto.direction = i.direction;
    dto.appliable = i.appliable;
    dto.needsCashBox = i.needsCashBox;
    dto.accountLevel = i.accountLevel;
    dto.note = i.note;
    dto.status = i.status;
    dto.appliedAt = i.appliedAt;
    dto.appliedMovementId = i.appliedMovementId;
    return dto;
  }

  static detalle(
    c: MpReconciliation,
    items: MpReconciliationItem[],
    verCuenta: boolean,
  ): MpReconciliationDetailResponseDto {
    const dto = new MpReconciliationDetailResponseDto();
    Object.assign(dto, MpReconciliationMapper.corrida(c, verCuenta));
    dto.items = items.map((i) => MpReconciliationMapper.item(i));
    return dto;
  }
}
