import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Cart } from './entities/cart.entity';
import { CartItem } from './entities/cart-item.entity';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { OrderPricingService } from '../order/domain/order-pricing.service';
import { GasCylinderModule } from '../gascylinder/gascylinder.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Cart, CartItem]),
    GasCylinderModule, // catálogo: el tipo existe, está activo y es de la distribuidora
  ],
  controllers: [CartController],
  providers: [CartService, OrderPricingService],
  exports: [CartService],
})
export class CartModule {}
