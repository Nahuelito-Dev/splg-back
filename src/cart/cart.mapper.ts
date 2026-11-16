import { Cart } from './entities/cart.entity';
import { VistaDelCarrito } from './domain/cart-view';
import { CartResponseDto } from './dto/cart-response.dto';

export class CartMapper {
  static toDto(
    cart: Cart | null,
    distributorId: string,
    vista: VistaDelCarrito,
  ): CartResponseDto {
    const dto = new CartResponseDto();
    dto.cartId = cart?.cartId ?? null;
    dto.distributorId = distributorId;
    dto.items = vista.items;
    dto.totalUnits = vista.totalUnits;
    dto.total = vista.total;
    dto.hasPriceChanges = vista.hasPriceChanges;
    dto.hasUnavailableItems = vista.hasUnavailableItems;
    dto.updatedAt = cart?.updatedAt ?? null;
    return dto;
  }
}
