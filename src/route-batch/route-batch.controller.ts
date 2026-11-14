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
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { ProcessConfigResponseDto } from '../distributor/dto/process-config.dto';
import {
  PatchRouteBatchSettingsDto,
  QueryRouteBatchesDto,
} from './dto/route-batch-request.dto';
import {
  RouteBatchPageDto,
  RouteBatchResponseDto,
  RouteBatchRunResponseDto,
} from './dto/route-batch-response.dto';
import { RouteBatchQueryService } from './route-batch-query.service';
import { RouteBatchService } from './route-batch.service';
import { Permiso } from '../common/decorators/permiso.decorator';
import { RequiereModulo } from '../platform/access/requiere-modulo.decorator';

const FALTA_DISTRIBUIDORA =
  'Super admin sin X-Distributor ("Falta la distribuidora: enviá el header X-Distributor (slug o id)")';

/**
 * Agrupación de pedidos por recorrido (CU-107, módulo inteligente M4), lado del
 * administrador: los lotes que el sistema armó, a quién se ofrecieron y en qué
 * quedaron, los parámetros del proceso y dos acciones: armar lotes ahora y
 * deshacer uno que todavía no tiene chofer.
 */
@RequiereModulo('route_batching')
@ApiTags('Route batches (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'route-batches', version: '2' })
export class RouteBatchController {
  constructor(
    private readonly service: RouteBatchService,
    private readonly query: RouteBatchQueryService,
  ) {}

  @Permiso('despacho.gestionar')
  @Get()
  @ApiOperation({
    summary: 'Lotes de recorrido',
    description:
      'Los lotes de la distribuidora, del más reciente al más viejo, con sus paradas en orden de entrega, la oferta vigente y todos los choferes contactados. `counts` trae el total por estado: `forming`, `offered` (esperando al chofer), `assigned` (aceptado), `dissolved` (deshecho; `closeReason` dice por qué) y `completed`.',
  })
  @ApiOkResponse({ type: RouteBatchPageDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  lotes(
    @Query() query: QueryRouteBatchesDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteBatchPageDto> {
    return this.query.listar(distributorId, {
      status: query.status,
      limit: query.limit ?? 10,
      offset: query.offset ?? 0,
    });
  }

  @Permiso('despacho.gestionar')
  @Get('settings')
  @ApiOperation({
    summary: 'Parámetros de la agrupación de la distribuidora',
    description:
      'Los valores vigentes con el rango y el valor por omisión de cada uno. Los mismos de `GET /module-config/route_batching`.',
  })
  @ApiOkResponse({ type: ProcessConfigResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  settings(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ProcessConfigResponseDto> {
    return this.service.parametrosVigentes(distributorId);
  }

  @Permiso('despacho.gestionar')
  @Patch('settings')
  @ApiOperation({
    summary: 'Cambiar parámetros de la agrupación',
    description:
      'Cambia sólo los que vienen; el resto conserva su valor. Rige desde la próxima pasada del proceso; las ofertas ya hechas conservan su vigencia.',
  })
  @ApiOkResponse({ type: ProcessConfigResponseDto })
  @ApiBadRequestResponse({ description: 'Valor fuera de rango' })
  settingsPatch(
    @Body() dto: PatchRouteBatchSettingsDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<ProcessConfigResponseDto> {
    return this.service.cambiarParametros(distributorId, { ...dto }, userId);
  }

  @Permiso('despacho.gestionar')
  @Post('run')
  @Idempotent({ sinCuerpo: true })
  @ApiOperation({
    summary: 'Armar lotes ahora',
    description:
      'Hace lo mismo que la pasada periódica, para esta distribuidora y sin esperar la frecuencia. Es idempotente: un pedido que ya está en un lote vivo no entra en otro. Con el módulo apagado (`enabled: 0`, el valor por omisión) responde 409.',
  })
  @ApiCreatedResponse({ type: RouteBatchRunResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  @ApiConflictResponse({
    description:
      'La agrupación por recorrido está apagada para la distribuidora, o ya se están armando los lotes de esta distribuidora (cerrojo tomado): reintentar en un momento',
  })
  run(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteBatchRunResponseDto> {
    return this.service.armarAhora(distributorId);
  }

  @Permiso('despacho.gestionar')
  @Get(':id')
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiOperation({ summary: 'Un lote de recorrido con sus paradas y ofertas' })
  @ApiParam({ name: 'id', description: 'Batch UUID' })
  @ApiOkResponse({ type: RouteBatchResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  uno(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteBatchResponseDto> {
    return this.query.detalle(distributorId, id);
  }

  @Permiso('despacho.gestionar')
  @Post(':id/dissolve')
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @Idempotent({ sinCuerpo: true })
  @ApiOperation({
    summary: 'Deshacer un lote',
    description:
      'Cierra la oferta vigente, saca las paradas y devuelve los pedidos al despacho individual. Sólo un lote que todavía no tiene chofer (`forming` u `offered`).',
  })
  @ApiParam({ name: 'id', description: 'Batch UUID' })
  @ApiCreatedResponse({ type: RouteBatchResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description: 'El lote ya tiene chofer o está cerrado',
  })
  async deshacer(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteBatchResponseDto> {
    await this.service.deshacerPorAdmin(distributorId, id);
    return this.query.detalle(distributorId, id);
  }
}
