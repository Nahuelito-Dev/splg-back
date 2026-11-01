import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CustomerPurchaseStatsService } from './application/customer-purchase-stats.service';
import { CustomerPurchaseStatsDto } from './dto/customer-purchase-stats.dto';

/** Estadísticas de compra de un cliente para la ficha del panel (API v2). */
@ApiTags('Pedidos · Estadísticas del cliente (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'orders/customer', version: '2' })
export class CustomerPurchaseStatsController {
  constructor(private readonly estadisticas: CustomerPurchaseStatsService) {}

  @Get(':customerId/stats')
  @ApiOperation({
    summary: 'Lo que un cliente le compró a la distribuidora',
    description:
      'Total comprado (pedidos entregados), cantidad de pedidos, ticket promedio y último pedido entregado, calculados en la base sobre todos los pedidos del cliente en la distribuidora del contexto (`X-Distributor`). Un cliente sin pedidos en esa distribuidora devuelve ceros y `null`.',
  })
  @ApiParam({
    name: 'customerId',
    description:
      'Usuario del cliente (`user_id`), como en `GET /orders/customer/:customerId`',
  })
  @ApiOkResponse({ type: CustomerPurchaseStatsDto })
  @ApiBadRequestResponse({
    description: 'Falta la distribuidora en el contexto o el id no es un UUID',
  })
  porCliente(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @CurrentDistributor({ required: 'staff' }) distributorId: string,
  ): Promise<CustomerPurchaseStatsDto> {
    return this.estadisticas.estadisticas(customerId, distributorId);
  }
}
