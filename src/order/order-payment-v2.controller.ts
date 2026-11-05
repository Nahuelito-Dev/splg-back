import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { PaymentsService } from '../payments/application/payments.service';
import { OrderPaymentStateDto } from './dto/order-payment-state.dto';
import { OrderService } from './order.service';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { OrderFraudHoldService } from './application/order-fraud-hold.service';
import { ReleaseFraudHoldDto } from './dto/release-fraud-hold.dto';
import { ApiConflictResponse } from '@nestjs/swagger';

/** Máximo de pedidos por consulta en lote (la lista del panel). */
const MAXIMO_EN_LOTE = 50;

/** Estado del pago de los pedidos de Mercado Pago (API v2). */
@ApiTags('Pedidos · Estado del pago (v2)')
@Controller({ path: 'orders', version: '2' })
export class OrderPaymentV2Controller {
  constructor(
    private readonly orders: OrderService,
    private readonly payments: PaymentsService,
    private readonly fraudHold: OrderFraudHoldService,
  ) {}

  @Get('payments')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Estado del pago de varios pedidos (la lista del panel)',
    description: `Como \`GET /v2/orders/:id/payment\`, para hasta ${MAXIMO_EN_LOTE} pedidos de la distribuidora, sin historial. Un pedido que no existe o es de otra distribuidora no aparece en la respuesta (no es un error). El super admin tiene que mandar \`X-Distributor\`.`,
  })
  @ApiQuery({
    name: 'ids',
    description: `UUID de pedidos separados por coma (hasta ${MAXIMO_EN_LOTE})`,
    example:
      '3f2c0f9e-6a43-4a0f-9f43-6d1c8bf2a111,7d9b6f3e-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
  })
  @ApiOkResponse({ type: OrderPaymentStateDto, isArray: true })
  @ApiBadRequestResponse({
    description:
      'Falta `ids`, hay uno que no es un UUID, son más de 50, o el super admin no mandó `X-Distributor`',
  })
  async deVarios(
    @Query('ids') ids: string | undefined,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ): Promise<OrderPaymentStateDto[]> {
    const lista = (ids ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (lista.length === 0 || lista.length > MAXIMO_EN_LOTE) {
      throw new BadRequestException(
        `Mandá entre 1 y ${MAXIMO_EN_LOTE} ids de pedido en \`ids\``,
      );
    }
    const legibles: string[] = [];
    for (const id of new Set(lista)) {
      if (!UUID.test(id)) {
        throw new BadRequestException(`«${id}» no es un UUID de pedido`);
      }
      try {
        await this.orders.assertLegible(id, distributorId);
        legibles.push(id);
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
      }
    }
    return this.payments.estadosDelPagoDePedidos(legibles);
  }

  @Patch(':id/payment/fraud-hold/release')
  @Idempotent()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Liberar la retención de un pedido por alerta de fraude',
    description:
      'Mercado Pago avisó una alerta de fraude sobre el pago y el pedido (o la reserva con seña paga) quedó retenido: no se ofrece, no se asigna ni se acepta y la reserva no se activa. El administrador lo libera con un motivo obligatorio (10 a 500 caracteres); queda guardado quién, cuándo y por qué, y el cambio lo asienta la auditoría. 409 si el pedido no está retenido; 404 si no es de la distribuidora. La alternativa a liberar es cancelar el pedido, que devuelve el pago.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ description: 'Retención liberada' })
  @ApiBadRequestResponse({
    description:
      'El id no es un UUID, el motivo falta o no tiene de 10 a 500 caracteres, o el super admin no mandó `X-Distributor`',
  })
  @ApiConflictResponse({ description: 'El pedido no está retenido' })
  @ApiNotFoundResponse({ description: 'Pedido no encontrado' })
  async liberarRetencion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReleaseFraudHoldDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    return this.fraudHold.liberar(id, distributorId, user.user_id, dto.reason);
  }

  @Get(':id/payment')
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Estado del pago de un pedido',
    description:
      'Uno de los nueve estados de pago de Mercado Pago (`paymentStatus`), su motivo (`paymentStatusDetail`), el texto en castellano armado por el back (`paymentStatusLabel`), si se puede reintentar el pago (`canRetry`) y el enlace para hacerlo (`paymentUrl`). El cliente sólo lee sus pedidos; admin y super admin los de su distribuidora (el super admin manda `X-Distributor`) y además reciben el `history` de cambios. Lo ajeno responde 404.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: OrderPaymentStateDto })
  @ApiNotFoundResponse({ description: 'Pedido no encontrado' })
  @ApiBadRequestResponse({
    description: 'El super admin no mandó `X-Distributor`',
  })
  async deUno(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ): Promise<OrderPaymentStateDto> {
    const esCliente = user.role === RoleType.CUSTOMER;
    await this.orders.assertLegible(
      id,
      distributorId,
      esCliente ? user.user_id : undefined,
    );
    return this.payments.estadoDelPagoDelPedido(id, !esCliente);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
