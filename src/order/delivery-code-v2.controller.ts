import { Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { CodigoDeEntregaResponseDto } from './dto/order-listados-response.dto';
import { OrderService } from './order.service';

/** Código de entrega del pedido en camino (API v2). */
@ApiTags('Pedidos · Código de entrega (v2)')
@Auth(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'orders', version: '2' })
export class DeliveryCodeV2Controller {
  constructor(private readonly orderService: OrderService) {}

  @Post(':id/delivery-code/regenerate')
  @Idempotent()
  @ApiOperation({
    summary: 'Generar un código de entrega nuevo',
    description:
      'El chofer asignado (o un admin) reemplaza el código del pedido en camino por uno de 6 dígitos y los intentos fallidos del cliente vuelven a 0. Sirve cuando el cliente agotó los intentos (`DELIVERY_CODE_BLOQUEADO`). Queda en la auditoría de datos. El código viejo deja de valer.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiCreatedResponse({ type: CodigoDeEntregaResponseDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiForbiddenResponse({
    description: 'El pedido no está asignado a este chofer',
  })
  @ApiNotFoundResponse({ description: 'Pedido no encontrado' })
  @ApiConflictResponse({ description: 'El pedido no está en camino' })
  async regenerate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CodigoDeEntregaResponseDto> {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    return this.orderService.regenerateDeliveryCode(
      id,
      user.user_id,
      user.role,
    );
  }
}
