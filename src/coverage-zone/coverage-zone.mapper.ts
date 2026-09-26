import { CoverageZone } from './entities/coverage-zone.entity';
import { CoverageZoneResponseDto } from './dto/coverage-zone-response.dto';

export class CoverageZoneMapper {
  static toDto(z: CoverageZone): CoverageZoneResponseDto {
    const dto = new CoverageZoneResponseDto();
    dto.coverage_zone_id = z.coverage_zone_id;
    dto.distributor_id = z.distributor_id;
    dto.name = z.name;
    dto.area = z.area;
    dto.surcharge = z.surcharge;
    dto.isActive = z.isActive;
    dto.createdAt = z.createdAt;
    dto.updatedAt = z.updatedAt;
    return dto;
  }
}
