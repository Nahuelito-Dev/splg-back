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
  ApiConflictResponse,
  ApiCreatedResponse,
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
import { PurchaseOrderService } from '../application/purchase-order.service';
import { PurchaseQueryService } from '../application/purchase-query.service';
import {
  CancelPurchaseOrderDto,
  CloseShortPurchaseOrderDto,
  CreatePurchaseOrderDto,
  PurchaseOrderPageDto,
  PurchaseOrderPendingDto,
  PurchaseOrderResponseDto,
  QueryPurchaseOrderDto,
  UpdatePurchaseOrderDto,
} from '../dto/purchase-order.dto';

const NO_ENCONTRADA = 'No existe o es de otra distribuidora';

/** Órdenes de compra (CU-215 y CU-216). */
@ApiTags('Compras · Órdenes de compra')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('purchase-orders')
export class PurchaseOrderController {
  constructor(
    private readonly orders: PurchaseOrderService,
    private readonly queries: PurchaseQueryService,
  ) {}

  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Crear una orden de compra en borrador',
    description:
      'Número correlativo por distribuidora. Total = Σ cantidad × costo unitario. Sin depósito destino usa el predeterminado.',
  })
  @ApiCreatedResponse({ type: PurchaseOrderResponseDto })
  @ApiBadRequestResponse({
    description: 'Datos inválidos, proveedor inactivo o garrafa repetida',
  })
  @ApiNotFoundResponse({
    description: 'Proveedor, depósito o garrafa inexistente',
  })
  async create(
    @Body() dto: CreatePurchaseOrderDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<PurchaseOrderResponseDto> {
    const id = await this.orders.create(dto, distributorId, actorUserId);
    return this.queries.orden(id, distributorId);
  }

  @Get()
  @ApiOperation({
    summary: 'Listar las órdenes de compra por estado, proveedor y fecha',
  })
  @ApiOkResponse({ type: PurchaseOrderPageDto })
  ordenes(
    @Query() query: QueryPurchaseOrderDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PurchaseOrderPageDto> {
    return this.queries.ordenes(distributorId, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Ver una orden con sus renglones, lo pendiente y sus recepciones',
  })
  @ApiParam({ name: 'id', description: 'Orden de compra UUID' })
  @ApiOkResponse({ type: PurchaseOrderResponseDto })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  orden(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PurchaseOrderResponseDto> {
    return this.queries.orden(id, distributorId);
  }

  @Get(':id/pending')
  @ApiOperation({
    summary: 'Pendiente de recibir de una orden',
    description:
      'Por garrafa: pedido, recibido y lo que falta. Una orden cancelada no espera nada.',
  })
  @ApiParam({ name: 'id', description: 'Orden de compra UUID' })
  @ApiOkResponse({ type: PurchaseOrderPendingDto })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  pendiente(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PurchaseOrderPendingDto> {
    return this.queries.pendiente(id, distributorId);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Editar una orden (sólo en borrador)',
    description:
      'Si vienen `items`, reemplazan a todos los renglones anteriores.',
  })
  @ApiParam({ name: 'id', description: 'Orden de compra UUID' })
  @ApiOkResponse({ type: PurchaseOrderResponseDto })
  @ApiBadRequestResponse({
    description: 'La orden ya no está en borrador, o datos inválidos',
  })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurchaseOrderDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PurchaseOrderResponseDto> {
    await this.orders.update(id, dto, distributorId);
    return this.queries.orden(id, distributorId);
  }

  @Patch(':id/send')
  @ApiOperation({
    summary: 'Enviar la orden al proveedor (borrador a enviada)',
  })
  @ApiParam({ name: 'id', description: 'Orden de compra UUID' })
  @ApiOkResponse({ type: PurchaseOrderResponseDto })
  @ApiBadRequestResponse({ description: 'La orden no está en borrador' })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  async send(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PurchaseOrderResponseDto> {
    await this.orders.send(id, distributorId);
    return this.queries.orden(id, distributorId);
  }

  @Patch(':id/cancel')
  @ApiOperation({
    summary: 'Cancelar una orden (borrador o enviada) con motivo',
    description:
      'Una orden con recepciones confirmadas (incluso sólo de vacías) no se cancela: responde 409. Se anulan primero las recepciones, o se cierra la orden con faltante.',
  })
  @ApiParam({ name: 'id', description: 'Orden de compra UUID' })
  @ApiOkResponse({ type: PurchaseOrderResponseDto })
  @ApiBadRequestResponse({
    description: 'Sin motivo, o la orden ya está cerrada',
  })
  @ApiConflictResponse({
    description:
      'La orden tiene recepciones confirmadas (aunque sean sólo de vacías)',
  })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelPurchaseOrderDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PurchaseOrderResponseDto> {
    await this.orders.cancel(id, dto, distributorId);
    return this.queries.orden(id, distributorId);
  }

  @Patch(':id/close-short')
  @ApiOperation({
    summary: 'Cerrar con faltante una orden parcialmente recibida',
    description:
      'Lo que falta ya no llega: la orden queda `closed_short` con el motivo, deja de esperar mercadería y de bloquear la baja del proveedor. Sus recepciones se pueden seguir anulando.',
  })
  @ApiParam({ name: 'id', description: 'Orden de compra UUID' })
  @ApiOkResponse({ type: PurchaseOrderResponseDto })
  @ApiBadRequestResponse({
    description: 'Sin motivo, o la orden no está parcialmente recibida',
  })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  async closeShort(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseShortPurchaseOrderDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PurchaseOrderResponseDto> {
    await this.orders.closeShort(id, dto, distributorId);
    return this.queries.orden(id, distributorId);
  }
}
