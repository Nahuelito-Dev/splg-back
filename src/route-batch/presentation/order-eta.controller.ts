import { Controller, Get, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RouteSheetExecutionQueryService } from '../application/route-sheet-execution-query.service';
import { OrderEtaDto } from './dto/route-sheet-execution.dto';

/**
 * La hora estimada de su pedido para el cliente (F34 E5, §9.3): la franja
 * «llega entre… y…» de un pedido que va en una hoja de ruta confirmada o en
 * curso. En vivo llega por el socket (`order:eta-updated`) y por push cuando
 * se corre. Endpoint nuevo: el DTO del pedido (v1) no cambia.
 */
@ApiTags('Orders · ETA (v2)')
@Auth(RoleType.CUSTOMER)
@Controller({ path: 'orders', version: '2' })
export class OrderEtaController {
  constructor(private readonly query: RouteSheetExecutionQueryService) {}

  @Get(':id/eta')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Hora estimada de mi pedido',
    description:
      'Franja estimada (`windowStart`–`windowEnd`, dentro de la franja comprada salvo que ya se haya corrido) y la hora puntual. No expone la hoja, el orden de las paradas, otros clientes ni la posición del chofer. 204 si el pedido no va en una hoja (o ya se entregó o canceló).',
  })
  @ApiOkResponse({ type: OrderEtaDto })
  @ApiNoContentResponse({
    description: 'El pedido no va en una hoja de ruta: no hay hora estimada',
  })
  @ApiBadRequestResponse({ description: 'Id que no es UUID' })
  @ApiNotFoundResponse({
    description: 'El pedido no existe o es de otro cliente (ORDER_NOT_FOUND)',
  })
  async eta(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('user_id') userId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderEtaDto | undefined> {
    const eta = await this.query.etaDelPedido(userId, id);
    if (!eta) {
      res.status(204);
      return undefined;
    }
    return eta;
  }
}
