import { Distributor } from './entities/distributor.entity';
import { DistributorResponseDto } from './dto/distributor-response.dto';

export class DistributorMapper {
  static toDto(d: Distributor): DistributorResponseDto {
    const dto = new DistributorResponseDto();
    dto.distributor_id = d.distributorId;
    dto.name = d.name;
    dto.slug = d.slug;
    dto.legal_name = d.legalName;
    dto.tax_id = d.taxId;
    dto.email = d.email;
    dto.phone = d.phone;
    // `logo_url` es una columna legada: el logo sale sólo firmado, en `photoUrl`.
    dto.logo_url = null;
    dto.photoUrl = d.photoSignedUrl ?? null;
    dto.status = d.status;
    dto.plan = d.plan;
    dto.createdAt = d.createdAt;
    dto.updatedAt = d.updatedAt;
    dto.deletedAt = d.deletedAt;
    return dto;
  }
}
