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
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { MAX_ATTACHMENT_SIZE_BYTES } from '../common/utils/attachment-rules';
import { UploadedReceiptDto } from '../insurance/dto/insurance-installment.dto';
import { ArchivoIdempotente } from '../s3/upload-limits';
import { QueryTrafficFineDto } from './dto/traffic-fine.dto';
import {
  CreateTrafficFineV2Dto,
  PayTrafficFineV2Dto,
  TrafficFineV2PageDto,
  TrafficFineV2ResponseDto,
  UpdateTrafficFineV2Dto,
} from './dto/traffic-fine-v2.dto';
import { FleetExpenseMapper } from './fleet-expense.mapper';
import { TrafficFinePaymentService } from './traffic-fine-payment.service';
import { TrafficFineService } from './traffic-fine.service';
import { Permiso } from '../common/decorators/permiso.decorator';

/**
 * Multas de tránsito con enlace de pago, comprobante escaneado y egreso de caja
 * (API v2). Anular e imputar al chofer siguen en `/fleet/fines` (v1).
 */
@ApiTags('Fleet · Multas (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'traffic-fines', version: '2' })
export class TrafficFineV2Controller {
  constructor(
    private readonly fines: TrafficFineService,
    private readonly pagos: TrafficFinePaymentService,
  ) {}

  @Permiso('flota.gestionar')
  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Registrar una multa de tránsito',
    description:
      'Nace pendiente. Acepta el enlace (`paymentUrl`, https) y el código (`paymentCode`) de pago. Si no se indica el responsable, se deduce del chofer que tenía el vehículo en uso en el instante de la infracción.',
  })
  @ApiCreatedResponse({ type: TrafficFineV2ResponseDto })
  @ApiBadRequestResponse({
    description:
      'Dato inválido, infracción futura, vencimiento anterior a la infracción, pago voluntario mayor al importe o enlace que no es https',
  })
  @ApiNotFoundResponse({ description: 'Vehículo o empleado no encontrado' })
  @ApiConflictResponse({
    description: 'La multa ya está registrada (misma jurisdicción y acta)',
  })
  async create(
    @Body() dto: CreateTrafficFineV2Dto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TrafficFineV2ResponseDto> {
    return FleetExpenseMapper.trafficFineV2(
      await this.fines.registrar(dto, distributorId),
    );
  }

  @Permiso('flota.ver')
  @Get()
  @ApiOperation({ summary: 'Consultar las multas de tránsito' })
  @ApiOkResponse({ type: TrafficFineV2PageDto })
  @ApiBadRequestResponse({ description: 'Filtro inválido' })
  async findAll(
    @Query() query: QueryTrafficFineDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TrafficFineV2PageDto> {
    const { data, total } = await this.fines.findAll(distributorId, query);
    return {
      data: data.map((m) => FleetExpenseMapper.trafficFineV2(m)),
      total,
    };
  }

  @Permiso('flota.ver')
  @Get(':id')
  @ApiOperation({ summary: 'Ver una multa' })
  @ApiParam({ name: 'id', description: 'Multa UUID' })
  @ApiOkResponse({ type: TrafficFineV2ResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TrafficFineV2ResponseDto> {
    return FleetExpenseMapper.trafficFineV2(
      await this.fines.findOne(id, distributorId),
    );
  }

  @Permiso('flota.gestionar')
  @Patch(':id')
  @ApiOperation({
    summary: 'Modificar una multa o pasarla a apelada',
    description:
      'Además de los datos de la multa, `paymentUrl` y `paymentCode` (con `null` se borran). Con `appeal: true` pasa de pendiente a apelada. Una multa pagada o anulada no se modifica.',
  })
  @ApiParam({ name: 'id', description: 'Multa UUID' })
  @ApiOkResponse({ type: TrafficFineV2ResponseDto })
  @ApiBadRequestResponse({
    description:
      'Dato inválido, infracción futura, vencimiento anterior a la infracción o enlace que no es https',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description:
      'Pagada, anulada, ya apelada, o el acta pertenece a otra multa',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTrafficFineV2Dto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TrafficFineV2ResponseDto> {
    return FleetExpenseMapper.trafficFineV2(
      await this.fines.modificar(id, dto, distributorId),
    );
  }

  @Permiso('flota.gestionar')
  @Post(':id/receipt')
  @ApiOperation({
    summary: 'Subir el comprobante de pago de la multa (se escanea solo)',
    description:
      'Multipart con el campo `file` (PDF, JPG, PNG o WEBP, hasta 10 MB). Guarda el comprobante como adjunto de la multa y, en el mismo pedido, lo lee con el lector de comprobantes (pistas: el importe voluntario si todavía vale, si no el de la multa, y la jurisdicción). `scan.available` es `false` si no hay lector configurado, y `scan.data` es `null` si no hay lector o la lectura falló: en ambos casos la subida vale y los datos se cargan a mano. Lo leído sólo precarga el formulario: nada se guarda hasta `POST /traffic-fines/:id/pay`. Idempotente vía `Idempotency-Key`.',
  })
  @ApiParam({ name: 'id', description: 'Multa UUID' })
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
  @ApiConflictResponse({ description: 'La multa ya está paga o anulada' })
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
    return this.pagos.subirComprobante(id, file, distributorId, {
      userId: user.user_id,
      role: user.role,
    });
  }

  @Permiso('flota.gestionar')
  @Post(':id/pay')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({
    summary: 'Pagar la multa',
    description:
      'En una transacción con la multa bloqueada: valida que esté pendiente o apelada y que el comprobante sea de ella, saca el egreso de la caja elegida (efectivo, banco o billetera; categoría «Multas», referencia `traffic_fine`) y deja la multa paga con el comprobante y el movimiento asociados. La descripción del egreso lleva acta, jurisdicción y patente: «Multa A-0012345 — Municipalidad de Posadas (AB123CD)». Idempotente vía `Idempotency-Key`.',
  })
  @ApiParam({ name: 'id', description: 'Multa UUID' })
  @ApiOkResponse({ type: TrafficFineV2ResponseDto })
  @ApiBadRequestResponse({
    description:
      'Fecha futura o anterior a la infracción, importe inválido o mayor al de la multa, el comprobante no es de la multa o la caja no admite el pago',
  })
  @ApiNotFoundResponse({
    description: 'La multa o la caja no existen o son de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'La multa ya está paga o anulada, la caja está desactivada, exige sesión abierta o no tiene saldo',
  })
  async pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayTrafficFineV2Dto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TrafficFineV2ResponseDto> {
    await this.pagos.pagar(id, dto, distributorId, user.user_id);
    return FleetExpenseMapper.trafficFineV2(
      await this.fines.findOne(id, distributorId),
    );
  }
}
