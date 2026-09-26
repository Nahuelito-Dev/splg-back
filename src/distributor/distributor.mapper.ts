import { Distributor } from './entities/distributor.entity';
import { DistributorResponseDto } from './dto/distributor-response.dto';

export class DistributorMapper {
  static toDto(d: Distributor): DistributorResponseDto {
    const dto = new DistributorResponseDto();
    dto.distributor_id = d.distributor_id;
    dto.name = d.name;
    dto.slug = d.slug;
    dto.legal_name = d.legal_name;
    dto.tax_id = d.tax_id;
    dto.email = d.email;
    dto.phone = d.phone;
    dto.logo_url = d.logo_url;
    dto.status = d.status;
    dto.plan = d.plan;
    dto.createdAt = d.createdAt;
    dto.updatedAt = d.updatedAt;
    dto.deletedAt = d.deletedAt;
    return dto;
  }
}
