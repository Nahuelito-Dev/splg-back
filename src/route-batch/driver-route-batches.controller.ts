import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { PaginationDto } from '../common/dtos/pagination.dto';
import {
  DriverRouteBatchDecisionDto,
  DriverRouteBatchPageDto,
  DriverRouteBatchResponseDto,
} from './dto/route-batch-response.dto';
import { RouteBatchQueryService } from './route-batch-query.service';
import { RouteBatchService } from './route-batch.service';

/**
 * Recorridos agrupados que el sistema le ofrece al chofer (CU-107). La oferta
 * llega por el socket `route-batch:offer` y por push; la respuesta es aceptar
 * (se le asignan todos los pedidos, en el orden del recorrido) o rechazar (el
 * lote pasa al siguiente chofer). Todo es del chofer autenticado: el lote de
 * otro es un 404.
 */
@ApiTags('Driver · Route batches (v2)')
@Auth(RoleType.DELIVERY)
@Controller({ path: 'driver/route-batches', version: '2' })
export class DriverRouteBatchesController {
  constructor(
    private readonly service: RouteBatchService,
    private readonly query: RouteBatchQueryService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Mis lotes de recorrido',
    description:
      'Primero el que espera mi respuesta (`offer.status: pending`, con su `offer.expiresAt`) y después los que tomé o rechacé, del más reciente al más viejo. Cada lote trae las paradas en orden de entrega, con dirección, franja, llegada estimada, kilos y renglones, y el peso total.',
  })
  @ApiOkResponse({ type: DriverRouteBatchPageDto })
  list(
    @Query() query: PaginationDto,
    @CurrentUser('user_id') userId: string,
  ): Promise<DriverRouteBatchPageDto> {
    return this.query.delChofer(userId, query.limit ?? 10, query.offset ?? 0);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Uno de mis lotes de recorrido' })
  @ApiParam({ name: 'id', description: 'Batch UUID' })
  @ApiOkResponse({ type: DriverRouteBatchResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o nunca se me ofreció' })
  one(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<DriverRouteBatchResponseDto> {
    return this.query.unoDelChofer(userId, id);
  }

  @Post(':id/accept')
  @Idempotent()
  @ApiOperation({
    summary: 'Aceptar el recorrido',
    description:
      'Asigna al chofer todos los pedidos del lote, en el orden de las paradas, por el mismo camino que una asignación individual. Un pedido que se canceló o se asignó aparte mientras tanto sale del lote y no frena a los demás. Repetir la aceptación de un lote ya aceptado devuelve el mismo resultado.',
  })
  @ApiParam({ name: 'id', description: 'Batch UUID' })
  @ApiCreatedResponse({ type: DriverRouteBatchDecisionDto })
  @ApiNotFoundResponse({
    description: 'El lote no existe o es de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'La oferta no está vigente (venció o la tiene otro chofer) o los pedidos ya no están disponibles',
  })
  accept(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<DriverRouteBatchDecisionDto> {
    return this.service.aceptar(userId, id);
  }

  @Post(':id/reject')
  @Idempotent()
  @ApiOperation({
    summary: 'Rechazar el recorrido',
    description:
      'Cierra mi oferta y el lote pasa de inmediato al siguiente chofer cercano que no haya sido contactado. Si no queda ninguno, el lote se deshace y los pedidos vuelven al despacho individual.',
  })
  @ApiParam({ name: 'id', description: 'Batch UUID' })
  @ApiCreatedResponse({ type: DriverRouteBatchDecisionDto })
  @ApiNotFoundResponse({
    description: 'El lote no existe o es de otra distribuidora',
  })
  @ApiConflictResponse({ description: 'La oferta no está vigente' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<DriverRouteBatchDecisionDto> {
    return this.service.rechazar(userId, id);
  }
}
