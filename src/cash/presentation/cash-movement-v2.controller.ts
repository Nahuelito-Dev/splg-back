import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CashMovementService } from '../application/cash-movement.service';
import { CashMapper } from '../cash.mapper';
import {
  CashMovementV2PageDto,
  QueryCashMovementV2Dto,
} from '../dto/cash-movement.dto';

/** El libro de movimientos con el pedido del que nace cada cobro de venta (API v2; el resto sigue en `/cash-movements` v1). */
@ApiTags('Finanzas · Movimientos de caja (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'cash-movements', version: '2' })
export class CashMovementV2Controller {
  constructor(private readonly movimientos: CashMovementService) {}

  @Get()
  @ApiOperation({
    summary: 'Consultar los movimientos de caja, con su pedido',
    description:
      'Igual que la v1 (mismos filtros, del más nuevo al más viejo) y cada movimiento suma `orderId`: el pedido del que nace un cobro de venta. `createdByUserId` es null en los movimientos que se asientan solos.',
  })
  @ApiOkResponse({ type: CashMovementV2PageDto })
  @ApiBadRequestResponse({ description: 'Período o filtro inválido' })
  @ApiNotFoundResponse({
    description: 'La caja no existe o es de otra distribuidora',
  })
  async findAll(
    @Query() query: QueryCashMovementV2Dto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CashMovementV2PageDto> {
    const { data, total } = await this.movimientos.consultar(
      distributorId,
      query,
    );
    return {
      data: data.map((m) => CashMapper.movimientoV2(m.movimiento, m)),
      total,
    };
  }
}
