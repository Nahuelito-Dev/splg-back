import { Cylinder } from './entities/cylinder.entity';
import { CylinderMovement } from './entities/cylinder-movement.entity';
import {
  CylinderMovementResponseDto,
  CylinderResponseDto,
} from './dto/cylinder-response.dto';
import { CylinderInspection } from './entities/cylinder-inspection.entity';
import {
  CylinderInspectionResponseDto,
  CylinderVencimientoDto,
  CylinderVigenciaResponseDto,
  ExpiringCylindersResponseDto,
} from './dto/cylinder-vigencia-response.dto';
import type {
  EnvaseConVigencia,
  VencimientosDelParque,
  VigenciaDeEnvase,
} from './cylinder-vigencia.service';

export class CylinderMapper {
  static toDto(c: Cylinder): CylinderResponseDto {
    const dto = new CylinderResponseDto();
    dto.cylinder_id = c.cylinderId;
    dto.distributor_id = c.distributorId;
    dto.serial = c.serial;
    dto.gas_cylinder_id = c.gasCylinderId;
    dto.state = c.state;
    dto.current_customer_id = c.currentCustomerId;
    dto.current_order_id = c.currentOrderId;
    dto.deposit = c.deposit;
    dto.photoUrl = c.photoSignedUrl ?? null;
    // Las relaciones vienen sólo si la consulta las cargó (listado y detalle).
    dto.gas_cylinder = c.gasCylinder
      ? {
          type: c.gasCylinder.type,
          weight: c.gasCylinder.weight,
          photoUrl: c.gasCylinder.photoSignedUrl ?? null,
        }
      : null;
    dto.current_customer = c.currentCustomer
      ? {
          user_id: c.currentCustomer.userId,
          full_name: c.currentCustomer.fullName ?? null,
          phone_number: c.currentCustomer.phoneNumber ?? null,
        }
      : null;
    dto.manufactured_at = c.manufacturedAt;
    dto.last_inspection_at = c.lastInspectionAt;
    dto.expires_at = c.expiresAt;
    dto.createdAt = c.createdAt;
    dto.updatedAt = c.updatedAt;
    dto.lastMovementAt = c.lastMovementAt ?? null;
    return dto;
  }

  static movimientoToDto(m: CylinderMovement): CylinderMovementResponseDto {
    const dto = new CylinderMovementResponseDto();
    dto.movement_id = m.movementId;
    dto.cylinder_id = m.cylinderId;
    dto.distributor_id = m.distributorId;
    dto.from_state = m.fromState;
    dto.to_state = m.toState;
    dto.order_id = m.orderId;
    dto.actor_user_id = m.actorUserId;
    dto.note = m.note;
    dto.createdAt = m.createdAt;
    return dto;
  }

  static inspectionToDto(i: CylinderInspection): CylinderInspectionResponseDto {
    const dto = new CylinderInspectionResponseDto();
    dto.inspectionId = i.inspectionId;
    dto.cylinderId = i.cylinderId;
    dto.inspectedAt = i.inspectedAt;
    dto.result = i.result;
    dto.nextDueAt = i.nextDueAt;
    dto.notes = i.notes;
    return dto;
  }

  static vencimientoToDto(e: EnvaseConVigencia): CylinderVencimientoDto {
    const dto = new CylinderVencimientoDto();
    CylinderMapper.llenarVencimiento(dto, e);
    return dto;
  }

  static vigenciaToDto(v: VigenciaDeEnvase): CylinderVigenciaResponseDto {
    const dto = new CylinderVigenciaResponseDto();
    CylinderMapper.llenarVencimiento(dto, v);
    dto.manufacturedAt = v.cylinder.manufacturedAt;
    dto.withdrawalPending = v.retiroPendiente;
    dto.inspections = v.inspections.map((i) =>
      CylinderMapper.inspectionToDto(i),
    );
    return dto;
  }

  static vencimientosToDto(
    v: VencimientosDelParque,
  ): ExpiringCylindersResponseDto {
    const dto = new ExpiringCylindersResponseDto();
    dto.windowDays = v.windowDays;
    dto.totals = v.totals;
    dto.expired = v.expired.map((e) => CylinderMapper.vencimientoToDto(e));
    dto.expiring = v.expiring.map((e) => CylinderMapper.vencimientoToDto(e));
    dto.unverified = v.unverified.map((e) =>
      CylinderMapper.vencimientoToDto(e),
    );
    return dto;
  }

  private static llenarVencimiento(
    dto: CylinderVencimientoDto,
    e: EnvaseConVigencia,
  ): void {
    dto.cylinderId = e.cylinder.cylinderId;
    dto.serial = e.cylinder.serial;
    dto.state = e.cylinder.state;
    dto.productType = e.cylinder.gasCylinder?.type ?? null;
    dto.lastInspectionAt = e.cylinder.lastInspectionAt;
    dto.expiresAt = e.cylinder.expiresAt;
    dto.status = e.vigencia.estado;
    dto.daysRemaining = e.vigencia.diasRestantes;
  }
}
