import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { CashCollectionSettingsService } from '../application/cash-collection-settings.service';
import {
  CashCollectionSettingsResponseDto,
  OrderCashSettlementResponseDto,
  PendingCollectionsQueryDto,
  PendingCollectionsResponseDto,
  SettlePendingDto,
  SettlePendingResponseDto,
  UpdateCashCollectionSettingsDto,
} from '../dto/cash-collection-settings.dto';
import { Permiso } from '../../common/decorators/permiso.decorator';

/**
 * A qué caja entra lo que se cobra por Mercado Pago y por transferencia, y los
 * cobros que todavía no entraron a ninguna (API v2).
 */
@ApiTags('Finanzas · Cajas de cobro (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ version: '2' })
export class CashCollectionSettingsController {
  constructor(private readonly configuracion: CashCollectionSettingsService) {}

  @Permiso('finanzas.ver')
  @Get('cash-settings')
  @ApiOperation({
    summary: 'Ver las cajas de cobro',
    description:
      'La caja (billetera) de Mercado Pago y la caja (banco) de las transferencias. Sin caja configurada el cobro se confirma igual y queda sin asentar.',
  })
  @ApiOkResponse({ type: CashCollectionSettingsResponseDto })
  async ver(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CashCollectionSettingsResponseDto> {
    return this.respuesta(distributorId);
  }

  @Permiso('finanzas.gestionar')
  @Patch('cash-settings')
  @Idempotent()
  @ApiOperation({
    summary: 'Elegir las cajas de cobro',
    description:
      '`mercadoPagoCashBoxId` tiene que ser una caja de clase billetera y `transferCashBoxId` una de clase banco, ambas de la distribuidora y activas. `null` quita la caja; omitir el campo lo deja como está. Elegir una caja NO asienta cobros anteriores: eso lo pide `POST /cash-settings/settle-pending`.',
  })
  @ApiOkResponse({ type: CashCollectionSettingsResponseDto })
  @ApiBadRequestResponse({
    description: 'La caja no es de la clase que corresponde o está desactivada',
  })
  @ApiNotFoundResponse({
    description: 'La caja no existe o es de otra distribuidora',
  })
  async actualizar(
    @Body() dto: UpdateCashCollectionSettingsDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<CashCollectionSettingsResponseDto> {
    await this.configuracion.actualizar(dto, distributorId, userId);
    return this.respuesta(distributorId);
  }

  @Permiso('finanzas.ver')
  @Get('cash-settings/pending')
  @ApiOperation({
    summary: 'Cobros de ventas sin asentar',
    description:
      'Pagos aprobados de Mercado Pago y transferencias confirmadas desde `from` (por omisión, los últimos 30 días) que no tienen movimiento de caja.',
  })
  @ApiOkResponse({ type: PendingCollectionsResponseDto })
  pendientes(
    @Query() query: PendingCollectionsQueryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PendingCollectionsResponseDto> {
    return this.configuracion.pendientes(distributorId, query.from);
  }

  @Permiso('finanzas.gestionar')
  @Post('cash-settings/settle-pending')
  @Idempotent()
  @ApiOperation({
    summary: 'Asentar los cobros pendientes',
    description:
      'Asienta en las cajas configuradas los cobros de Mercado Pago (con su comisión y devoluciones) y las transferencias confirmadas desde `from` que no tienen movimiento. Idempotente: lo que ya está asentado no se repite. Nada anterior a `from` se toca.',
  })
  @ApiOkResponse({ type: SettlePendingResponseDto })
  @ApiBadRequestResponse({ description: 'Fecha inválida' })
  asentarPendientes(
    @Body() dto: SettlePendingDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<SettlePendingResponseDto> {
    return this.configuracion.asentarPendientes(
      distributorId,
      dto.from,
      userId,
    );
  }

  @Permiso('finanzas.ver')
  @Get('orders/:orderId/cash-settlement')
  @ApiOperation({
    summary: 'A qué caja entró lo cobrado de un pedido',
    description:
      'Los cobros del pedido por Mercado Pago o transferencia, cada uno con su movimiento de caja o `settled: false` si quedó sin asentar.',
  })
  @ApiParam({ name: 'orderId', description: 'Pedido UUID' })
  @ApiOkResponse({ type: OrderCashSettlementResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  delPedido(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<OrderCashSettlementResponseDto> {
    return this.configuracion.delPedido(orderId, distributorId);
  }

  private async respuesta(
    distributorId: string,
  ): Promise<CashCollectionSettingsResponseDto> {
    const { config, nombres } = await this.configuracion.obtener(distributorId);
    const dto = new CashCollectionSettingsResponseDto();
    dto.mercadoPagoCashBoxId = config?.mercadoPagoCashBoxId ?? null;
    dto.mercadoPagoCashBoxName = dto.mercadoPagoCashBoxId
      ? (nombres.get(dto.mercadoPagoCashBoxId) ?? null)
      : null;
    dto.transferCashBoxId = config?.transferCashBoxId ?? null;
    dto.transferCashBoxName = dto.transferCashBoxId
      ? (nombres.get(dto.transferCashBoxId) ?? null)
      : null;
    dto.updatedAt = config?.updatedAt ?? null;
    return dto;
  }
}
