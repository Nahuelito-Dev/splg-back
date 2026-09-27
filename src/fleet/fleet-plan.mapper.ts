import { MaintenancePlan } from './entities/maintenance-plan.entity';
import { FleetPlanResponseDto } from './dto/plan-response.dto';

export class FleetPlanMapper {
  static toDto(p: MaintenancePlan): FleetPlanResponseDto {
    const dto = new FleetPlanResponseDto();
    dto.planId = p.planId;
    dto.distributorId = p.distributorId;
    dto.name = p.name;
    dto.subject = p.subject;
    dto.trigger = p.trigger;
    dto.intervalKm = p.intervalKm;
    dto.intervalMonths = p.intervalMonths;
    dto.leadTimeDays = p.leadTimeDays;
    dto.criticality = p.criticality;
    dto.carType = p.carType;
    dto.isActive = p.isActive;
    return dto;
  }
}
