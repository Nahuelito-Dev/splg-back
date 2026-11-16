import { AsientoConNombre } from '../application/commission-query.service';
import { ReglaConNombres } from '../application/commission-rule.service';
import { LiquidacionConEmpleado } from '../application/driver-liquidation.service';
import {
  CommissionEntryResponseDto,
  CommissionRuleResponseDto,
} from '../dto/commission.dto';
import {
  DriverLiquidationDetailDto,
  DriverLiquidationResponseDto,
} from '../dto/driver-liquidation.dto';
import { CommissionEntry } from '../entities/commission-entry.entity';

export class CommissionMapper {
  static regla(r: ReglaConNombres): CommissionRuleResponseDto {
    const dto = new CommissionRuleResponseDto();
    dto.ruleId = r.regla.ruleId;
    dto.employeeId = r.regla.employeeId;
    dto.employeeName = r.employeeName;
    dto.gasCylinderId = r.regla.gasCylinderId;
    dto.gasCylinderType = r.gasCylinderType;
    dto.basis = r.regla.basis;
    dto.value = r.regla.value;
    dto.validFrom = r.regla.validFrom;
    dto.validTo = r.regla.validTo;
    dto.isActive = r.regla.isActive;
    dto.createdAt = r.regla.createdAt;
    dto.updatedAt = r.regla.updatedAt;
    return dto;
  }

  static asiento(a: AsientoConNombre): CommissionEntryResponseDto {
    return CommissionMapper.asientoDe(a.asiento, a.employeeName);
  }

  static asientoDe(
    a: CommissionEntry,
    employeeName: string,
  ): CommissionEntryResponseDto {
    const dto = new CommissionEntryResponseDto();
    dto.entryId = a.entryId;
    dto.employeeId = a.employeeId;
    dto.employeeName = employeeName;
    dto.deliveryId = a.deliveryId;
    dto.type = a.type;
    dto.amount = a.amount;
    dto.orderId = a.orderId;
    dto.ruleId = a.ruleId;
    dto.liquidationId = a.liquidationId;
    dto.description = a.description;
    dto.occurredAt = a.occurredAt;
    return dto;
  }

  static liquidacion(l: LiquidacionConEmpleado): DriverLiquidationResponseDto {
    return CommissionMapper.llenar(new DriverLiquidationResponseDto(), l);
  }

  static liquidacionConAsientos(
    l: LiquidacionConEmpleado,
    asientos: CommissionEntry[],
  ): DriverLiquidationDetailDto {
    const dto = CommissionMapper.llenar(new DriverLiquidationDetailDto(), l);
    dto.entries = asientos.map((a) =>
      CommissionMapper.asientoDe(a, l.employeeName),
    );
    return dto;
  }

  private static llenar<T extends DriverLiquidationResponseDto>(
    dto: T,
    l: LiquidacionConEmpleado,
  ): T {
    const x = l.liquidacion;
    dto.liquidationId = x.liquidationId;
    dto.number = x.number;
    dto.employeeId = x.employeeId;
    dto.employeeName = l.employeeName;
    dto.periodFrom = x.periodFrom;
    dto.periodTo = x.periodTo;
    dto.gross = x.gross;
    dto.deductions = x.deductions;
    dto.net = x.net;
    dto.status = x.status;
    dto.approvedAt = x.approvedAt;
    dto.paidAt = x.paidAt;
    dto.voidedAt = x.voidedAt;
    dto.cashMovementId = x.cashMovementId;
    dto.createdAt = x.createdAt;
    return dto;
  }
}
