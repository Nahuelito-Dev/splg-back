import { Cylinder } from './entities/cylinder.entity';
import { CylinderMovement } from './entities/cylinder-movement.entity';
import {
  CylinderMovementResponseDto,
  CylinderResponseDto,
} from './dto/cylinder-response.dto';

export class CylinderMapper {
  static toDto(c: Cylinder): CylinderResponseDto {
    const dto = new CylinderResponseDto();
    dto.cylinder_id = c.cylinder_id;
    dto.distributor_id = c.distributor_id;
    dto.serial = c.serial;
    dto.gas_cylinder_id = c.gas_cylinder_id;
    dto.state = c.state;
    dto.current_customer_id = c.current_customer_id;
    dto.current_order_id = c.current_order_id;
    dto.deposit = c.deposit;
    dto.createdAt = c.createdAt;
    dto.updatedAt = c.updatedAt;
    return dto;
  }

  static movimientoToDto(m: CylinderMovement): CylinderMovementResponseDto {
    const dto = new CylinderMovementResponseDto();
    dto.movement_id = m.movement_id;
    dto.cylinder_id = m.cylinder_id;
    dto.distributor_id = m.distributor_id;
    dto.from_state = m.from_state;
    dto.to_state = m.to_state;
    dto.order_id = m.order_id;
    dto.actor_user_id = m.actor_user_id;
    dto.note = m.note;
    dto.createdAt = m.createdAt;
    return dto;
  }
}
