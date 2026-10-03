import { Cylinder } from './entities/cylinder.entity';
import { CylinderMovement } from './entities/cylinder-movement.entity';
import {
  CylinderMovementResponseDto,
  CylinderResponseDto,
} from './dto/cylinder-response.dto';

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
    // Las relaciones vienen sólo si la consulta las cargó (listado y detalle).
    dto.gas_cylinder = c.gasCylinder
      ? { type: c.gasCylinder.type, weight: c.gasCylinder.weight }
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
}
