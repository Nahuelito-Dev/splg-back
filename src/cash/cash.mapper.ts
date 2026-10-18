import { CashBoxResponseDto } from './dto/cash-box.dto';
import { CashCategoryResponseDto } from './dto/cash-category.dto';
import { CashMovementResponseDto } from './dto/cash-movement.dto';
import {
  CashSessionDetailDto,
  CashSessionResponseDto,
} from './dto/cash-session.dto';
import { CashBox } from './entities/cash-box.entity';
import { CashCategory } from './entities/cash-category.entity';
import { CashMovement } from './entities/cash-movement.entity';
import { CashSession } from './entities/cash-session.entity';

export class CashMapper {
  static caja(c: CashBox, openSessionId: string | null): CashBoxResponseDto {
    const dto = new CashBoxResponseDto();
    dto.cashBoxId = c.cashBoxId;
    dto.name = c.name;
    dto.kind = c.kind;
    dto.balance = c.balance;
    dto.requiresSession = c.requiresSession;
    dto.isActive = c.isActive;
    dto.openSessionId = openSessionId;
    dto.createdAt = c.createdAt;
    dto.updatedAt = c.updatedAt;
    return dto;
  }

  static categoria(c: CashCategory): CashCategoryResponseDto {
    const dto = new CashCategoryResponseDto();
    dto.categoryId = c.categoryId;
    dto.name = c.name;
    dto.direction = c.direction;
    dto.systemCode = c.systemCode;
    dto.isActive = c.isActive;
    dto.createdAt = c.createdAt;
    dto.updatedAt = c.updatedAt;
    return dto;
  }

  static sesion(s: CashSession, cashBoxName: string): CashSessionResponseDto {
    return CashMapper.llenarSesion(
      new CashSessionResponseDto(),
      s,
      cashBoxName,
    );
  }

  static sesionConDetalle(
    s: CashSession,
    cashBoxName: string,
    detalle: {
      currentBalance: number;
      totalIn: number;
      totalOut: number;
      movements: CashMovementResponseDto[];
    },
  ): CashSessionDetailDto {
    const dto = CashMapper.llenarSesion(
      new CashSessionDetailDto(),
      s,
      cashBoxName,
    );
    dto.currentBalance = detalle.currentBalance;
    dto.totalIn = detalle.totalIn;
    dto.totalOut = detalle.totalOut;
    dto.movements = detalle.movements;
    return dto;
  }

  private static llenarSesion<T extends CashSessionResponseDto>(
    dto: T,
    s: CashSession,
    cashBoxName: string,
  ): T {
    dto.sessionId = s.sessionId;
    dto.cashBoxId = s.cashBoxId;
    dto.cashBoxName = cashBoxName;
    dto.status = s.status;
    dto.openedAt = s.openedAt;
    dto.openedByUserId = s.openedByUserId;
    dto.openingAmount = s.openingAmount;
    dto.closedAt = s.closedAt;
    dto.closedByUserId = s.closedByUserId;
    dto.expectedAmount = s.expectedAmount;
    dto.countedAmount = s.countedAmount;
    dto.difference = s.difference;
    dto.notes = s.notes;
    return dto;
  }

  static movimiento(
    m: CashMovement,
    extra: { cashBoxName: string; categoryName: string; reversed: boolean },
  ): CashMovementResponseDto {
    const dto = new CashMovementResponseDto();
    dto.movementId = m.movementId;
    dto.cashBoxId = m.cashBoxId;
    dto.cashBoxName = extra.cashBoxName;
    dto.sessionId = m.sessionId;
    dto.direction = m.direction;
    dto.amount = m.amount;
    dto.categoryId = m.categoryId;
    dto.categoryName = extra.categoryName;
    dto.method = m.method;
    dto.occurredAt = m.occurredAt;
    dto.description = m.description;
    dto.referenceType = m.referenceType;
    dto.referenceId = m.referenceId;
    dto.reversesMovementId = m.reversesMovementId;
    dto.reversed = extra.reversed;
    dto.createdByUserId = m.createdByUserId;
    dto.createdAt = m.createdAt;
    return dto;
  }
}
