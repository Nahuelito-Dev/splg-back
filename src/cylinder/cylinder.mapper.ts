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
    dto.createdAt = c.createdAt;
    dto.updatedAt = c.updatedAt;
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
