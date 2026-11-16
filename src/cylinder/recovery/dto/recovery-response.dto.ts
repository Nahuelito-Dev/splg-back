import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProposalStatus } from '../../../common/enums/proposal-status.enum';
import { CylinderState } from '../../entities/cylinder.entity';
import { RecoveryCaseStatus } from '../../entities/cylinder-recovery-case.entity';
import { RecoveryNoticeKind } from '../../entities/cylinder-recovery-notice.entity';
import { OrderStatus } from '../../../order/entities/order.entity';

export class RecoveryCustomerDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ type: String, nullable: true }) fullName!: string | null;
  @ApiProperty({ type: String, nullable: true }) email!: string | null;
  @ApiProperty({ type: String, nullable: true }) phoneNumber!: string | null;
}

export class RecoveryCylinderDto {
  @ApiProperty({ format: 'uuid' }) cylinderId!: string;
  @ApiProperty({ example: 'SN-001234' }) serial!: string;
  @ApiProperty({ enum: CylinderState }) state!: CylinderState;
  @ApiProperty({ type: String, nullable: true, example: '10kg' })
  product!: string | null;
}

export class RecoveryNoticeDto {
  @ApiProperty({ format: 'uuid' }) noticeId!: string;
  @ApiProperty({ minimum: 1, maximum: 3 }) step!: number;
  @ApiProperty({ enum: RecoveryNoticeKind }) kind!: RecoveryNoticeKind;
  @ApiProperty({
    enum: ProposalStatus,
    nullable: true,
    description:
      'Sólo en la oferta de retiro: pending, accepted, rejected o expired',
  })
  status!: ProposalStatus | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Pedido en el que se ofrece el retiro (sólo en la oferta)',
  })
  orderId!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) sentAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  respondedAt!: Date | null;
  @ApiProperty({ type: String, nullable: true }) responseNote!: string | null;
}

/** La oferta de retiro vigente (pendiente o aceptada) y el pedido que la lleva. */
export class RecoveryPickupDto {
  @ApiProperty({ format: 'uuid' }) noticeId!: string;
  @ApiProperty({ enum: ProposalStatus }) status!: ProposalStatus;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-11-04',
    description: 'Día agendado de la entrega',
  })
  scheduledDate!: string | null;
  @ApiProperty({ enum: OrderStatus, nullable: true })
  orderStatus!: OrderStatus | null;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: Date;
}

export class RecoveryCaseDto {
  @ApiProperty({ format: 'uuid' }) caseId!: string;
  @ApiProperty({ enum: RecoveryCaseStatus }) status!: RecoveryCaseStatus;
  @ApiProperty({
    minimum: 1,
    maximum: 3,
    description: '1 recordatorio, 2 aviso del depósito, 3 secuencia agotada',
  })
  step!: number;
  @ApiProperty({ example: 25000 }) depositAmount!: number;
  @ApiProperty({ type: String, format: 'date-time' }) deliveredAt!: Date;
  @ApiProperty({ description: 'Días que el envase lleva en poder del cliente' })
  daysOut!: number;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Cuándo vence el escalón actual',
  })
  stepDueAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) openedAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  exhaustedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt!: Date | null;
  @ApiProperty({ type: RecoveryCustomerDto }) customer!: RecoveryCustomerDto;
  @ApiProperty({ type: RecoveryCylinderDto }) cylinder!: RecoveryCylinderDto;
  @ApiProperty({ type: RecoveryNoticeDto, nullable: true })
  lastNotice!: RecoveryNoticeDto | null;
  @ApiProperty({ type: RecoveryPickupDto, nullable: true })
  pickup!: RecoveryPickupDto | null;
}

export class RecoveryMovementDto {
  @ApiProperty({ format: 'uuid' }) movementId!: string;
  @ApiProperty({ enum: CylinderState, nullable: true })
  fromState!: CylinderState | null;
  @ApiProperty({ enum: CylinderState }) toState!: CylinderState;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  orderId!: string | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
}

export class RecoveryResolutionDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  resolvedByUserId!: string | null;
  @ApiProperty({ type: String, nullable: true }) resolvedByName!: string | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
}

/** El legajo: el caso con los avisos enviados y el historial completo del envase. */
export class RecoveryCaseDetailDto extends RecoveryCaseDto {
  @ApiProperty({ type: [RecoveryNoticeDto] }) notices!: RecoveryNoticeDto[];
  @ApiProperty({ type: [RecoveryMovementDto] })
  history!: RecoveryMovementDto[];
  @ApiPropertyOptional({ type: RecoveryResolutionDto, nullable: true })
  resolution!: RecoveryResolutionDto | null;
}

export class RecoveryCasePageDto {
  @ApiProperty({ type: [RecoveryCaseDto] }) data!: RecoveryCaseDto[];
  @ApiProperty() total!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { open: 3, escalated: 1, lost: 2 },
    description: 'Casos de la distribuidora por estado (sin filtros)',
  })
  counts!: Record<string, number>;
}

export class RecoveryManualReviewDto {
  @ApiProperty({ format: 'uuid' }) cylinderId!: string;
  @ApiProperty() serial!: string;
  @ApiProperty({ enum: ['sin_cliente', 'sin_entrega_registrada'] })
  reason!: 'sin_cliente' | 'sin_entrega_registrada';
}

export class RecoveryReportTotalsDto {
  @ApiProperty() lostCount!: number;
  @ApiProperty() lostAmount!: number;
  @ApiProperty() escalatedCount!: number;
  @ApiProperty() escalatedAmount!: number;
  @ApiProperty() manualReviewCount!: number;
}

/** Reporte de envases perdidos y casos sin resolver (CU-108, excepciones 10 y 11). */
export class RecoveryReportDto {
  @ApiProperty({
    type: [RecoveryCaseDto],
    description: 'Envases perdidos: importe bajo el umbral, sólo informados',
  })
  lost!: RecoveryCaseDto[];
  @ApiProperty({
    type: [RecoveryCaseDto],
    description: 'Escalados que el administrador todavía no resolvió',
  })
  escalated!: RecoveryCaseDto[];
  @ApiProperty({
    type: [RecoveryManualReviewDto],
    description:
      'Envases con cliente cuyo titular o entrega no se puede determinar',
  })
  manualReview!: RecoveryManualReviewDto[];
  @ApiProperty({ type: RecoveryReportTotalsDto })
  totals!: RecoveryReportTotalsDto;
}

export class RecoveryRunResponseDto {
  @ApiProperty() opened!: number;
  @ApiProperty() notices!: number;
  @ApiProperty() offers!: number;
  @ApiProperty() escalated!: number;
  @ApiProperty() lost!: number;
  @ApiProperty() closedByReturn!: number;
  @ApiProperty({
    description:
      'Casos cerrados sin cargo porque, con «Cobrar envases» encendido, el envase quedó cubierto por los envases propios del cliente (cuenta de envases). Con el cobro apagado siempre es 0.',
  })
  closedCoveredByOwned!: number;
  @ApiProperty() manualReview!: number;
}

/** Un retiro acordado, como lo ve el chofer en el recorrido. */
export class DriverPickupDto {
  @ApiProperty({ format: 'uuid' }) noticeId!: string;
  @ApiProperty({ format: 'uuid' }) caseId!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ enum: OrderStatus }) orderStatus!: OrderStatus;
  @ApiProperty({ type: String, nullable: true, example: '2026-11-04' })
  scheduledDate!: string | null;
  @ApiProperty() serial!: string;
  @ApiProperty({ type: String, nullable: true, example: '10kg' })
  product!: string | null;
  @ApiProperty({ example: 25000 }) depositAmount!: number;
  @ApiProperty({ type: String, nullable: true }) customerName!: string | null;
  @ApiProperty({ type: String, nullable: true }) customerPhone!: string | null;
}
