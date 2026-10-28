import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { AttachmentResponseDto } from '../attachment/dto/attachment-response.dto';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { MAX_ATTACHMENT_SIZE_BYTES } from '../common/utils/attachment-rules';
import { BankDetailsResponseDto } from '../distributor/dto/bank-details.dto';
import { ArchivoIdempotente } from '../s3/upload-limits';
import { OrderTransferReceiptService } from './application/order-transfer-receipt.service';
import { OrderReceiptFileDto } from './dto/transfer-receipt.dto';

/** Comprobante de transferencia y datos bancarios del pedido (API v2). */
@ApiTags('Orders')
@Controller({ path: 'orders', version: '2' })
export class OrderTransferReceiptController {
  constructor(private readonly receipts: OrderTransferReceiptService) {}

  @Post(':id/transfer-receipt')
  @Auth(RoleType.CUSTOMER)
  @ApiOperation({
    summary: 'El cliente sube el comprobante de su transferencia',
    description:
      'Multipart con el campo `file` (imagen JPG, PNG, WEBP o PDF, hasta 10 MB). Sólo en un pedido propio que se paga por transferencia, no cancelado y con el pago `pending` o `failed` (marcado como no recibido: el comprobante sirve para corregirlo). Deja una nota en el historial del pedido y avisa al panel por socket (`order:transfer-receipt-uploaded` con `{ orderId, distributorId, customerId, attachmentId, uploadedAt }`). Hasta 5 comprobantes por pedido. Idempotente vía `Idempotency-Key`.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiCreatedResponse({ type: AttachmentResponseDto })
  @ApiBadRequestResponse({
    description: 'Falta el archivo o el pedido no se paga por transferencia',
  })
  @ApiNotFoundResponse({
    description: 'El pedido no existe o no es del cliente',
  })
  @ApiConflictResponse({
    description:
      'El pedido está cancelado, el pago ya se resolvió (`paid`, `unpaid`, `written_off`) o ya tiene 5 comprobantes',
  })
  @ApiUnsupportedMediaTypeResponse({
    description:
      'No es una imagen (JPG, PNG, WEBP) ni un PDF, o el contenido no coincide con el tipo declarado',
  })
  @ApiPayloadTooLargeResponse({
    description: 'El archivo supera el máximo permitido (10 MB)',
  })
  @ArchivoIdempotente(MAX_ATTACHMENT_SIZE_BYTES, 'archivo')
  subir(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AttachmentResponseDto> {
    return this.receipts.subir(id, user.user_id, file);
  }

  @Get(':id/transfer-receipt')
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Los comprobantes del pedido con su URL firmada',
    description:
      'Del más nuevo al más viejo. Admin y super admin (con `X-Distributor`) ven todos los adjuntos del pedido de su distribuidora, con `uploadedByUserId`. El cliente ve sólo los comprobantes de transferencia de sus pedidos (los que subió él o los que el admin adjuntó con `label` "Comprobante de transferencia" por `POST /attachments/order/:id`), sin `uploadedByUserId`. Cada `url` vence en `expiresAt`.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: OrderReceiptFileDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'El super admin no mandó `X-Distributor`',
  })
  @ApiNotFoundResponse({ description: 'Pedido no encontrado' })
  listar(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ): Promise<OrderReceiptFileDto[]> {
    return this.receipts.listar(
      id,
      { userId: user.user_id, role: user.role },
      distributorId,
    );
  }

  @Get(':id/bank-details')
  @Auth(RoleType.CUSTOMER)
  @ApiOperation({
    summary: 'Datos bancarios para pagar el pedido por transferencia',
    description:
      'CBU, alias y titular de la distribuidora de ese pedido (nunca los de otra). Cada dato es `null` si la distribuidora no lo cargó.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: BankDetailsResponseDto })
  @ApiBadRequestResponse({
    description: 'El pedido no se paga por transferencia',
  })
  @ApiNotFoundResponse({
    description: 'El pedido no existe o no es del cliente',
  })
  datosBancarios(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BankDetailsResponseDto> {
    return this.receipts.datosBancarios(id, user.user_id);
  }
}
