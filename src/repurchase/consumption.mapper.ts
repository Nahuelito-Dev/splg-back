import { Customer } from '../customer/entities/customer.entity';
import { ConsumptionResponseDto } from './dto/consumption-response.dto';

export class ConsumptionMapper {
  static toDto(customer: Customer): ConsumptionResponseDto {
    const dto = new ConsumptionResponseDto();
    dto.cylinderTypeId = customer.declaredCylinderTypeId;
    dto.cylinderType = customer.declaredCylinderType?.type ?? null;
    dto.avgMonthlyConsumptionKg = customer.avgMonthlyConsumptionKg;
    dto.nextRepurchaseEstimateAt = customer.nextRepurchaseEstimateAt;
    return dto;
  }
}
