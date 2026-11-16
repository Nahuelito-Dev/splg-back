import { VehicleAssignment } from '../car/entities/vehicle-assignment.entity';
import {
  VehicleAssignmentHistoryResponseDto,
  VehicleInUseResponseDto,
} from './dto/vehicle-assignment-response.dto';

export class VehicleAssignmentMapper {
  /** `isLocked` no es un campo de la entidad: lo calcula el caller con `FleetTaskService`. */
  static toVehicleInUseDto(
    a: VehicleAssignment,
    isLocked: boolean,
  ): VehicleInUseResponseDto {
    const dto = new VehicleInUseResponseDto();
    dto.deliveryId = a.deliveryId;
    dto.carId = a.carId;
    dto.carPatent = a.car?.carPatent ?? null;
    dto.carBrand = a.car?.carBrand ?? null;
    dto.carModel = a.car?.carModel ?? null;
    dto.carTypeCar = a.car?.typeCar ?? null;
    dto.isLocked = isLocked;
    dto.assignedAt = a.assignedAt;
    dto.note = a.note;
    return dto;
  }

  static toHistoryDto(
    a: VehicleAssignment,
  ): VehicleAssignmentHistoryResponseDto {
    const dto = new VehicleAssignmentHistoryResponseDto();
    dto.assignmentId = a.assignmentId;
    dto.carId = a.carId;
    dto.carPatent = a.car?.carPatent ?? null;
    dto.carBrand = a.car?.carBrand ?? null;
    dto.carModel = a.car?.carModel ?? null;
    dto.deliveryId = a.deliveryId;
    dto.driverName = a.delivery?.user?.fullName ?? null;
    dto.assignedAt = a.assignedAt;
    dto.releasedAt = a.releasedAt;
    dto.note = a.note;
    return dto;
  }
}
