import { GasCylinder } from './entities/gascylinder.entity';
import { GasCylinderResponseDto } from './dto/gascylinder-response.dto';

export class GasCylinderMapper {
  static toDto(g: GasCylinder): GasCylinderResponseDto {
    const dto = new GasCylinderResponseDto();
    dto.gas_cylinder_id = g.gas_cylinder_id;
    dto.distributor_id = g.distributor_id;
    dto.type = g.type;
    dto.weight = g.weight;
    dto.price = g.price;
    dto.stock = g.stock;
    dto.description = g.description;
    dto.isActive = g.isActive;
    // Sin promociones sale null, como cuando eran una columna JSON.
    dto.promotions = g.promotions?.length
      ? [...g.promotions]
          .sort((a, b) => a.quantity - b.quantity)
          .map((p) => ({
            quantity: p.quantity,
            discountPercentage: p.discountPercentage,
          }))
      : null;
    dto.createdAt = g.createdAt;
    dto.updatedAt = g.updatedAt;
    return dto;
  }
}
