import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { withTransactionRetry } from '../common/utils/with-transaction-retry';
import { DeliveryOptionsUseCase } from './application/delivery-options.use-case';
import { ExpressPurchaseUseCase } from './application/express-purchase.use-case';
import {
  DeliveryOptionsQueryDto,
  DeliveryOptionsResponseDto,
  ExpressPreviewResponseDto,
  ExpressPurchaseDto,
} from './dto/express.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { OrderMapper } from './order.mapper';
import { Permiso } from '../common/decorators/permiso.decorator';
import { RequiereModulo } from '../platform/access/requiere-modulo.decorator';

const EXPRESS_NO_DISPONIBLE =
  'La modalidad express dejó de estar disponible (`code: EXPRESS_NOT_AVAILABLE`, con `reason`: disabled, no_location, out_of_coverage, out_of_hours o no_motorcycle_driver): la app ofrece el flujo con franja horaria';

/**
 * Modalidad de entrega y compra express (CU-148, CU-147). Se registra antes que
 * `OrderController` para que `GET /orders/delivery-options` no caiga en
 * `GET /orders/:id`.
 */
@ApiTags('Orders · Express')
@ApiBearerAuth()
@UseInterceptors(ClassSerializerInterceptor)
@Controller('orders')
export class ExpressOrderController {
  constructor(
    private readonly deliveryOptions: DeliveryOptionsUseCase,
    private readonly expressPurchase: ExpressPurchaseUseCase,
  ) {}

  @Get('delivery-options')
  @Permiso('pedidos.ver')
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Modalidades de entrega disponibles para una dirección (CU-148)',
    description:
      'La programada (`standard`) siempre figura; la `express` sólo está disponible con la dirección dentro de la cobertura, en horario de servicio y con un chofer en moto habilitado dentro del radio express. Cada una trae su recargo y su tiempo estimado. No escribe nada: `POST /orders` con `deliveryMode` vuelve a evaluar. Cliente sin `X-Distributor`: distribuidora por defecto; el admin manda `customerId`.',
  })
  @ApiOkResponse({ type: DeliveryOptionsResponseDto })
  @ApiNotFoundResponse({
    description: 'La dirección no existe o no es del cliente',
  })
  @ApiForbiddenResponse({ description: 'Un cliente consultando por otro' })
  @ApiBadRequestResponse({ description: 'Admin sin `customerId`' })
  options(
    @Query() query: DeliveryOptionsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ): Promise<DeliveryOptionsResponseDto> {
    return this.deliveryOptions.execute(query, distributorId, {
      userId: user.user_id,
      role: user.role,
    });
  }

  @RequiereModulo('express')
  @Post('express/quote')
  @HttpCode(200)
  @Auth(RoleType.CUSTOMER)
  @ApiOperation({
    summary: 'Vista previa de la compra express (CU-147)',
    description:
      'Con la dirección predeterminada del cliente y su garrafa habitual (la de su última compra en la distribuidora, o `gasCylinderId`), evalúa la modalidad y devuelve el precio final con el recargo express. Si no hay cobertura, horario o moto, responde 200 con `available: false`, el motivo y `fallback: "scheduled"` (el flujo con franja horaria). No escribe nada.',
  })
  @ApiOkResponse({ type: ExpressPreviewResponseDto })
  @ApiNotFoundResponse({
    description: 'El cliente no tiene una dirección predeterminada',
  })
  @ApiBadRequestResponse({
    description:
      'Sin compras previas y sin `gasCylinderId`, o garrafa de otra distribuidora',
  })
  preview(
    @Body() dto: ExpressPurchaseDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<ExpressPreviewResponseDto> {
    return this.expressPurchase.preview(dto, user.user_id, distributorId);
  }

  @RequiereModulo('express')
  @Post('express')
  @Auth(RoleType.CUSTOMER)
  @Idempotent()
  @ApiOperation({
    summary: 'Realizar una compra express (CU-147)',
    description:
      'Crea el pedido en modalidad express (sin franja, a la dirección predeterminada) y lo despacha al chofer en moto más cercano. El cliente confirma con este llamado; si entre la vista previa y la confirmación el último chofer se ocupó, 409. Si después ninguna moto acepta, el pedido pasa al reparto común sin el recargo (CU-149) y se avisa al cliente por `order:express-degraded`. Idempotente vía `Idempotency-Key`. Con `mercadopago` devuelve `payment_url` y no se despacha hasta que el pago se apruebe.',
  })
  @ApiCreatedResponse({ type: OrderResponseDto })
  @ApiConflictResponse({ description: EXPRESS_NO_DISPONIBLE })
  @ApiNotFoundResponse({
    description: 'El cliente no tiene una dirección predeterminada',
  })
  @ApiBadRequestResponse({
    description: 'Sin garrafa habitual ni `gasCylinderId`, o sin stock',
  })
  async buy(
    @Body() dto: ExpressPurchaseDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<OrderResponseDto> {
    const { order, paymentUrl } = await withTransactionRetry(
      () => this.expressPurchase.buy(dto, user.user_id, distributorId),
      { context: 'ExpressPurchase.buy' },
    );
    const respuesta = OrderMapper.toDto(order);
    respuesta.paymentUrl = paymentUrl;
    return respuesta;
  }
}
