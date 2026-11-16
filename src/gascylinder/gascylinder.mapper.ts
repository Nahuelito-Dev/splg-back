import { GasCylinder } from './entities/gascylinder.entity';
import { GasCylinderResponseDto } from './dto/gascylinder-response.dto';
import { ProductoPublicoDto } from './dto/catalogo-publico.dto';
import { PromocionConPrecioDto } from './dto/create-gascylinder.dto';
import { OrderPricingService } from '../order/domain/order-pricing.service';

const precios = new OrderPricingService();

/** Las promociones del producto, de menor a mayor cantidad, cada una con el precio unitario que cobra el pedido. */
function promocionesConPrecio(g: GasCylinder): PromocionConPrecioDto[] {
  const promos = [...(g.promotions ?? [])].sort(
    (a, b) => a.quantity - b.quantity,
  );
  return promos.map((p) => ({
    quantity: p.quantity,
    discountPercentage: p.discountPercentage,
    unitPrice: precios
      .priceItem(g.price, promos, p.quantity)
      .unitPrice.toNumber(),
  }));
}

export class GasCylinderMapper {
  static toDto(g: GasCylinder): GasCylinderResponseDto {
    const dto = new GasCylinderResponseDto();
    dto.gas_cylinder_id = g.gasCylinderId;
    dto.distributor_id = g.distributorId;
    dto.type = g.type;
    dto.weight = g.weight;
    dto.price = g.price;
    dto.container_price = g.containerPrice;
    dto.stock = g.stock;
    dto.description = g.description;
    dto.isActive = g.isActive;
    dto.photoUrl = g.photoSignedUrl ?? null;
    // Sin promociones sale null, como cuando eran una columna JSON.
    dto.promotions = g.promotions?.length ? promocionesConPrecio(g) : null;
    dto.createdAt = g.createdAt;
    dto.updatedAt = g.updatedAt;
    return dto;
  }

  /** Lo que ve un visitante: sin costos, sin la cantidad de stock ni datos internos. */
  static toPublicDto(g: GasCylinder): ProductoPublicoDto {
    const dto = new ProductoPublicoDto();
    dto.id = g.gasCylinderId;
    dto.type = g.type;
    dto.weight = g.weight;
    dto.price = g.price;
    dto.description = g.description;
    dto.photoUrl = g.photoSignedUrl ?? null;
    dto.promotions = promocionesConPrecio(g);
    dto.inStock = g.stock > 0;
    return dto;
  }
}
