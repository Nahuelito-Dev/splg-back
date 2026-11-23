import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { MAX_ATTACHMENT_SIZE_BYTES } from '../../common/utils/attachment-rules';
import { ArchivoIdempotente } from '../../s3/upload-limits';
import { InsuranceInstallmentService } from '../application/insurance-installment.service';
import { InsuranceQueryService } from '../application/insurance-query.service';
import {
  PayInsuranceInstallmentDto,
  QueryInsuranceInstallmentDto,
  UpdateInsuranceInstallmentDto,
  UploadedReceiptDto,
} from '../dto/insurance-installment.dto';
import {
  InsuranceInstallmentDetailDto,
  InsuranceInstallmentPageDto,
} from '../dto/insurance-policy.dto';
import { InsuranceMapper } from './insurance.mapper';
import { Permiso } from '../../common/decorators/permiso.decorator';

/** Cuotas del seguro: listado, corrección, comprobante con escaneo y pago (API v2). */
@ApiTags('Seguros · Cuotas')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'insurance-installments', version: '2' })
export class InsuranceInstallmentController {
  constructor(
    private readonly cuotas: InsuranceInstallmentService,
    private readonly consultas: InsuranceQueryService,
  ) {}

  @Permiso('flota.ver')
  @Get()
  @ApiOperation({
    summary: 'Listar las cuotas de seguro',
    description:
      'Con la póliza, la aseguradora (y su enlace de pago) y el vehículo. Filtra por `status`, vencimiento (`dueFrom`/`dueTo`) y `carId`. Orden por vencimiento.',
  })
  @ApiOkResponse({ type: InsuranceInstallmentPageDto })
  @ApiBadRequestResponse({ description: 'Filtro inválido' })
  async findAll(
    @Query() query: QueryInsuranceInstallmentDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<InsuranceInstallmentPageDto> {
    const { data, total } = await this.consultas.findInstallments(
      distributorId,
      query,
    );
    return {
      data: data.map((c) => InsuranceMapper.installmentDetail(c)),
      total,
    };
  }

  @Permiso('flota.ver')
  @Get(':id')
  @ApiOperation({ summary: 'Ver una cuota' })
  @ApiParam({ name: 'id', description: 'Cuota UUID' })
  @ApiOkResponse({ type: InsuranceInstallmentDetailDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<InsuranceInstallmentDetailDto> {
    return InsuranceMapper.installmentDetail(
      await this.cuotas.findOne(id, distributorId),
    );
  }

  @Permiso('flota.gestionar')
  @Patch(':id')
  @ApiOperation({
    summary: 'Corregir el vencimiento, la gracia o el importe de una cuota',
    description: 'Sólo mientras la cuota está pendiente.',
  })
  @ApiParam({ name: 'id', description: 'Cuota UUID' })
  @ApiOkResponse({ type: InsuranceInstallmentDetailDto })
  @ApiBadRequestResponse({
    description: 'Dato inválido o gracia anterior al vencimiento',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'La cuota ya está paga o cancelada' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInsuranceInstallmentDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<InsuranceInstallmentDetailDto> {
    await this.cuotas.modificar(id, dto, distributorId);
    return InsuranceMapper.installmentDetail(
      await this.cuotas.findOne(id, distributorId),
    );
  }

  @Permiso('flota.gestionar')
  @Post(':id/receipt')
  @ApiOperation({
    summary: 'Subir el comprobante de pago de la cuota (se escanea solo)',
    description:
      'Multipart con el campo `file` (PDF, JPG, PNG o WEBP, hasta 10 MB). Guarda el comprobante como adjunto de la cuota y, en el mismo pedido, lo lee con el lector de comprobantes (pistas: el importe de la cuota y el nombre de la aseguradora). `scan.available` es `false` si no hay lector configurado, y `scan.data` es `null` si no hay lector o la lectura falló: en ambos casos la subida vale y los datos se cargan a mano. Lo leído sólo precarga el formulario: nada se guarda hasta `POST /insurance-installments/:id/pay`. Idempotente vía `Idempotency-Key`.',
  })
  @ApiParam({ name: 'id', description: 'Cuota UUID' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiCreatedResponse({ type: UploadedReceiptDto })
  @ApiBadRequestResponse({ description: 'Falta el archivo o está vacío' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'La cuota ya está paga o cancelada' })
  @ApiUnsupportedMediaTypeResponse({
    description:
      'No es un PDF ni una imagen (JPG, PNG, WEBP), o el contenido no coincide con el tipo declarado',
  })
  @ApiPayloadTooLargeResponse({
    description: 'El archivo supera el máximo permitido (10 MB)',
  })
  @ArchivoIdempotente(MAX_ATTACHMENT_SIZE_BYTES, 'archivo')
  uploadReceipt(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<UploadedReceiptDto> {
    return this.cuotas.subirComprobante(id, file, distributorId, {
      userId: user.user_id,
      role: user.role,
    });
  }

  @Permiso('flota.gestionar')
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Aprobar el pago de una cuota',
    description:
      'Todo pago de una cuota requiere la aprobación del admin. El aviso de la cuota a 5 días deja `approvalStatus: awaiting` («¿Aprobar pago?»), pero se aprueba cualquier cuota pendiente que no esté aprobada (`none` o `awaiting`). Queda quién (`approvedByUserId`) y cuándo (`approvedAt`), con la auditoría de datos. No mueve plata ni registra el pago: eso es `POST /insurance-installments/:id/pay`, que responde 409 `INSTALLMENT_APPROVAL_REQUIRED` mientras la cuota no esté aprobada. Corregir el importe o el vencimiento de una cuota aprobada la devuelve a `awaiting`.',
  })
  @ApiParam({ name: 'id', description: 'Cuota UUID' })
  @ApiOkResponse({ type: InsuranceInstallmentDetailDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description:
      'La cuota ya está aprobada, o está paga o cancelada: `INSTALLMENT_NOT_APPROVABLE`',
  })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<InsuranceInstallmentDetailDto> {
    await this.cuotas.aprobar(id, distributorId, user.user_id);
    return InsuranceMapper.installmentDetail(
      await this.cuotas.findOne(id, distributorId),
    );
  }

  @Permiso('flota.gestionar')
  @Post(':id/pay')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({
    summary: 'Pagar la cuota',
    description:
      'En una transacción con la cuota bloqueada: valida que esté pendiente y que el comprobante sea de ella, saca el egreso de la caja elegida (efectivo, banco o billetera; categoría «Seguros», referencia `insurance_installment`) y deja la cuota paga con el comprobante y el movimiento asociados. La descripción del egreso lleva vehículo, aseguradora y cuota: «Seguro OVQ621 — Seguros Rivadavia, cuota 5/6». Idempotente vía `Idempotency-Key`.',
  })
  @ApiParam({ name: 'id', description: 'Cuota UUID' })
  @ApiOkResponse({ type: InsuranceInstallmentDetailDto })
  @ApiBadRequestResponse({
    description:
      'Fecha futura, importe inválido, el comprobante no es de la cuota o la caja no admite el pago',
  })
  @ApiNotFoundResponse({
    description: 'La cuota o la caja no existen o son de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'La cuota ya está paga o cancelada, no está aprobada (`INSTALLMENT_APPROVAL_REQUIRED`), el importe supera el aprobado (`INSTALLMENT_AMOUNT_EXCEEDS_APPROVED`), la caja está desactivada, exige sesión abierta o no tiene saldo',
  })
  async pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayInsuranceInstallmentDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<InsuranceInstallmentDetailDto> {
    await this.cuotas.pagar(id, dto, distributorId, user.user_id);
    return InsuranceMapper.installmentDetail(
      await this.cuotas.findOne(id, distributorId),
    );
  }
}
