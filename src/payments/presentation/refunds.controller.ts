import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
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
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { RefundsService } from '../application/refunds.service';
import { QueryRefundsDto } from '../dto/query-refunds.dto';
import {
  RefundListResponseDto,
  RefundResponseDto,
} from '../dto/refund-response.dto';
import { RefundMapper } from '../refund.mapper';
import { Permiso } from '../../common/decorators/permiso.decorator';

const FALTA_DISTRIBUIDORA =
  'Super admin sin X-Distributor ("Falta la distribuidora: enviá el header X-Distributor (slug o id)")';

/**
 * Devoluciones de pagos a la pasarela (CU-168). El alta es automática (la
 * cancelación y el pase de un pedido express al reparto común); acá el
 * administrador las consulta y reintenta las que fallaron.
 */
@ApiTags('Pagos · Reintegros')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller()
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Permiso('reintegros.gestionar')
  @Get('refunds')
  @ApiOperation({
    summary: 'Listar las devoluciones de la distribuidora',
    description:
      'Más nuevas primero. Con `status=failed` son las que esperan un reintento del administrador.',
  })
  @ApiOkResponse({ type: RefundListResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  async listar(
    @Query() query: QueryRefundsDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RefundListResponseDto> {
    const limit = query.limit ?? 10;
    const offset = query.offset ?? 0;
    const { items, total } = await this.refunds.listar(distributorId, {
      status: query.status,
      limit,
      offset,
    });
    return {
      items: items.map((r) => RefundMapper.toDto(r)),
      total,
      limit,
      offset,
    };
  }

  @Permiso('reintegros.gestionar')
  @Get('orders/:id/refunds')
  @ApiOperation({ summary: 'Devoluciones de un pedido' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: [RefundResponseDto] })
  @ApiNotFoundResponse({
    description: 'El pedido no existe o es de otra distribuidora',
  })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  async delPedido(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RefundResponseDto[]> {
    const filas = await this.refunds.listarDelPedido(id, distributorId);
    return filas.map((r) => RefundMapper.toDto(r));
  }

  @Permiso('reintegros.gestionar')
  @Post('orders/:id/refunds/retry')
  @Idempotent()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reintentar la devolución de un pedido',
    description:
      'Vuelve a pedir a la pasarela las devoluciones que fallaron (y crea la del pedido cancelado si nunca se pidió). La clave de idempotencia de cada devolución viaja a la pasarela: repetir no devuelve el dinero dos veces. Una devolución que sigue fallando queda `failed` con su error (la respuesta es 200 igual). Si la pasarela informa que el pago ya estaba devuelto, se marca como reintegrada sin repetir la solicitud.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: [RefundResponseDto] })
  @ApiNotFoundResponse({
    description: 'El pedido no existe o es de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'El pedido no está cancelado ni tiene pendiente la devolución del recargo express',
  })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  async reintentar(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RefundResponseDto[]> {
    const filas = await this.refunds.reintentar(
      id,
      distributorId,
      user.user_id,
    );
    return filas.map((r) => RefundMapper.toDto(r));
  }
}
