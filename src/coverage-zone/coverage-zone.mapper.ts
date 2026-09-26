import { CoverageZone } from './entities/coverage-zone.entity';
import { CoverageZoneResponseDto } from './dto/coverage-zone-response.dto';

export class CoverageZoneMapper {
  static toDto(z: CoverageZone): CoverageZoneResponseDto {
    const dto = new CoverageZoneResponseDto();
    dto.coverage_zone_id = z.coverageZoneId;
    dto.distributor_id = z.distributorId;
    dto.name = z.name;
    dto.area = z.area;
    dto.surchargeType = z.surchargeType;
    dto.surchargeValue = z.surchargeValue;
    dto.label = z.label;
    dto.color = z.color;
    dto.priority = z.priority;
    dto.validFrom = z.validFrom;
    dto.validUntil = z.validUntil;
    dto.isActive = z.isActive;
    dto.createdAt = z.createdAt;
    dto.updatedAt = z.updatedAt;
    return dto;
  }
}
