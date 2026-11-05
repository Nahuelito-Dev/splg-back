import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CartService, CarritoConsultado } from './cart.service';
import { CartMapper } from './cart.mapper';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { CartResponseDto } from './dto/cart-response.dto';

/**
 * Carrito del cliente autenticado en la distribuidora de `X-Distributor`
 * (CU-122 a CU-126). El dueño es siempre el del token: no hay forma de
 * indicar el carrito de otro.
 */
@ApiTags('Cart')
@Auth(RoleType.CUSTOMER)
@ApiHeader({
  name: 'X-Distributor',
  required: true,
  description: 'Slug o id de la distribuidora del carrito',
})
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  private aDto(
    consultado: CarritoConsultado,
    distributorId: string,
  ): CartResponseDto {
    return CartMapper.toDto(consultado.cart, distributorId, consultado.vista);
  }

  @Get()
  @ApiOperation({
    summary: 'Consultar el carrito (CU-125)',
    description:
      'Total calculado sobre los precios vigentes del catálogo; cada ítem informa la diferencia con el precio guardado. Sin carrito, responde uno vacío. Un tipo dado de baja se marca `available: false` y no suma.',
  })
  @ApiOkResponse({ type: CartResponseDto })
  @ApiBadRequestResponse({
    description: 'Falta la distribuidora (`X-Distributor`)',
  })
  async consultar(
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CartResponseDto> {
    return this.aDto(
      await this.cart.consultar(userId, distributorId),
      distributorId,
    );
  }

  @Post('items')
  @ApiOperation({
    summary: 'Agregar un ítem al carrito (CU-122)',
    description:
      'Si el tipo de garrafa ya está en el carrito suma la cantidad. Guarda el precio vigente como referencia.',
  })
  @ApiCreatedResponse({ type: CartResponseDto })
  @ApiBadRequestResponse({
    description:
      'Cantidad inválida (no entera o no positiva) o que supera el máximo por ítem, o falta la distribuidora (`X-Distributor`)',
  })
  @ApiNotFoundResponse({
    description:
      'El tipo de garrafa no existe, está dado de baja o es de otra distribuidora',
  })
  async agregar(
    @Body() dto: AddCartItemDto,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CartResponseDto> {
    return this.aDto(
      await this.cart.agregarItem(
        userId,
        distributorId,
        dto.gasCylinderId,
        dto.quantity,
      ),
      distributorId,
    );
  }

  @Patch('items/:itemId')
  @ApiOperation({ summary: 'Modificar la cantidad de un ítem (CU-123)' })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiOkResponse({ type: CartResponseDto })
  @ApiBadRequestResponse({
    description:
      'Cantidad cero, negativa o no entera (para dejarlo en cero hay que quitar el ítem), el ítem no es un UUID, o falta la distribuidora (`X-Distributor`)',
  })
  @ApiNotFoundResponse({
    description: 'El ítem no está en el carrito del cliente',
  })
  async cambiarCantidad(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateCartItemDto,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CartResponseDto> {
    return this.aDto(
      await this.cart.cambiarCantidad(
        userId,
        distributorId,
        itemId,
        dto.quantity,
      ),
      distributorId,
    );
  }

  @Delete('items/:itemId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Quitar un ítem del carrito (CU-124)' })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiOkResponse({ type: CartResponseDto })
  @ApiBadRequestResponse({
    description:
      'El ítem no es un UUID, o falta la distribuidora (`X-Distributor`)',
  })
  @ApiNotFoundResponse({
    description: 'El ítem no está en el carrito del cliente',
  })
  async quitar(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CartResponseDto> {
    return this.aDto(
      await this.cart.quitarItem(userId, distributorId, itemId),
      distributorId,
    );
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Vaciar el carrito (CU-126)',
    description: 'Sin carrito no hace nada y responde uno vacío.',
  })
  @ApiOkResponse({ type: CartResponseDto })
  @ApiBadRequestResponse({
    description: 'Falta la distribuidora (`X-Distributor`)',
  })
  async vaciar(
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CartResponseDto> {
    return this.aDto(
      await this.cart.vaciar(userId, distributorId),
      distributorId,
    );
  }
}
