import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
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
import { PayFromCashBoxDto } from '../../cash/dto/pay-expense.dto';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { exigirIdempotencyKey } from '../../stock/presentation/exigir-idempotency-key';
import { IdempotencyKeyObligatoria } from '../../stock/presentation/idempotency-key-obligatoria.decorator';
import { PurchaseQueryService } from '../application/purchase-query.service';
import { PurchaseReceiptService } from '../application/purchase-receipt.service';
import {
  PurchaseReceiptResponseDto,
  PurchaseReceiptV2PageDto,
  PurchaseReceiptV2ResponseDto,
  PurchaseReceiptV2SummaryDto,
  QueryPurchaseReceiptDto,
} from '../dto/purchase-receipt.dto';
import { PaymentStatus } from '../domain/purchase.enums';
import { Permiso } from '../../common/decorators/permiso.decorator';

const NO_ENCONTRADA = 'No existe o es de otra distribuidora';

/**
 * Recepciones de compra con su estado de pago y el pago desde cualquier caja
 * (API v2). Registrar, anular y marcar impaga siguen en `/purchase-receipts` (v1).
 */
@ApiTags('Compras · Recepciones (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'purchase-receipts', version: '2' })
export class PurchaseReceiptV2Controller {
  constructor(
    private readonly receipts: PurchaseReceiptService,
    private readonly queries: PurchaseQueryService,
  ) {}

  @Permiso('stock.ver')
  @Get()
  @ApiOperation({
    summary: 'Listar las recepciones, con su estado de pago',
  })
  @ApiOkResponse({ type: PurchaseReceiptV2PageDto })
  async recepciones(
    @Query() query: QueryPurchaseReceiptDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PurchaseReceiptV2PageDto> {
    const pagina = await this.queries.recepciones(distributorId, query);
    const pagos = await this.queries.pagosDeRecepciones(
      pagina.data.map((r) => r.receiptId),
      distributorId,
    );
    return {
      total: pagina.total,
      data: pagina.data.map((r) =>
        Object.assign(new PurchaseReceiptV2SummaryDto(), r, {
          isPaid: r.paymentStatus === PaymentStatus.PAID,
          cashMovementId: pagos.get(r.receiptId)?.cashMovementId ?? null,
          paidAt: pagos.get(r.receiptId)?.paidAt ?? null,
        }),
      ),
    };
  }

  @Permiso('stock.ver')
  @Get(':id')
  @ApiOperation({ summary: 'Ver una recepción, con su estado de pago' })
  @ApiParam({ name: 'id', description: 'Recepción UUID' })
  @ApiOkResponse({ type: PurchaseReceiptV2ResponseDto })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  recepcion(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PurchaseReceiptV2ResponseDto> {
    return this.conPago(id, distributorId);
  }

  @Permiso('compras.gestionar')
  @Post(':id/pay')
  @IdempotencyKeyObligatoria()
  @ApiOperation({
    summary: 'Pagar una recepción desde una caja',
    description:
      'Egreso del total de la recepción de la caja elegida (efectivo, banco o billetera), categoría «Compra de mercadería», en la misma transacción. Sólo una recepción impaga: para corregir un pago se la marca impaga (`PATCH /purchase-receipts/:id/payment-status`), que asienta el contraasiento. **Exige** `Idempotency-Key`.',
  })
  @ApiParam({ name: 'id', description: 'Recepción UUID' })
  @ApiCreatedResponse({ type: PurchaseReceiptV2ResponseDto })
  @ApiBadRequestResponse({
    description:
      'Sin `Idempotency-Key`, recepción anulada, `paidAt` futuro o caja que no admite el pago',
  })
  @ApiNotFoundResponse({ description: `${NO_ENCONTRADA} (también la caja)` })
  @ApiConflictResponse({
    description:
      'Ya está pagada, o la caja no tiene una sesión abierta o no alcanza el saldo',
  })
  async pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayFromCashBoxDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<PurchaseReceiptV2ResponseDto> {
    exigirIdempotencyKey(idempotencyKey, 'El pago de una recepción');
    await this.receipts.pagar(id, dto, distributorId, actorUserId);
    return this.conPago(id, distributorId);
  }

  private async conPago(
    id: string,
    distributorId: string,
  ): Promise<PurchaseReceiptV2ResponseDto> {
    const recepcion: PurchaseReceiptResponseDto = await this.queries.recepcion(
      id,
      distributorId,
    );
    const pagos = await this.queries.pagosDeRecepciones([id], distributorId);
    return Object.assign(new PurchaseReceiptV2ResponseDto(), recepcion, {
      isPaid: recepcion.paymentStatus === PaymentStatus.PAID,
      paidAt: pagos.get(id)?.paidAt ?? null,
    });
  }
}
