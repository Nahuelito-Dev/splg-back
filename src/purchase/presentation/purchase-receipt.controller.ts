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
  @Idempotent()
  @ApiOperation({
    summary: 'Registrar la recepción de una compra (con o sin orden)',
    description:
      'En una transacción: suma las llenas al depósito (sube el vendible), descuenta las vacías que se llevó la planta ' +
      '(sin dejar el depósito en negativo), actualiza lo recibido y el estado de la orden y recalcula el costo promedio ' +
      'ponderado. El número del documento del proveedor es único por proveedor. Acepta `Idempotency-Key`.',
  })
  @ApiCreatedResponse({ type: PurchaseReceiptResponseDto })
  @ApiBadRequestResponse({
    description:
      'La orden no es recibible, la recepción se pasa de lo pendiente, no alcanzan las vacías o faltan datos',
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
  ): Promise<PurchaseReceiptResponseDto> {
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
  @Idempotent()
  @ApiOperation({
    summary: 'Anular una recepción (contraasiento del libro, con motivo)',
    description:
      'Saca las llenas que entraron y devuelve las vacías que se llevó la planta; recalcula lo recibido de la orden y el ' +
      'costo promedio. Si las llenas ya no están en el depósito responde 409 diciendo dónde están. No se anula una recepción pagada.',
  })
  @ApiParam({ name: 'id', description: 'Recepción UUID' })
  @ApiOkResponse({ type: PurchaseReceiptResponseDto })
  @ApiBadRequestResponse({
    description: 'Sin motivo, o la recepción figura como pagada',
  })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  @ApiConflictResponse({
    description:
      'Ya está anulada, o las llenas ya no están en el depósito donde entraron',
  })
  async void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidPurchaseReceiptDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<PurchaseReceiptResponseDto> {
    await this.voidReceipt.execute(id, dto, distributorId, actorUserId);
    return this.queries.recepcion(id, distributorId);
  }

  @Patch(':id/payment-status')
  @ApiOperation({
    summary: 'Marcar la recepción como pagada o impaga',
    description:
      'Sólo la marca: el movimiento de caja (`cashMovementId`) lo completará el módulo de caja.',
  })
  @ApiParam({ name: 'id', description: 'Recepción UUID' })
  @ApiOkResponse({ type: PurchaseReceiptResponseDto })
  @ApiBadRequestResponse({ description: 'La recepción está anulada' })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  async paymentStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentStatusDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PurchaseReceiptResponseDto> {
    await this.receipts.cambiarEstadoDePago(
      id,
      dto.paymentStatus,
      distributorId,
    );
    return this.queries.recepcion(id, distributorId);
  }
}
