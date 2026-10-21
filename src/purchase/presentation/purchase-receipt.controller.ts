import {
  Body,
  Controller,
  Get,
  Headers,
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
import { exigirIdempotencyKey } from '../../stock/presentation/exigir-idempotency-key';
import { IdempotencyKeyObligatoria } from '../../stock/presentation/idempotency-key-obligatoria.decorator';
import { PurchaseQueryService } from '../application/purchase-query.service';
import { PurchaseReceiptService } from '../application/purchase-receipt.service';
import { ReceivePurchaseUseCase } from '../application/receive-purchase.use-case';
import { VoidPurchaseReceiptUseCase } from '../application/void-purchase-receipt.use-case';
import {
  AverageCostDto,
  CreatePurchaseReceiptDto,
  PurchaseReceiptPageDto,
  PurchaseReceiptResponseDto,
  QueryPurchaseReceiptDto,
  UpdatePaymentStatusDto,
  VoidPurchaseReceiptDto,
} from '../dto/purchase-receipt.dto';

const NO_ENCONTRADA = 'No existe o es de otra distribuidora';

/** Recepciones de compra: el remito de ingreso de garrafas (CU-217). */
@ApiTags('Compras · Recepciones')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('purchase-receipts')
export class PurchaseReceiptController {
  constructor(
    private readonly receive: ReceivePurchaseUseCase,
    private readonly voidReceipt: VoidPurchaseReceiptUseCase,
    private readonly receipts: PurchaseReceiptService,
    private readonly queries: PurchaseQueryService,
  ) {}

  @Post()
  @IdempotencyKeyObligatoria()
  @ApiOperation({
    summary: 'Registrar la recepción de una compra (con o sin orden)',
    description:
      'En una transacción: suma las llenas al depósito (sube el vendible), descuenta las vacías que se llevó la planta ' +
      '(sin dejar el depósito en negativo), actualiza lo recibido y el estado de la orden y recalcula el costo promedio ' +
      'ponderado. El número del documento del proveedor es único por proveedor. **Exige** `Idempotency-Key` (400 sin ella). Un `receivedAt` ' +
      'anterior al conteo inicial del depósito responde 400.',
  })
  @ApiCreatedResponse({ type: PurchaseReceiptResponseDto })
  @ApiBadRequestResponse({
    description:
      'Sin `Idempotency-Key`, orden no recibible, `warehouseId` distinto al depósito de la orden, la recepción se pasa de lo pendiente, fecha anterior al conteo inicial del depósito, no alcanzan las vacías o faltan datos',
  })
  @ApiNotFoundResponse({
    description: 'Orden, proveedor, depósito o garrafa inexistente',
  })
  @ApiConflictResponse({
    description: 'Ya hay una recepción de ese proveedor con ese documento',
  })
  async create(
    @Body() dto: CreatePurchaseReceiptDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<PurchaseReceiptResponseDto> {
    exigirIdempotencyKey(idempotencyKey, 'La recepción de una compra');
    const id = await this.receive.execute(dto, distributorId, actorUserId);
    return this.queries.recepcion(id, distributorId);
  }

  @Get()
  @ApiOperation({
    summary:
      'Listar las recepciones por proveedor, orden, fecha y estado de pago',
  })
  @ApiOkResponse({ type: PurchaseReceiptPageDto })
  recepciones(
    @Query() query: QueryPurchaseReceiptDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PurchaseReceiptPageDto> {
    return this.queries.recepciones(distributorId, query);
  }

  @Get('average-costs')
  @ApiOperation({
    summary: 'Costo promedio ponderado por garrafa',
    description:
      'Con el último costo comprado y las llenas que hay hoy. `null` si nunca se compró.',
  })
  @ApiOkResponse({ type: AverageCostDto, isArray: true })
  costos(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<AverageCostDto[]> {
    return this.queries.costosPromedio(distributorId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ver una recepción con sus renglones' })
  @ApiParam({ name: 'id', description: 'Recepción UUID' })
  @ApiOkResponse({ type: PurchaseReceiptResponseDto })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  recepcion(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PurchaseReceiptResponseDto> {
    return this.queries.recepcion(id, distributorId);
  }

  @Patch(':id/void')
  @IdempotencyKeyObligatoria()
  @ApiOperation({
    summary: 'Anular una recepción (contraasiento del libro, con motivo)',
    description:
      'Saca las llenas que entraron y devuelve las vacías que se llevó la planta; recalcula lo recibido de la orden y el ' +
      'costo promedio (recalculado de las recepciones que siguen confirmadas). **Exige** `Idempotency-Key`. Si las llenas ya no están en el depósito responde 409 diciendo dónde están; si el depósito fue dado de baja, 409. No se anula una recepción pagada.',
  })
  @ApiParam({ name: 'id', description: 'Recepción UUID' })
  @ApiOkResponse({ type: PurchaseReceiptResponseDto })
  @ApiBadRequestResponse({
    description:
      'Sin motivo, sin `Idempotency-Key` o la recepción figura como pagada',
  })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  @ApiConflictResponse({
    description:
      'Ya está anulada, las llenas ya no están en el depósito donde entraron, o ese depósito fue dado de baja',
  })
  async void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidPurchaseReceiptDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<PurchaseReceiptResponseDto> {
    exigirIdempotencyKey(idempotencyKey, 'La anulación de una recepción');
    await this.voidReceipt.execute(id, dto, distributorId, actorUserId);
    return this.queries.recepcion(id, distributorId);
  }

  @Patch(':id/payment-status')
  @ApiOperation({
    summary: 'Marcar la recepción como pagada o impaga',
    description:
      'Marca el pago. Con `paid` + `paidInCash` el total sale de la caja de efectivo `cashBoxId` en la misma transacción ' +
      '(`cashMovementId` guarda la salida; con cajas de efectivo activas `cashBoxId` es obligatorio). Marcarla `unpaid` ' +
      'asienta el contraasiento. Repetir el estado actual no asienta otra vez.',
  })
  @ApiParam({ name: 'id', description: 'Recepción UUID' })
  @ApiOkResponse({ type: PurchaseReceiptResponseDto })
  @ApiBadRequestResponse({
    description:
      'La recepción está anulada, falta la caja de efectivo o la caja no es de efectivo',
  })
  @ApiNotFoundResponse({
    description: `${NO_ENCONTRADA} (también la caja)`,
  })
  @ApiConflictResponse({
    description: 'La caja no tiene una sesión abierta o no alcanza el saldo',
  })
  async paymentStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentStatusDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<PurchaseReceiptResponseDto> {
    await this.receipts.cambiarEstadoDePago(
      id,
      {
        paymentStatus: dto.paymentStatus,
        paidInCash: dto.paidInCash,
        cashBoxId: dto.cashBoxId,
      },
      distributorId,
      actorUserId,
    );
    return this.queries.recepcion(id, distributorId);
  }
}
