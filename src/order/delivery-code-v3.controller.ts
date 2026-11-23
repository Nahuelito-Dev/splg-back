import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
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
import { Permiso } from '../common/decorators/permiso.decorator';
import { ConfirmDeliveryV3UseCase } from './application/confirm-delivery-v3.use-case';
import { ConfirmDeliveryV3Dto } from './dto/confirm-delivery-v3.dto';
import { CodigoDeEntregaResponseDto } from './dto/order-listados-response.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { OrderMapper } from './order.mapper';
import { OrderService } from './order.service';

/**
 * Código de entrega «al revés» (API v3): el cliente ve el código en su app y se
 * lo dice al chofer; el chofer lo escribe con su ubicación. El chofer nunca lo ve.
 */
@ApiTags('Pedidos · Código de entrega (v3)')
@Controller({ path: 'orders', version: '3' })
export class DeliveryCodeV3Controller {
  constructor(
    private readonly orderService: OrderService,
    private readonly confirmDelivery: ConfirmDeliveryV3UseCase,
  ) {}

  @Get(':id/delivery-code')
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Permiso('pedidos.ver')
  @ApiOperation({
    summary: 'Ver el código de entrega (el que el cliente le dice al chofer)',
    description:
      'Lo ve el cliente dueño del pedido y el admin, con el pedido aceptado o en camino. El chofer no tiene acceso (403): es el que lo escribe. Trae `attempts` (códigos incorrectos del chofer) y `blocked` (agotó los 5 intentos: hay que generar un código nuevo). Al cliente le llegan por socket `order:delivery-code-failed` (`{orderId, attempts, remaining}`) en cada error del chofer y `order:delivery-code-blocked` (`{orderId}`) al bloquearse.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: CodigoDeEntregaResponseDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiForbiddenResponse({ description: 'El chofer no puede ver el código' })
  @ApiNotFoundResponse({
    description: 'Pedido inexistente, de otro cliente o de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'El pedido no está aceptado ni en camino (`code: ORDER_WITHOUT_DELIVERY_CODE`): todavía no lo aceptó un chofer, ya se entregó o se canceló',
  })
  async getDeliveryCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CodigoDeEntregaResponseDto> {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    return this.orderService.getDeliveryCodeParaElCliente(
      id,
      user.user_id,
      user.role,
    );
  }

  @Post(':id/delivery-code/regenerate')
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Permiso('despacho.gestionar')
  @Idempotent({ sinCuerpo: true })
  @ApiOperation({
    summary: 'Generar un código de entrega nuevo',
    description:
      'El cliente dueño del pedido (o un admin con permiso de despacho) reemplaza el código del pedido en camino por uno de 6 dígitos; los intentos del chofer vuelven a 0 y el código viejo deja de valer. Sirve cuando se bloqueó (`DELIVERY_CODE_BLOQUEADO`) o se filtró. Queda en la auditoría de datos. Un super admin tiene que mandar `X-Distributor`.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiCreatedResponse({ type: CodigoDeEntregaResponseDto })
  @ApiForbiddenResponse({ description: 'El chofer no puede generar el código' })
  @ApiNotFoundResponse({
    description: 'Pedido inexistente, de otro cliente o de otra distribuidora',
  })
  @ApiBadRequestResponse({
    description:
      'Super admin sin `X-Distributor` (`code: MISSING_DISTRIBUTOR`) o el id no es un UUID',
  })
  @ApiConflictResponse({
    description:
      'El pedido no está en camino (`code: ORDER_NOT_ON_THE_WAY`): todavía no salió, ya se entregó o se canceló',
  })
  async regenerate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ): Promise<CodigoDeEntregaResponseDto> {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    return this.orderService.regenerateDeliveryCodeParaElCliente(
      id,
      user.user_id,
      user.role,
    );
  }

  @Post(':id/confirm-delivery')
  @HttpCode(200)
  @Auth(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Permiso('pedidos.gestionar')
  @Idempotent()
  @ApiOperation({
    summary: 'Confirmar la entrega con el código del cliente y la ubicación',
    description:
      'El chofer asignado escribe el código de 6 dígitos que le dice el cliente y manda su ubicación (`latitude`, `longitude`, `accuracyMeters` opcional). Con el pedido en camino y el código correcto pasa a entregado y queda asentado dónde estaba (punto, precisión, distancia al domicilio), quién confirmó y la hora de la base. Si está más lejos del domicilio que el radio de llegada de la distribuidora no se rechaza: `deliveryConfirmation.outOfRange` queda en `true` y se audita. 5 códigos incorrectos bloquean el código (el cliente genera otro) y a cada error se le avisa al cliente por socket. Un admin entrega mandando SIEMPRE `reason` (10 a 500 caracteres), sin ubicación; el `code` que mande es informativo (no se compara). Pedido ya entregado: responde 200 con el pedido, sin volver a pedir el código ni pisar la confirmación. Idempotente vía header `Idempotency-Key`: el reintento con la misma clave de un código incorrecto responde el mismo error sin sumar otro intento ni volver a avisar al cliente. `deliveryConfirmation.confirmedByUserId` sólo viene para el admin.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({
    type: OrderResponseDto,
    description: 'Entrega confirmada (o ya estaba entregada)',
  })
  @ApiBadRequestResponse({
    description:
      'Código sin 6 dígitos (`code: DELIVERY_CODE_FORMATO`, no cuenta como intento); faltan o son `null` el código o la ubicación del chofer, o la ubicación está fuera de rango (`code: VALIDATION`); falta el motivo del admin o es corto; código incorrecto (`code: DELIVERY_CODE_INCORRECTO`, con `attempts` y `remaining` en el cuerpo)',
  })
  @ApiForbiddenResponse({
    description:
      'El pedido no está asignado a este chofer, o la cuenta no tiene permiso para confirmar entregas (un cliente no puede confirmar)',
  })
  @ApiNotFoundResponse({
    description: 'Pedido inexistente o de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'El pedido no está en camino (`code: ORDER_NOT_ON_THE_WAY`) o el código quedó bloqueado por 5 intentos (`code: DELIVERY_CODE_BLOQUEADO`)',
  })
  async confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ConfirmDeliveryV3Dto,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OrderResponseDto> {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    const order = await this.confirmDelivery.execute({
      orderId: id,
      userId: user.user_id,
      role: user.role,
      code: body.code,
      latitude: body.latitude,
      longitude: body.longitude,
      accuracyMeters: body.accuracyMeters,
      reason: body.reason,
      idempotencyKey: idempotencyKey ?? null,
    });
    return OrderMapper.toDto(order, {
      paraElPersonal:
        user.role === RoleType.ADMIN || user.role === RoleType.SUPER_ADMIN,
    });
  }
}
