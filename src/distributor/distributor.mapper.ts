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
    // `logo_url` es sólo el texto guardado (el que acepta el alta/edición);
    // el logo de S3 sale aparte, firmado, en `photoUrl`.
    dto.logo_url = d.logoUrl;
    dto.photoUrl = d.photoSignedUrl ?? null;
    dto.status = d.status;
    dto.plan = d.plan;
    dto.createdAt = d.createdAt;
    dto.updatedAt = d.updatedAt;
    dto.deletedAt = d.deletedAt;
    return dto;
  }
}
