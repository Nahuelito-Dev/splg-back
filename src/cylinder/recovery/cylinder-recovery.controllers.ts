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
  ApiForbiddenResponse,
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
import { ProcessConfigResponseDto } from '../../distributor/dto/process-config.dto';
import { CylinderRecoveryCasesService } from './cylinder-recovery-cases.service';
import { CylinderRecoveryService } from './cylinder-recovery.service';
import {
  PatchRecoverySettingsDto,
  PickupNotCollectedDto,
  QueryRecoveryCasesDto,
  ResolveRecoveryCaseDto,
} from './dto/recovery-request.dto';
import {
  DriverPickupDto,
  RecoveryCaseDetailDto,
  RecoveryCaseDto,
  RecoveryCasePageDto,
  RecoveryReportDto,
  RecoveryRunResponseDto,
} from './dto/recovery-response.dto';
import { RequiereModulo } from '../../platform/access/requiere-modulo.decorator';

const FALTA_DISTRIBUIDORA =
  'Super admin sin X-Distributor ("Falta la distribuidora: enviá el header X-Distributor (slug o id)")';

/**
 * Recuperación de envases no devueltos (CU-108, módulo inteligente M5), lado
 * del administrador: los casos con su escalón, el legajo, la decisión que sólo
 * el administrador toma, el reporte de envases perdidos y los parámetros.
 */
@RequiereModulo('cylinder_recovery')
@ApiTags('Cylinders · Recovery (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'cylinder-recovery', version: '2' })
export class CylinderRecoveryAdminController {
  constructor(
    private readonly cases: CylinderRecoveryCasesService,
    private readonly engine: CylinderRecoveryService,
  ) {}

  @Get('cases')
  @ApiOperation({
    summary: 'Casos de recupero de envases',
    description:
      'Los casos con su estado y escalón (1 recordatorio, 2 aviso del depósito, 3 agotado), el cliente, el envase, el último aviso y la oferta de retiro vigente; más los totales por estado. `pending=true` deja los que esperan la decisión del administrador (escalados y perdidos).',
  })
  @ApiOkResponse({ type: RecoveryCasePageDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  casos(
    @Query() query: QueryRecoveryCasesDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RecoveryCasePageDto> {
    return this.cases.listar(distributorId, query);
  }

  @Get('cases/:id')
  @ApiOperation({
    summary: 'Legajo de un caso de recupero',
    description:
      'El caso con el cliente, los avisos enviados, las ofertas de retiro, el historial completo de movimientos del envase, el importe en juego y la resolución si ya se decidió.',
  })
  @ApiParam({ name: 'id', description: 'Case UUID' })
  @ApiOkResponse({ type: RecoveryCaseDetailDto })
  @ApiNotFoundResponse({ description: 'Caso no encontrado' })
  @ApiBadRequestResponse({
    description: `El identificador no es válido o ${FALTA_DISTRIBUIDORA.toLowerCase()}`,
  })
  detalle(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RecoveryCaseDetailDto> {
    return this.cases.detalle(id, distributorId);
  }

  @Post('cases/:id/resolve')
  @Idempotent()
  @ApiOperation({
    summary: 'Decidir un caso escalado o perdido',
    description:
      'Paso 11 del CU-108. `charge_deposit` registra el depósito a cobrar (el sistema no cobra: se cobra aparte, en el próximo pedido o en efectivo); `write_off` da el envase por perdido y lo saca del inventario (queda en su historial); `close_no_charge` cierra sin cargo. La nota es obligatoria y queda con quién decidió.',
  })
  @ApiParam({ name: 'id', description: 'Case UUID' })
  @ApiOkResponse({ type: RecoveryCaseDetailDto })
  @ApiBadRequestResponse({
    description:
      'Falta la nota, la decisión o el identificador es inválido; también falta la distribuidora',
  })
  @ApiNotFoundResponse({ description: 'Caso no encontrado' })
  @ApiConflictResponse({
    description: 'El caso sigue en su secuencia de avisos o ya está cerrado',
  })
  resolver(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveRecoveryCaseDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<RecoveryCaseDetailDto> {
    return this.cases.resolver(id, distributorId, dto, userId);
  }

  @Get('report')
  @ApiOperation({
    summary: 'Reporte de envases perdidos y casos sin resolver',
    description:
      'Los envases perdidos (importe bajo el umbral: sólo se informan), los escalados que el administrador todavía no resolvió y los envases en poder de un cliente cuyo titular o entrega no se puede determinar (revisión manual), con los totales.',
  })
  @ApiOkResponse({ type: RecoveryReportDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  reporte(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RecoveryReportDto> {
    return this.cases.reporte(distributorId);
  }

  @Get('settings')
  @ApiOperation({
    summary: 'Parámetros de la recuperación de envases',
    description:
      'Los valores vigentes con el rango y el valor por omisión de cada uno. Los mismos de `GET /module-config/cylinder_recovery`.',
  })
  @ApiOkResponse({ type: ProcessConfigResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  settings(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ProcessConfigResponseDto> {
    return this.cases.parametrosVigentes(distributorId);
  }

  @Patch('settings')
  @ApiOperation({
    summary: 'Cambiar parámetros de la recuperación de envases',
    description:
      'Cambia sólo los que vienen; el resto conserva su valor. Rige desde la próxima corrida.',
  })
  @ApiOkResponse({ type: ProcessConfigResponseDto })
  @ApiBadRequestResponse({
    description: `Valor fuera de rango o ${FALTA_DISTRIBUIDORA.toLowerCase()}`,
  })
  settingsPatch(
    @Body() dto: PatchRecoverySettingsDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<ProcessConfigResponseDto> {
    return this.cases.cambiarParametros(distributorId, { ...dto }, userId);
  }

  @Post('run')
  @Idempotent()
  @ApiOperation({
    summary: 'Correr la recuperación ahora',
    description:
      'Hace lo mismo que la corrida diaria, para esta distribuidora y sin esperar la hora, y sólo con el recupero encendido (`enabled` = 1). Un cliente recibe a lo sumo un push por corrida. Es idempotente: un envase con caso vivo no abre otro y un escalón no repite su aviso.',
  })
  @ApiOkResponse({ type: RecoveryRunResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  @ApiConflictResponse({
    description:
      'El recupero está apagado para la distribuidora (parámetro `enabled` en 0, el valor por omisión): no se abre ningún caso ni se manda ningún aviso',
  })
  async correr(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RecoveryRunResponseDto> {
    const r = await this.engine.ejecutar(distributorId);
    return {
      opened: r.abiertos,
      notices: r.avisos,
      offers: r.ofertas,
      escalated: r.escalados,
      lost: r.perdidos,
      closedByReturn: r.cerradosPorDevolucion,
      closedCoveredByOwned: r.cerradosPorCuenta,
      manualReview: r.revisionManual,
    };
  }
}

/**
 * Lado del cliente: sus envases pendientes de devolver y la oferta de
 * devolverlos en su próxima entrega ya programada (la usa la app del cliente).
 */
@ApiTags('Cylinders · Recovery (v2)')
@Auth(RoleType.CUSTOMER)
@Controller({ path: 'cylinder-recovery/mine', version: '2' })
export class CylinderRecoveryCustomerController {
  constructor(private readonly cases: CylinderRecoveryCasesService) {}

  @Get()
  @ApiOperation({
    summary: 'Mis envases pendientes de devolver',
    description:
      'Los casos abiertos o escalados del cliente, con el depósito comprometido, el vencimiento del escalón y la oferta de retiro vigente (`pickup`: pendiente de respuesta o aceptada).',
  })
  @ApiOkResponse({ type: [RecoveryCaseDto] })
  mios(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<RecoveryCaseDto[]> {
    return this.cases.delCliente(userId, distributorId);
  }

  @Post(':id/pickup/accept')
  @Idempotent()
  @ApiOperation({
    summary: 'Aceptar devolver el envase en mi próxima entrega',
    description:
      'El retiro queda asociado al pedido de la oferta: el chofer lo ve en su recorrido y el caso espera la confirmación del retorno.',
  })
  @ApiParam({ name: 'id', description: 'Case UUID' })
  @ApiOkResponse({ type: RecoveryCaseDto })
  @ApiNotFoundResponse({ description: 'Caso no encontrado o de otro cliente' })
  @ApiConflictResponse({
    description:
      'Sin oferta vigente, la oferta venció o el pedido ya no admite el retiro',
  })
  aceptar(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<RecoveryCaseDto> {
    return this.cases.aceptarRetiro(id, userId, distributorId);
  }

  @Post(':id/pickup/decline')
  @Idempotent()
  @ApiOperation({
    summary: 'Rechazar la oferta de devolver en mi próxima entrega',
    description: 'La oferta se descarta y el caso sigue en su escalón.',
  })
  @ApiParam({ name: 'id', description: 'Case UUID' })
  @ApiOkResponse({ type: RecoveryCaseDto })
  @ApiNotFoundResponse({ description: 'Caso no encontrado o de otro cliente' })
  @ApiConflictResponse({ description: 'Sin oferta vigente o la oferta venció' })
  rechazar(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<RecoveryCaseDto> {
    return this.cases.rechazarRetiro(id, userId, distributorId);
  }
}

/** Lado del chofer: los retiros acordados en sus pedidos (los usa la app del chofer). */
@ApiTags('Cylinders · Recovery (v2)')
@Auth(RoleType.DELIVERY)
@Controller({ path: 'cylinder-recovery/driver/pickups', version: '2' })
export class CylinderRecoveryDriverController {
  constructor(private readonly cases: CylinderRecoveryCasesService) {}

  @Get()
  @ApiOperation({
    summary: 'Envases a retirar en mis pedidos',
    description:
      'Los retiros que el cliente aceptó, en pedidos que tiene asignados el chofer: aceptados, en camino o entregados hace menos de 24 horas.',
  })
  @ApiOkResponse({ type: [DriverPickupDto] })
  mios(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<DriverPickupDto[]> {
    return this.cases.retirosDelChofer(userId, distributorId);
  }

  @Post(':noticeId/confirm')
  @Idempotent()
  @ApiOperation({
    summary: 'Confirmar que retiré el envase',
    description:
      'Registra el retorno del envase (`with_customer` → `empty_returned`, en su historial) y cierra el caso: el depósito queda liberado. Se puede confirmar con el pedido aceptado, en camino o ya entregado hasta 24 horas después de la entrega; pasado ese plazo (o con el pedido cancelado) el retiro se da por fallido y el caso sigue su escalón.',
  })
  @ApiParam({
    name: 'noticeId',
    description: 'Notice UUID (`noticeId` del retiro)',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        caseId: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'returned' },
      },
    },
  })
  @ApiForbiddenResponse({
    description:
      'El pedido del retiro no está aceptado, en camino ni entregado hace menos de 24 horas',
  })
  @ApiNotFoundResponse({
    description: 'Retiro inexistente o de un pedido ajeno',
  })
  @ApiConflictResponse({
    description: 'El cliente no aceptó el retiro o el caso ya cerró',
  })
  confirmar(
    @Param('noticeId', ParseUUIDPipe) noticeId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ) {
    return this.cases.confirmarRetiro(noticeId, userId, distributorId);
  }

  @Post(':noticeId/not-collected')
  @Idempotent()
  @ApiOperation({
    summary: 'No pude retirar el envase',
    description:
      'El retiro se descarta con el motivo y el caso vuelve a su escalón.',
  })
  @ApiParam({
    name: 'noticeId',
    description: 'Notice UUID (`noticeId` del retiro)',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        caseId: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'open' },
      },
    },
  })
  @ApiForbiddenResponse({
    description:
      'El pedido del retiro no está aceptado, en camino ni entregado hace menos de 24 horas',
  })
  @ApiNotFoundResponse({
    description: 'Retiro inexistente o de un pedido ajeno',
  })
  @ApiConflictResponse({
    description: 'El cliente no aceptó el retiro o el caso ya cerró',
  })
  noRetirado(
    @Param('noticeId', ParseUUIDPipe) noticeId: string,
    @Body() dto: PickupNotCollectedDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ) {
    return this.cases.retiroNoRealizado(
      noticeId,
      userId,
      distributorId,
      dto.reason,
    );
  }
}
