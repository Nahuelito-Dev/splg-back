import { SupplierResponseDto } from '../dto/supplier.dto';
import { Supplier } from '../entities/supplier.entity';

export class SupplierMapper {
  static toDto(s: Supplier): SupplierResponseDto {
    const dto = new SupplierResponseDto();
    dto.supplierId = s.supplierId;
    dto.businessName = s.businessName;
    dto.cuit = s.cuit;
    dto.kind = s.kind;
    dto.contactName = s.contactName;
    dto.phone = s.phone;
    dto.email = s.email;
    dto.address = s.address;
    dto.paymentTermsDays = s.paymentTermsDays;
    dto.isActive = s.isActive;
    dto.createdAt = s.createdAt;
    dto.updatedAt = s.updatedAt;
    return dto;
  }
}
