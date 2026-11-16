import { TimeSlot } from './entities/time-slot.entity';
import { TimeSlotResponseDto } from './dto/time-slot-response.dto';

export class TimeSlotMapper {
  static toDto(t: TimeSlot): TimeSlotResponseDto {
    const dto = new TimeSlotResponseDto();
    dto.time_slot_id = t.timeSlotId;
    dto.distributor_id = t.distributorId;
    dto.name = t.name;
    dto.startTime = t.startTime;
    dto.endTime = t.endTime;
    dto.capacity = t.capacity;
    dto.isActive = t.isActive;
    dto.createdAt = t.createdAt;
    dto.updatedAt = t.updatedAt;
    return dto;
  }
}
